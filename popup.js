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

import {AnswerService, isExpectedError, planLookup} from './answers.js';
import {AnswerCard, AnswerReader} from './answerView.js';
import {describeFile, loadScaledImage} from './previewInfo.js';
import {PreviewPane, PREVIEW_IMAGE_SIZE} from './previewView.js';

// Base size in logical pixels; scale-width/scale-height add a fraction of half
// the monitor on top. At 100% display scaling this matches Search Light's
// formula, so imported values give the same size.
const BASE_WIDTH = 600;
const BASE_HEIGHT = 400;
const START_SCALE = 0.9;

const STYLE_KEYS = [
    'background-color', 'text-color', 'border-color', 'border-thickness',
    'border-radius', 'font-size', 'entry-font-size',
];
const LAYOUT_KEYS = ['scale-width', 'scale-height', 'show-preview'];
const ANSWER_KEYS = ['answers-enabled', 'answers-language'];

// Wait for a pause in typing before looking anything up online.
const LOOKUP_DELAY_MS = 400;

// The preview panel takes this share of the popup's width, and only appears
// when the popup is wide enough for results and preview side by side.
const PREVIEW_SHARE = 0.38;
const MIN_PREVIEW_WIDTH = 640;
// GNOME announces no change of the highlighted top result (results arrive
// asynchronously), so the panel checks for one this often while open.
const PREVIEW_POLL_MS = 250;
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

// Replace obj[name] with fn; returns a record for restoreOverrides().
function override(obj, name, fn) {
    const record = {
        obj,
        name,
        original: obj[name],
        hadOwn: Object.prototype.hasOwnProperty.call(obj, name),
    };
    obj[name] = fn;
    return record;
}

function restoreOverrides(records) {
    for (const {obj, name, original, hadOwn} of records.reverse()) {
        if (hadOwn)
            obj[name] = original;
        else
            delete obj[name];
    }
}

export class SearchBeamPopup {
    constructor(settings) {
        this._settings = settings;

        this._visible = false; // open, or opening
        this._acquired = false; // holding the Overview's entry and results
        this._monitor = null;
        this._geometry = null;
        this._prevFocusWindow = null;
        this._unredirectDisabled = false;
        this._toggleSources = new Set();
        this._relayoutId = 0;
        this._restoreFocusId = 0;

        this.actor = new St.Widget({
            name: 'searchBeam',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            visible: false,
        });
        this.actor.set_pivot_point(0.5, 0.5);

        this._blurBox = new St.Widget({
            name: 'searchBeamBlur',
            layout_manager: new Clutter.BinLayout(),
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

        // Online answers: the card sits between the search box and the
        // results, the reader replaces the results while open. The borrowed
        // entry and results are slotted around them in _acquire().
        this._answers = new AnswerService();
        this._lookupId = 0;
        this._holdSearch = false;
        this._card = new AnswerCard();
        this._card.connect('activate', () => this._openReader());
        this._box.add_child(this._card);

        // GNOME's results and the preview panel, side by side.
        this._resultsRow = new St.BoxLayout({
            style_class: 'search-beam-results-row',
            x_expand: true,
            y_expand: true,
        });
        this._preview = new PreviewPane();
        this._resultsRow.add_child(this._preview);
        this._box.add_child(this._resultsRow);
        this._previewAllowed = false;
        this._previewPollId = 0;
        this._previewCancellable = null;
        this._hoverResult = null;
        this._previewedResult = null;
        this._topResult = null;
        this._trackOwners = {_hoverResult: {}, _previewedResult: {}, _topResult: {}};
        this._disposed = new WeakSet();
        this._cardKey = null;
        this._reader = new AnswerReader();
        this._reader.connect('back', () => this._closeReader());
        this._reader.connect('open-url', (reader, url) => this._openUrl(url));
        this._reader.connect('copy', (reader, text) =>
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text));
        this._box.add_child(this._reader);

        // Keys handled in the capture phase, before the search entry sees
        // them. Escape closes the reader, or else the popup (except while an
        // input method is composing: Escape then cancels the composition).
        this.actor.connect('captured-event', (actor, event) =>
            this._onCapturedKey(event));
        this.actor.connect('key-press-event', (actor, event) =>
            this._onKeyPress(event));

        // GNOME 50 dropped the affectsInputRegion option (Wayland-only now).
        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._settings.connectObject('changed', (s, key) =>
            this._onSettingChanged(key), this);

        // The Overview is about to use its search box: give it back now, even
        // if we're open or still fading out.
        Main.overview.connectObject('showing', () => {
            this.hide({animate: false, restoreFocus: false});
            this._finishHide();
        }, this);

        this._updateStyle();
    }

    destroy() {
        this.hide({animate: false, restoreFocus: false});
        this._finishHide(); // in case a fade-out was still running
        this._destroyBlur();
        if (this._restoreFocusId) {
            GLib.source_remove(this._restoreFocusId);
            this._restoreFocusId = 0;
        }
        if (this._relayoutId) {
            GLib.source_remove(this._relayoutId);
            this._relayoutId = 0;
        }
        if (this._lookupId) {
            GLib.source_remove(this._lookupId);
            this._lookupId = 0;
        }
        if (this._previewPollId) {
            GLib.source_remove(this._previewPollId);
            this._previewPollId = 0;
        }
        this._resetAnswers();
        this._answers.destroy();
        this._answers = null;

        this._settings.disconnectObject(this);
        Main.overview.disconnectObject(this);

        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
        this._settings = null;
    }

    // Actors (like the top-bar button) that toggle the popup themselves.
    // Pressing them must not count as a click outside, or the press would
    // close the popup and the release would open it again.
    addToggleSource(actor) {
        this._toggleSources.add(actor);
    }

    removeToggleSource(actor) {
        this._toggleSources.delete(actor);
    }

    toggle() {
        if (this._visible)
            this.hide();
        else
            this.show();
    }

    show() {
        if (this._visible || Main.overview.visible || Main.overview.isDummy)
            return;

        // Set before anything that can fire a pending hide's onComplete.
        this._visible = true;
        this.actor.remove_all_transitions();
        if (this._restoreFocusId) {
            GLib.source_remove(this._restoreFocusId);
            this._restoreFocusId = 0;
        }

        this._prevFocusWindow = global.display.focus_window;
        this._monitor = this._pickMonitor();

        this._acquire();
        // A reader left open when the popup last closed: start on results.
        this._reader.hide();
        this._resultsRow.show();
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
        this._updatePreviewPoll();

        // Measure the search box again once it has been styled and shown
        // (a new font size only settles after the first frame).
        if (this._relayoutId)
            GLib.source_remove(this._relayoutId);
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._relayoutId = 0;
            if (this._visible)
                this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    // restoreFocus: give keyboard focus back to the window that had it before
    // the popup opened, unless something else (a clicked window, a menu, a
    // switcher) has taken focus by then. Activating a result passes false:
    // the app being launched should get focus, and focusing the old window
    // now would make GNOME's focus-stealing prevention hold the new one back.
    hide({restoreFocus = true, animate = true} = {}) {
        if (!this._visible)
            return;

        this._visible = false;
        this._disconnectWhileOpen();
        if (this._relayoutId) {
            GLib.source_remove(this._relayoutId);
            this._relayoutId = 0;
        }
        // Stop pending work, but leave what's on screen for the fade-out;
        // _release() clears it once the popup is hidden.
        this._cancelAnswers();
        this._updatePreviewPoll();
        this._previewCancellable?.cancel();
        this._previewCancellable = null;

        // Stop typing into a popup that's fading out.
        const focus = global.stage.get_key_focus();
        if (focus && this.actor.contains(focus))
            global.stage.set_key_focus(null);

        const prevWindow = this._prevFocusWindow;
        this._prevFocusWindow = null;
        if (restoreFocus && prevWindow)
            this._scheduleFocusRestore(prevWindow);

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

    // Deferred so that whatever caused the close (a click on a window or the
    // top bar) has had its effect first.
    _scheduleFocusRestore(window) {
        if (this._restoreFocusId)
            GLib.source_remove(this._restoreFocusId);
        this._restoreFocusId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restoreFocusId = 0;
            const keyFocus = global.stage.get_key_focus();
            const shellHasFocus = keyFocus && keyFocus !== global.stage;
            if (!this._visible && !global.display.focus_window && !shellHasFocus &&
                window.get_compositor_private())
                window.focus(global.get_current_time());
            return GLib.SOURCE_REMOVE;
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
        // Order in the box: search entry, answer card, results row (results
        // + preview), reader.
        this._box.insert_child_at_index(entry, 0);
        this._resultsRow.insert_child_at_index(controller, 0);
        entry.add_style_class_name('search-beam-entry');

        controller.connectObject('notify::search-active',
            () => this._onSearchActiveChanged(), this);
        entry.clutter_text.connectObject('text-changed',
            () => this._onQueryChanged(), this);

        const overview = Main.overview;
        const closeOrCall = original => (...args) => {
            if (this._visible)
                this.hide({restoreFocus: !this._isResultActivation()});
            else
                original.apply(overview, args);
        };
        this._overrides = [
            // Activating a result calls Main.overview.toggle() (which would
            // open the Overview) or Main.overview.hide() (app results). While
            // we hold the search, both mean "the user picked something".
            override(overview, 'toggle', closeOrCall(overview.toggle)),
            override(overview, 'hide', closeOrCall(overview.hide)),
            // SearchController.reset() clears the text and also drops key
            // focus, which is fine inside the Overview's grab but here would
            // read as "focus left the popup". It runs on the clear icon, on a
            // whitespace-only search, on clicks around an empty search box and
            // when the controller is unmapped. Only clear the text.
            override(controller, 'reset', () => {
                if (this._holdSearch)
                    return;
                entry.text = '';
                entry.clutter_text.set_cursor_visible(true);
                entry.clutter_text.set_selection(0, 0);
            }),
        ];

        this._acquired = true;
    }

    // Did the event being handled pick a result in the popup (Enter in the
    // search box, a click on a result)? Super and the hot corner also call
    // Main.overview.toggle(), but those should give focus back.
    _isResultActivation() {
        const event = Clutter.get_current_event();
        if (!event)
            return false;

        const type = event.type();
        if ((type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE) &&
            [Clutter.KEY_Super_L, Clutter.KEY_Super_R].includes(event.get_key_symbol()))
            return false;

        const target = global.stage.get_event_actor(event);
        return !!target && this.actor.contains(target);
    }

    _release() {
        if (!this._acquired)
            return;

        const entry = this._entry;
        const controller = this._controller;

        controller.disconnectObject(this);
        entry.clutter_text.disconnectObject(this);
        entry.remove_style_class_name('search-beam-entry');
        entry.set_style(null);
        this._resetAnswers();
        this._resetPreview();

        // Taking the controller out clears the search text (via our reset
        // override, so key focus is left alone), so restore overrides after.
        this._resultsRow.remove_child(controller);
        this._box.remove_child(entry);
        entry.text = '';

        restoreOverrides(this._overrides);
        this._overrides = null;

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
        this._updatePreviewPoll();
        this._syncPreview();
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
        if (focus && (this.actor.contains(focus) || this._isOurMenu(focus))) {
            this._syncPreview();
            return;
        }
        this.hide();
    }

    // A click anywhere outside the popup closes it, even on bare desktop
    // where nothing takes focus. The click still goes through.
    _onStageCapturedEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            // Pointing at a result previews it, as in Spotlight.
            // Moving off the results goes back to the highlighted top result,
            // which is what Enter opens.
            const hovered = this._resultFor(global.stage.get_event_actor(event));
            if (hovered !== this._hoverResult) {
                this._track('_hoverResult', hovered);
                this._syncPreview();
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        const target = global.stage.get_event_actor(event);
        if (target && (this.actor.contains(target) ||
                       this._isOurMenu(target) ||
                       Main.layoutManager.keyboardBox.contains(target) ||
                       [...this._toggleSources].some(s => s.contains(target))))
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

    // --- online answers -------------------------------------------------

    _onCapturedKey(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS || !this._acquired)
            return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            if (this._entry.clutter_text.has_preedit())
                return Clutter.EVENT_PROPAGATE;
            if (this._reader.visible)
                this._closeReader();
            else
                this.hide();
            return Clutter.EVENT_STOP;
        }

        const isEnter = symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter;
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (isEnter && ctrl && this._card.visible) {
            this._openReader();
            return Clutter.EVENT_STOP;
        }

        if (this._reader.visible) {
            if (this._reader.scroll(symbol, event.get_state()))
                return Clutter.EVENT_STOP;
            // The results are hidden behind the reader: Enter and Tab would
            // act on them unseen. Other keys edit the search as usual.
            if (isEnter || symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab)
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onQueryChanged() {
        this._track('_hoverResult', null);
        const query = this._entry.get_text();
        const enabled = this._settings.get_boolean('answers-enabled');
        const key = enabled
            ? this._answers.lookupKey(query, this._settings.get_string('answers-language'))
            : null;

        // Same lookup as what's showing ("Paris" → "Paris "): keep it.
        if (key && key === this._cardKey && (this._card.visible || this._reader.visible))
            return;

        this._resetAnswers();
        if (!key)
            return;

        if (this._lookupId)
            GLib.source_remove(this._lookupId);
        this._lookupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOOKUP_DELAY_MS, () => {
            this._lookupId = 0;
            this._lookup(query, key).catch(e => {
                // Offline, rate-limited or superseded by newer typing: the
                // card simply doesn't appear. Anything else is a bug.
                if (!isExpectedError(e))
                    console.error(`Search Beam: answer lookup failed: ${e}`);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    async _lookup(query, key) {
        const answer = await this._answers.lookup(query,
            this._settings.get_string('answers-language'));
        if (!answer || !this._isCurrentQuery(query))
            return;
        if (!/^define\s/i.test(query.trim()) && this._topAppMatches(query))
            return;

        this._cardKey = key;
        this._card.setAnswer(answer);
        this._card.show();
        // GNOME prints "No results" when no app or file matches; with an
        // answer on screen that's wrong, so the stylesheet hides it.
        this._box.add_style_class_name('search-beam-has-answer');

        if (answer.thumbnail) {
            const bytes = await this._answers.fetchImage(answer.thumbnail);
            if (bytes && this._isCurrentQuery(query) && this._card.answer === answer)
                this._card.setThumbnail(Gio.BytesIcon.new(bytes));
        }
    }

    _isCurrentQuery(query) {
        return this._visible && this._acquired && this._entry.get_text() === query;
    }

    // Someone typing "fire" or "sett" is probably heading for Firefox or
    // Settings: don't push those results down with a dictionary card.
    // ("define fire" still gets one.)
    _topAppMatches(query) {
        const top = this._topResultIfAlive();
        if (!top?.app)
            return false;
        const q = query.trim().toLowerCase();
        const name = top.app.get_name().toLowerCase();
        return name.startsWith(q) || name.split(/\s+/).some(word => word.startsWith(q));
    }

    // Stop timers and requests without touching what's on screen.
    _cancelAnswers() {
        if (this._lookupId) {
            GLib.source_remove(this._lookupId);
            this._lookupId = 0;
        }
        this._answers?.cancelPending();
    }

    _resetAnswers() {
        this._cancelAnswers();
        this._closeReader();
        this._card.hide();
        this._card.answer = null;
        this._cardKey = null;
        this._box.remove_style_class_name('search-beam-has-answer');
    }

    _openReader() {
        const answer = this._card.answer;
        if (!answer || this._reader.visible)
            return;

        // A result with keyboard focus is about to be hidden; Clutter would
        // drop the focus, which reads as "focus left the popup". Keep it in
        // the search box.
        this._entry.grab_key_focus();
        this._card.hide();
        // Hiding the results unmaps GNOME's search controller, which resets
        // (clears) the search; keep the text while the reader covers them.
        this._holdSearch = true;
        try {
            this._resultsRow.hide();
        } finally {
            this._holdSearch = false;
        }
        this._reader.showAnswer(answer);
        this._reader.show();
        this._updatePreviewPoll();

        if (answer.kind !== 'wikipedia')
            return;
        const stillShowing = () => this._visible && this._reader.visible &&
            this._reader.answer === answer;
        this._answers.fetchArticle(answer.title, answer.lang).then(article => {
            if (!stillShowing())
                return;
            // An article that is all link lists leaves nothing to read: keep
            // the summary.
            if (article?.blocks.length)
                this._reader.showArticle(article);
            else
                this._reader.showArticleError();
        }).catch(e => {
            if (!isExpectedError(e))
                console.error(`Search Beam: loading the article failed: ${e}`);
            else if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) && stillShowing())
                this._reader.showArticleError();
        });
    }

    _closeReader() {
        if (!this._reader.visible)
            return;
        this._reader.hide();
        // While closing, leave the popup as it is for the fade-out.
        if (!this._visible)
            return;
        this._resultsRow.show();
        if (this._card.answer)
            this._card.show();
        this._updatePreviewPoll();
    }

    _openUrl(url) {
        if (!url.startsWith('https://'))
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(url,
                global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error(`Search Beam: could not open ${url}: ${e.message}`);
            return;
        }
        this.hide({restoreFocus: false});
    }

    // --- preview panel ----------------------------------------------------

    // The result (an app icon or a search result row) that contains actor,
    // if actor is inside GNOME's results.
    _resultFor(actor) {
        let found = null;
        for (let a = actor; a; a = a.get_parent()) {
            if (a === this._controller)
                return found;
            if (!found && (a.app || a.metaInfo))
                found = a;
        }
        return null;
    }

    // GNOME destroys result actors whenever the results refresh. Remember a
    // result only together with a destroy hook that forgets it, so it's never
    // touched after it's gone.
    _track(slot, actor) {
        const owner = this._trackOwners[slot];
        this[slot]?.disconnectObject(owner);
        this[slot] = actor;
        actor?.connectObject('destroy', () => {
            this._disposed.add(actor);
            this[slot] = null;
        }, owner);
    }

    // GNOME's highlighted top result. GNOME can leave this pointing at a
    // result it has since destroyed (when a provider is reloaded), so it is
    // tracked like the others and skipped once gone.
    _topResultIfAlive() {
        const top = this._controller?._searchResults?._defaultResult ?? null;
        if (!top || this._disposed.has(top))
            return null;
        if (top !== this._topResult)
            this._track('_topResult', top);
        return this._resultFor(top) ? top : null;
    }

    // The 250 ms check only runs while a preview can actually be shown.
    _updatePreviewPoll() {
        if (this._previewPollId) {
            GLib.source_remove(this._previewPollId);
            this._previewPollId = 0;
        }

        const wanted = this._visible && this._acquired && this._previewAllowed &&
            this._controller.searchActive && !this._reader.visible;
        if (!wanted)
            return;

        this._previewPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_POLL_MS, () => {
            this._syncPreview();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // What to preview: the result with keyboard focus, else the one under
    // the pointer, else GNOME's highlighted top result.
    _previewTarget() {
        if (!this._acquired || !this._previewAllowed || this._reader.visible ||
            !this._controller.searchActive)
            return null;
        const focused = this._resultFor(global.stage.get_key_focus());
        if (focused)
            return focused;
        if (this._hoverResult && this._resultFor(this._hoverResult))
            return this._hoverResult;
        return this._topResultIfAlive();
    }

    // The panel takes room, so the stylesheet folds GNOME's provider column
    // (Files, Settings…) down to its icon, only while the panel is showing.
    _setPreviewShown(shown) {
        this._preview.visible = shown;
        if (shown)
            this._box.add_style_class_name('search-beam-previewing');
        else
            this._box.remove_style_class_name('search-beam-previewing');
    }

    _syncPreview() {
        if (!this._visible)
            return;
        const target = this._previewTarget();
        if (target === this._previewedResult && (target !== null) === this._preview.visible)
            return;

        this._track('_previewedResult', target);
        this._previewCancellable?.cancel();
        this._previewCancellable = null;
        if (!target) {
            this._setPreviewShown(false);
            return;
        }

        const info = this._describeResult(target);
        this._preview.setInfo(info);
        this._setPreviewShown(true);
        if (!info.fileUri)
            return;

        // Files: show the name straight away, then the details once read,
        // then the picture once decoded.
        const cancellable = this._previewCancellable = new Gio.Cancellable();
        const current = () => this._visible && this._previewedResult === target;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        describeFile(info.fileUri, cancellable).then(async fileInfo => {
            if (!fileInfo || !current())
                return;
            this._preview.setInfo(fileInfo);
            if (!fileInfo.image)
                return;
            const bytes = await loadScaledImage(fileInfo.image, PREVIEW_IMAGE_SIZE * scale, cancellable);
            if (bytes && current())
                this._preview.setImage(Gio.BytesIcon.new(bytes));
        }).catch(e => {
            // Cancellation (the selection moved on) is a GLib error; anything
            // else is a bug.
            if (!(e instanceof GLib.Error))
                console.error(`Search Beam: preview failed: ${e}`);
        });
    }

    _describeResult(result) {
        if (result.app) {
            const app = result.app;
            return {
                title: app.get_name(),
                typeLabel: 'Application',
                description: app.get_description() ?? '',
                createIcon: size => app.create_icon_texture(size),
            };
        }
        // Search providers (including other extensions') can return
        // anything as metadata; only trust strings.
        const meta = result.metaInfo;
        const text = value => typeof value === 'string' ? value : '';
        const id = text(meta.id);
        return {
            title: text(meta.name),
            typeLabel: result.provider?.appInfo?.get_name() ?? '',
            description: text(meta.description),
            createIcon: size => meta.createIcon?.(size) ?? null,
            fileUri: id.startsWith('file://') ? id : null,
        };
    }

    _resetPreview() {
        this._previewCancellable?.cancel();
        this._previewCancellable = null;
        this._track('_hoverResult', null);
        this._track('_previewedResult', null);
        this._track('_topResult', null);
        this._setPreviewShown(false);
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
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const sw = this._settings.get_double('scale-width');
        const sh = this._settings.get_double('scale-height');

        const width = Math.min(work.width,
            Math.round((BASE_WIDTH + (monitor.width / scale / 2) * sw) * scale));
        const fullHeight = Math.min(work.height,
            Math.round((BASE_HEIGHT + (monitor.height / scale / 2) * sh) * scale));

        // Centre the full-size popup on the monitor (the bare search box sits
        // at its top), then nudge it inside the work area so it never covers
        // the top bar or a dock.
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
        const x = clamp(monitor.x + Math.round((monitor.width - width) / 2),
            work.x, work.x + work.width - width);
        const y = clamp(monitor.y + Math.round((monitor.height - fullHeight) / 2),
            work.y, work.y + work.height - fullHeight);

        const height = this._controller.searchActive
            ? fullHeight
            : Math.min(fullHeight, this._compactHeight(width));

        this.actor.set_position(x, y);
        this.actor.set_size(width, height);
        this._geometry = {x, y, width, height};

        this._previewAllowed = this._settings.get_boolean('show-preview') &&
            width >= MIN_PREVIEW_WIDTH * scale;
        this._preview.width = Math.round(width * PREVIEW_SHARE);
        if (!this._previewAllowed)
            this._setPreviewShown(false);
        this._updatePreviewPoll();
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
        const m = this._monitor ?? Main.layoutManager.primaryMonitor;
        // The wallpaper actor is placed for one monitor's position and size;
        // rebuild if the monitor (or its geometry) changed.
        const monitorKey = `${m.index}:${m.x},${m.y},${m.width}x${m.height}`;

        if (!enabled || this._blurMonitorKey !== monitorKey)
            this._destroyBlur();
        if (!enabled)
            return;

        if (!this._bgManager) {
            // _blurBox (rounded mask) > _blurClip (popup-sized, blurred) >
            // _bgContainer (wallpaper at monitor coordinates). Blurring the
            // clipped layer keeps the blur pass to the popup's size.
            this._blurClip = new St.Widget({
                x_expand: true,
                y_expand: true,
                clip_to_allocation: true,
            });
            this._blurBox.add_child(this._blurClip);
            this._bgContainer = new Clutter.Actor();
            this._blurClip.add_child(this._bgContainer);
            this._bgManager = new Background.BackgroundManager({
                container: this._bgContainer,
                monitorIndex: m.index,
                vignette: false,
                controlPosition: true,
            });
            this._blurEffect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR});
            this._blurClip.add_effect_with_name('blur', this._blurEffect);
            this._maskEffect = new RoundedMaskEffect();
            this._blurBox.add_effect_with_name('mask', this._maskEffect);
            this._blurMonitorKey = monitorKey;
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
        // St draws at most half the box's shorter side as corner radius.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = Math.min(this._settings.get_int('border-radius') * scale,
            width / 2, height / 2);
        this._maskEffect.setGeometry(radius, width, height);
    }

    _destroyBlur() {
        if (!this._bgManager)
            return;
        this._blurBox.remove_effect_by_name('mask');
        this._bgManager.destroy();
        this._blurClip.destroy();
        this._bgManager = null;
        this._bgContainer = null;
        this._blurClip = null;
        this._blurEffect = null;
        this._maskEffect = null;
        this._blurMonitorKey = undefined;
        this._blurBox.hide();
    }

    // --- styling ----------------------------------------------------------

    _onSettingChanged(key) {
        if (STYLE_KEYS.includes(key))
            this._updateStyle();
        if (BLUR_KEYS.includes(key) && this._visible)
            this._syncBlur();
        if ((STYLE_KEYS.includes(key) || LAYOUT_KEYS.includes(key)) && this._visible) {
            this._layout();
            this._syncPreview();
        }
        if (ANSWER_KEYS.includes(key) && this._acquired)
            this._onQueryChanged();
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

        // Automatic text colour: dark text only on a light background that is
        // opaque enough to decide what's behind the text. A mostly
        // see-through background keeps the shell's usual white text.
        const autoText = text[3] <= 0;
        const lightBg = bg[3] >= 0.5 &&
            0.3 * bg[0] + 0.59 * bg[1] + 0.11 * bg[2] >= 0.5;
        if (autoText && lightBg)
            this._box.add_style_class_name('light');
        else
            this._box.remove_style_class_name('light');

        const style = [
            `background-color: ${cssColor(bg)};`,
            `border-radius: ${radius}px;`,
        ];
        if (thickness > 0)
            style.push(`border: ${thickness}px solid ${cssColor(border)};`);
        if (fontSize > 0)
            style.push(`font-size: ${fontSize}pt;`);
        if (!autoText)
            style.push(`color: ${cssColor(text)};`);
        this._box.set_style(style.join(' '));

        // stylesheet.css makes everything in the box inherit the font size
        // and text colour set above.
        if (fontSize > 0)
            this._box.add_style_class_name('search-beam-custom-font');
        else
            this._box.remove_style_class_name('search-beam-custom-font');
        if (!autoText)
            this._box.add_style_class_name('search-beam-custom-color');
        else
            this._box.remove_style_class_name('search-beam-custom-color');

        // The search box is the Overview's: only styled while we hold it.
        if (this._acquired)
            this._entry.set_style(entryFontSize > 0 ? `font-size: ${entryFontSize}pt;` : null);
    }
}
