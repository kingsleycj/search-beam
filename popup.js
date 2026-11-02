// SPDX-License-Identifier: GPL-2.0-or-later
//
// The search popup. Rather than building a second search UI, it borrows the
// Overview's own search entry and results (so every search provider that GNOME
// or other extensions register shows up here) and hands them back when it
// closes. Same idea as Search Light by icedman, rewritten for GNOME 50.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

// Base size in logical pixels; scale-width/scale-height add a fraction of half
// the monitor on top (same formula Search Light used, so old values carry over).
const BASE_WIDTH = 600;
const BASE_HEIGHT = 400;
const START_SCALE = 0.9;

// A click on the panel icon while the popup is open first closes it (the
// search controller's click-outside handling), then reaches the icon. Ignore
// a re-open that lands this soon after a close.
const REOPEN_GUARD_US = 250 * 1000;

const STYLE_KEYS = [
    'background-color', 'text-color', 'border-color', 'border-thickness',
    'border-radius', 'font-size', 'entry-font-size',
];
const LAYOUT_KEYS = ['scale-width', 'scale-height'];
const BLUR_KEYS = ['blur-background', 'blur-sigma', 'blur-brightness'];

const MASK_DECLARATIONS = `
uniform float radius;
uniform vec2 size;
`;

// Fades out the pixels outside a rounded rectangle, so the blurred wallpaper
// follows the popup's corner radius.
const MASK_CODE = `
if (radius > 0.0) {
    vec2 p = cogl_tex_coord_in[0].xy * size;
    vec2 q = min(p, size - p);
    if (q.x < radius && q.y < radius) {
        float d = length(vec2(radius) - q);
        cogl_color_out *= clamp(radius - d + 0.5, 0.0, 1.0);
    }
}
`;

const RoundedMaskEffect = GObject.registerClass(
class SearchBeamRoundedMaskEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._radiusLocation = this.get_uniform_location('radius');
        this._sizeLocation = this.get_uniform_location('size');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            MASK_DECLARATIONS, MASK_CODE, false);
    }

    setGeometry(radius, width, height) {
        this.set_uniform_float(this._radiusLocation, 1, [radius]);
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
        this.queue_repaint();
    }
});

function cssColor([r, g, b, a]) {
    const c = v => Math.round(Math.min(Math.max(v, 0), 1) * 255);
    return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.min(Math.max(a, 0), 1).toFixed(3)})`;
}

export class SearchBeamPopup {
    constructor(settings, stylesheetPath) {
        this._settings = settings;
        this._stylesheetPath = stylesheetPath;

        this._visible = false; // open, or opening
        this._acquired = false; // holding the Overview's entry and results
        this._lastHideTime = 0;
        this._monitor = null;
        this._geometry = null;
        this._prevFocusWindow = null;
        this._unredirectDisabled = false;

        this.actor = new St.Widget({
            name: 'searchBeam',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            visible: false,
        });
        this.actor.set_pivot_point(0.5, 0.5);

        this._blurBox = new St.Widget({
            name: 'searchBeamBlur',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            visible: false,
        });
        this.actor.add_child(this._blurBox);

        this._box = new St.BoxLayout({
            name: 'searchBeamBox',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        this.actor.add_child(this._box);

        // Escape closes the popup from anywhere inside it. Capture phase, so it
        // runs before the search entry's own Escape handling.
        this.actor.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this.hide({restoreFocus: true});
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('key-press-event', (actor, event) =>
            this._onKeyPress(event));

        // GNOME 50 dropped the affectsInputRegion option (Wayland-only now).
        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._settings.connectObject('changed', (s, key) =>
            this._onSettingChanged(key), this);

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        themeContext.connectObject('changed', () => {
            // Loading a stylesheet also emits 'changed', so only react when
            // the theme itself was replaced (that drops our stylesheet).
            if (themeContext.get_theme() === this._theme)
                return;
            this._appliedCss = null;
            this._updateStyle();
        }, this);

        // If the Overview opens while we're still fading out, give its
        // search back straight away.
        Main.overview.connectObject('showing', () => this._finishHide(), this);

        this._updateStyle();
    }

    destroy() {
        this.hide({animate: false});
        this._finishHide(); // in case a fade-out was still running
        this._destroyBlur();

        this._settings.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.overview.disconnectObject(this);

        if (this._cssFile) {
            St.ThemeContext.get_for_stage(global.stage).get_theme()
                .unload_stylesheet(this._cssFile);
            try {
                this._cssFile.delete(null);
            } catch {
                // already gone
            }
            this._cssFile = null;
        }

        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
        this._settings = null;
    }

    get visible() {
        return this._visible;
    }

    toggle() {
        if (this._visible)
            this.hide({restoreFocus: true});
        else
            this.show();
    }

    show() {
        if (this._visible || Main.overview.visible || Main.overview.isDummy)
            return;
        if (GLib.get_monotonic_time() - this._lastHideTime < REOPEN_GUARD_US)
            return;

        // Set before anything that can fire a pending hide's onComplete.
        this._visible = true;
        this.actor.remove_all_transitions();

        this._prevFocusWindow = global.display.focus_window;
        this._monitor = this._pickMonitor();

        this._acquire();
        this._updateStyle();
        this._syncBlur();
        this._layout();

        if (!this._unredirectDisabled) {
            global.compositor.disable_unredirect();
            this._unredirectDisabled = true;
        }

        this.actor.show();
        if (this._animate()) {
            this.actor.set({opacity: 0, scale_x: START_SCALE, scale_y: START_SCALE});
            this.actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: this._settings.get_double('animation-speed'),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.actor.set({opacity: 255, scale_x: 1, scale_y: 1});
        }

        // Take keyboard focus away from the focused window, the same way
        // Ctrl+Alt+Tab focuses shell UI, then put it in the search box.
        global.display.unset_input_focus(global.get_current_time());
        this._entry.grab_key_focus();

        this._connectWhileOpen();

        // Measure the search box again once it has been styled and shown
        // (a new font size only settles after the first frame).
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._relayoutId = 0;
            if (this._visible)
                this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    hide({restoreFocus = false, animate = true} = {}) {
        if (!this._visible)
            return;

        this._visible = false;
        this._lastHideTime = GLib.get_monotonic_time();
        this._disconnectWhileOpen();
        if (this._relayoutId) {
            GLib.source_remove(this._relayoutId);
            this._relayoutId = 0;
        }

        const prevWindow = this._prevFocusWindow;
        this._prevFocusWindow = null;
        if (restoreFocus && prevWindow && !global.display.focus_window &&
            prevWindow.get_compositor_private())
            prevWindow.focus(global.get_current_time());

        // Never leave the Overview without its search box.
        if (!animate || !this._animate() || Main.overview.visible) {
            this._finishHide();
            return;
        }

        this.actor.ease({
            opacity: 0,
            scale_x: START_SCALE,
            scale_y: START_SCALE,
            duration: this._settings.get_double('animation-speed'),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._visible)
                    this._finishHide();
            },
        });
    }

    _finishHide() {
        if (this._visible)
            return;

        this.actor.remove_all_transitions();
        this.actor.hide();
        this._release();

        if (this._unredirectDisabled) {
            global.compositor.enable_unredirect();
            this._unredirectDisabled = false;
        }
    }

    _animate() {
        return this._settings.get_boolean('use-animations') &&
            this._settings.get_double('animation-speed') > 0;
    }

    // --- borrowing the Overview's search -------------------------------

    _acquire() {
        if (this._acquired)
            return;

        const entry = Main.overview.searchEntry;
        const controller = Main.overview.searchController;

        this._entry = entry;
        this._controller = controller;
        this._entryParent = entry.get_parent();
        this._controllerParent = controller.get_parent();
        this._controllerIndex = this._controllerParent
            ? this._controllerParent.get_children().indexOf(controller)
            : -1;

        this._detach(entry);
        this._detach(controller);
        this._box.add_child(entry);
        this._box.add_child(controller);
        entry.add_style_class_name('search-beam-entry');

        controller.connectObject('notify::search-active',
            () => this._onSearchActiveChanged(), this);

        // Activating a result calls Main.overview.toggle() (which would open
        // the Overview) or Main.overview.hide() (app results). While we hold
        // the search, both mean "the user picked something: close the popup".
        this._overviewOverrides = ['toggle', 'hide'].map(name => {
            const overview = Main.overview;
            const original = overview[name];
            const hadOwn = Object.prototype.hasOwnProperty.call(overview, name);
            overview[name] = (...args) => {
                if (this._visible)
                    this.hide();
                else
                    original.apply(overview, args);
            };
            return {name, original, hadOwn};
        });

        this._acquired = true;
    }

    _release() {
        if (!this._acquired)
            return;

        for (const {name, original, hadOwn} of this._overviewOverrides) {
            if (hadOwn)
                Main.overview[name] = original;
            else
                delete Main.overview[name];
        }
        this._overviewOverrides = null;

        const entry = this._entry;
        const controller = this._controller;

        controller.disconnectObject(this);
        entry.remove_style_class_name('search-beam-entry');

        // Removing the controller unmaps it, which clears the search text.
        this._box.remove_child(controller);
        this._box.remove_child(entry);

        if (this._entryParent instanceof St.Bin)
            this._entryParent.set_child(entry);
        else
            this._entryParent?.add_child(entry);

        if (this._controllerParent) {
            if (this._controllerIndex >= 0)
                this._controllerParent.insert_child_at_index(controller, this._controllerIndex);
            else
                this._controllerParent.add_child(controller);
        }

        this._entry = null;
        this._controller = null;
        this._entryParent = null;
        this._controllerParent = null;
        this._acquired = false;
    }

    _detach(actor) {
        const parent = actor.get_parent();
        if (!parent)
            return;
        if (parent instanceof St.Bin && parent.child === actor)
            parent.set_child(null);
        else
            parent.remove_child(actor);
    }

    _onSearchActiveChanged() {
        // The Overview fades its results out over 200ms. We shrink back to
        // the bare search box at once, so drop them immediately instead.
        if (!this._controller.searchActive)
            this._controller.hide();
        this._layout();
    }

    // --- open-state signals -----------------------------------------------

    _connectWhileOpen() {
        global.stage.connectObject(
            'notify::key-focus', () => this._onKeyFocusChanged(),
            'captured-event', (stage, event) => this._onStageCapturedEvent(event),
            this);
        global.display.connectObject(
            'notify::focus-window', () => {
                // A window took focus (clicked, launched, alt-tabbed to).
                if (global.display.focus_window)
                    this.hide();
            },
            'in-fullscreen-changed', () => this.hide(),
            this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this.hide({animate: false}), this);
    }

    _disconnectWhileOpen() {
        global.stage.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
    }

    _onKeyFocusChanged() {
        const focus = global.stage.get_key_focus();
        if (focus && (this.actor.contains(focus) || this._isOurMenu(focus)))
            return;
        this.hide();
    }

    // A click anywhere outside the popup closes it, even on bare desktop
    // where nothing takes focus. The click still goes through.
    _onStageCapturedEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        const target = global.stage.get_event_actor(event);
        if (target && (this.actor.contains(target) || this._isOurMenu(target)))
            return Clutter.EVENT_PROPAGATE;

        this.hide();
        return Clutter.EVENT_PROPAGATE;
    }

    // Right-click menus opened from inside the popup (app results, the
    // search box) take key focus; keep the popup open behind them.
    _isOurMenu(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            const source = a._delegate?.sourceActor;
            if (source && this.actor.contains(source))
                return true;
        }
        return false;
    }

    _onKeyPress(event) {
        if (!this._acquired)
            return Clutter.EVENT_PROPAGATE;

        // Typing while a result has focus goes back to the search box.
        const focus = global.stage.get_key_focus();
        if (!this._entry.contains(focus) &&
            this._controller._shouldTriggerSearch?.(event.get_key_symbol())) {
            this._controller.startSearch(event);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // --- geometry -------------------------------------------------------

    _pickMonitor() {
        const {monitors, primaryMonitor} = Main.layoutManager;

        if (this._settings.get_boolean('popup-at-cursor-monitor')) {
            const [px, py] = global.get_pointer();
            const under = monitors.find(m =>
                px >= m.x && px < m.x + m.width &&
                py >= m.y && py < m.y + m.height);
            if (under)
                return under;
        }

        const preferred = this._settings.get_int('preferred-monitor');
        return (preferred > 0 && monitors[preferred - 1]) || primaryMonitor;
    }

    _layout() {
        if (!this._acquired || !this._monitor)
            return;

        const monitor = this._monitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const sw = this._settings.get_double('scale-width');
        const sh = this._settings.get_double('scale-height');

        const width = Math.min(monitor.width,
            Math.round((BASE_WIDTH + (monitor.width / scale / 2) * sw) * scale));
        const fullHeight = Math.min(monitor.height,
            Math.round((BASE_HEIGHT + (monitor.height / scale / 2) * sh) * scale));

        // Centre the full-size popup; the bare search box sits at its top.
        const x = monitor.x + Math.round((monitor.width - width) / 2);
        const y = monitor.y + Math.round((monitor.height - fullHeight) / 2);

        const height = this._controller.searchActive
            ? fullHeight
            : Math.min(fullHeight, this._compactHeight(width));

        this.actor.set_position(x, y);
        this.actor.set_size(width, height);
        this._geometry = {x, y, width, height};
        this._layoutBlur();
    }

    _compactHeight(width) {
        this._box.ensure_style();
        this._entry.ensure_style();
        const node = this._box.get_theme_node();
        const [, entryHeight] = this._entry.get_preferred_height(width);
        return Math.ceil(entryHeight +
            node.get_vertical_padding() +
            node.get_border_width(St.Side.TOP) +
            node.get_border_width(St.Side.BOTTOM));
    }

    // --- blurred wallpaper ------------------------------------------------

    _syncBlur() {
        const enabled = this._settings.get_boolean('blur-background');
        const monitorIndex = this._monitor?.index ?? Main.layoutManager.primaryIndex;

        if (!enabled || this._blurMonitorIndex !== monitorIndex)
            this._destroyBlur();
        if (!enabled)
            return;

        if (!this._bgManager) {
            this._bgContainer = new Clutter.Actor();
            this._blurBox.add_child(this._bgContainer);
            this._bgManager = new Background.BackgroundManager({
                container: this._bgContainer,
                monitorIndex,
                vignette: false,
                controlPosition: true,
            });
            this._blurEffect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR});
            this._bgContainer.add_effect_with_name('blur', this._blurEffect);
            this._maskEffect = new RoundedMaskEffect();
            this._blurBox.add_effect_with_name('mask', this._maskEffect);
            this._blurMonitorIndex = monitorIndex;
        }

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._blurEffect.radius = this._settings.get_double('blur-sigma') * scale;
        this._blurEffect.brightness = this._settings.get_double('blur-brightness');
        this._blurBox.show();
        this._layoutBlur();
    }

    _layoutBlur() {
        if (!this._bgManager || !this._geometry)
            return;
        const {x, y, width, height} = this._geometry;
        // The wallpaper actor sits at monitor coordinates inside the
        // container; shift the container so the visible slice lines up.
        this._bgContainer.set_position(-x, -y);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._maskEffect.setGeometry(
            this._settings.get_int('border-radius') * scale, width, height);
    }

    _destroyBlur() {
        if (!this._bgManager)
            return;
        this._blurBox.remove_effect_by_name('mask');
        this._bgManager.destroy();
        this._bgContainer.destroy();
        this._bgManager = null;
        this._bgContainer = null;
        this._blurEffect = null;
        this._maskEffect = null;
        this._blurMonitorIndex = undefined;
        this._blurBox.hide();
    }

    // --- styling ----------------------------------------------------------

    _onSettingChanged(key) {
        if (STYLE_KEYS.includes(key))
            this._updateStyle();
        if (BLUR_KEYS.includes(key) && this._visible)
            this._syncBlur();
        if ((STYLE_KEYS.includes(key) || LAYOUT_KEYS.includes(key)) && this._visible)
            this._layout();
    }

    _color(key) {
        return this._settings.get_value(key).deepUnpack();
    }

    _updateStyle() {
        const bg = this._color('background-color');
        const text = this._color('text-color');
        const border = this._color('border-color');
        const thickness = this._settings.get_int('border-thickness');
        const radius = this._settings.get_int('border-radius');
        const fontSize = this._settings.get_int('font-size');
        const entryFontSize = this._settings.get_int('entry-font-size');

        // Automatic text colour: dark text on light backgrounds.
        const autoText = text[3] <= 0;
        const lightBg = 0.3 * bg[0] + 0.59 * bg[1] + 0.11 * bg[2] >= 0.5;
        if (autoText && lightBg)
            this._box.add_style_class_name('light');
        else
            this._box.remove_style_class_name('light');

        const box = [
            `background-color: ${cssColor(bg)};`,
            `border-radius: ${radius}px;`,
        ];
        if (thickness > 0)
            box.push(`border: ${thickness}px solid ${cssColor(border)};`);

        const css = [`#searchBeamBox { ${box.join(' ')} }`];
        css.push(`#searchBeamBox .search-section-content { border-radius: ${Math.max(radius - 4, 0)}px; }`);

        if (fontSize > 0)
            css.push(`#searchBeamBox * { font-size: ${fontSize}pt; }`);
        if (entryFontSize > 0) {
            css.push(`#searchBeamBox .search-beam-entry, #searchBeamBox .search-beam-entry * { font-size: ${entryFontSize}pt; }`);
        }
        if (!autoText)
            css.push(`#searchBeamBox, #searchBeamBox * { color: ${cssColor(text)} !important; }`);

        this._loadStylesheet(css.join('\n'));
    }

    _loadStylesheet(css) {
        if (css === this._appliedCss)
            return;

        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._theme = theme;
        if (this._cssFile)
            theme.unload_stylesheet(this._cssFile);
        else
            this._cssFile = Gio.File.new_for_path(this._stylesheetPath);

        try {
            this._cssFile.replace_contents(new TextEncoder().encode(css), null,
                false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._appliedCss = css;
            theme.load_stylesheet(this._cssFile);
        } catch (e) {
            console.error(`Search Beam: could not apply styles: ${e.message}`);
        }
    }
}
