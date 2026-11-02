// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function toRgba([red, green, blue, alpha]) {
    return new Gdk.RGBA({red, green, blue, alpha});
}

function fromRgba(rgba) {
    return new GLib.Variant('(dddd)', [rgba.red, rgba.green, rgba.blue, rgba.alpha]);
}

function readColor(settings, key) {
    return settings.get_value(key).deepUnpack();
}

export default class SearchBeamPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window
        window.set_default_size(640, 720);

        // settings.bind() bindings end with their widgets, but plain
        // 'changed' handlers don't: drop them when the window closes, so they
        // never touch disposed widgets if the Extensions app keeps running.
        const handlerIds = [];
        this._watch = (key, callback) =>
            handlerIds.push(settings.connect(`changed::${key}`, callback));
        window.connect('close-request', () => {
            handlerIds.splice(0).forEach(id => settings.disconnect(id));
            return false;
        });

        window.add(this._generalPage(window, settings));
        window.add(this._appearancePage(settings));
    }

    // --- General ------------------------------------------------------------

    _generalPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcut',
            description: 'Press the shortcut again, or Esc, to close the popup.',
        });
        shortcuts.add(this._shortcutRow(window, settings, 'shortcut-search', 'Open search'));
        shortcuts.add(this._shortcutRow(window, settings, 'secondary-shortcut-search', 'Second shortcut'));
        page.add(shortcuts);

        const placement = new Adw.PreferencesGroup({title: 'Placement'});
        placement.add(this._monitorRow(settings));
        const cursorRow = new Adw.SwitchRow({
            title: 'Follow the mouse',
            subtitle: 'Open on the monitor under the pointer',
        });
        settings.bind('popup-at-cursor-monitor', cursorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        placement.add(cursorRow);
        page.add(placement);

        const answers = new Adw.PreferencesGroup({
            title: 'Answers',
            description: 'Definitions from Wiktionary and summaries from Wikipedia, shown in the popup. ' +
                'Click an answer or press Ctrl+Enter to read the whole entry.',
        });
        const answersRow = new Adw.SwitchRow({
            title: 'Look up answers online',
            subtitle: 'After you pause typing, your search is sent to Wikimedia',
        });
        settings.bind('answers-enabled', answersRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        answers.add(answersRow);
        const languageRow = new Adw.EntryRow({
            title: 'Wikipedia language code (en, fr, de, pt, simple…)',
        });
        settings.bind('answers-language', languageRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('answers-enabled', languageRow, 'sensitive', Gio.SettingsBindFlags.GET);
        answers.add(languageRow);
        page.add(answers);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        const panelRow = new Adw.SwitchRow({
            title: 'Top bar icon',
            subtitle: 'Show a search button in the top bar',
        });
        settings.bind('show-panel-icon', panelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(panelRow);

        const previewRow = new Adw.SwitchRow({
            title: 'Preview panel',
            subtitle: 'Show details of the selected result beside the results (popup width of 640 pixels or more)',
        });
        settings.bind('show-preview', previewRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(previewRow);

        const animRow = new Adw.SwitchRow({title: 'Animations'});
        settings.bind('use-animations', animRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(animRow);

        const speedRow = Adw.SpinRow.new_with_range(0, 1000, 10);
        speedRow.set({title: 'Animation length', subtitle: 'Milliseconds'});
        settings.bind('animation-speed', speedRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('use-animations', speedRow, 'sensitive', Gio.SettingsBindFlags.GET);
        behaviour.add(speedRow);
        page.add(behaviour);

        return page;
    }

    _shortcutRow(window, settings, key, title) {
        const row = new Adw.ActionRow({title, activatable: true});

        const label = new Gtk.ShortcutLabel({
            disabled_text: 'Not set',
            valign: Gtk.Align.CENTER,
        });
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Remove shortcut',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        clear.connect('clicked', () => settings.set_strv(key, []));

        const sync = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
            clear.visible = label.accelerator !== '';
        };
        sync();
        this._watch(key, sync);

        row.add_suffix(label);
        row.add_suffix(clear);
        row.connect('activated', () => this._captureShortcut(window, settings, key, title));
        return row;
    }

    _captureShortcut(window, settings, key, title) {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: 'Press the new shortcut: Ctrl, Alt or Super with a key, or an F-key.\nEsc cancels, Backspace removes it.',
        });
        dialog.add_response('cancel', 'Cancel');

        // Let the dialog receive combinations GNOME Shell would otherwise
        // handle itself (including Search Beam's current shortcut). GNOME may
        // ask once for permission, as it does in Settings → Keyboard.
        const surface = window.get_surface();
        try {
            surface?.inhibit_system_shortcuts(null);
        } catch {
            // not supported here; capture still works for free combinations
        }
        dialog.connect('closed', () => {
            try {
                surface?.restore_system_shortcuts();
            } catch {
                // nothing was inhibited
            }
        });

        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        controller.connect('key-pressed', (c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;

            if (!mods && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Wait for a real key, not a bare modifier. Shift alone is not
            // enough: Shift+A would steal every capital A system-wide.
            const hasModifier = (mods & ~Gdk.ModifierType.SHIFT_MASK) !== 0;
            const isFunctionKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
            if (!Gtk.accelerator_valid(keyval, mods) || (!hasModifier && !isFunctionKey))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
            settings.set_strv(key, [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(window);
    }

    _monitorRow(settings) {
        const count = Gdk.Display.get_default()?.get_monitors().get_n_items() ?? 1;
        const n = Math.max(count, settings.get_int('preferred-monitor'));
        const names = ['Primary monitor'];
        for (let i = 1; i <= n; i++)
            names.push(`Monitor ${i}`);

        const row = new Adw.ComboRow({
            title: 'Monitor',
            model: Gtk.StringList.new(names),
        });
        settings.bind('preferred-monitor', row, 'selected', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('popup-at-cursor-monitor', row, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        return row;
    }

    // --- Appearance ----------------------------------------------------------

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });

        const size = new Adw.PreferencesGroup({
            title: 'Size',
            description: 'Extra room on top of the 600 × 400 base size.',
        });
        size.add(this._scaleRow(settings, 'scale-width', 'Width', 0, 1, 0.01));
        size.add(this._scaleRow(settings, 'scale-height', 'Height', 0, 1, 0.01));
        page.add(size);

        const colours = new Adw.PreferencesGroup({title: 'Colours'});
        colours.add(this._colorRow(settings, 'background-color', 'Background'));

        const autoText = new Adw.SwitchRow({
            title: 'Automatic text colour',
            subtitle: 'White on dark backgrounds, black on light ones',
        });
        const textRow = this._colorRow(settings, 'text-color', 'Text colour');
        const syncAuto = () => {
            const auto = readColor(settings, 'text-color')[3] <= 0;
            if (autoText.active !== auto)
                autoText.active = auto;
            textRow.sensitive = !auto;
        };
        syncAuto();
        this._watch('text-color', syncAuto);
        autoText.connect('notify::active', () => {
            const [r, g, b, a] = readColor(settings, 'text-color');
            if (autoText.active && a > 0)
                settings.set_value('text-color', new GLib.Variant('(dddd)', [r, g, b, 0]));
            else if (!autoText.active && a <= 0)
                settings.set_value('text-color', new GLib.Variant('(dddd)', [r, g, b, 1]));
        });
        colours.add(autoText);
        colours.add(textRow);
        page.add(colours);

        const shape = new Adw.PreferencesGroup({title: 'Shape'});
        shape.add(this._spinRow(settings, 'border-radius', 'Corner radius', 0, 48, 1, 'Pixels'));
        shape.add(this._spinRow(settings, 'border-thickness', 'Border', 0, 8, 1, 'Pixels, 0 for none'));
        const borderColor = this._colorRow(settings, 'border-color', 'Border colour');
        const syncBorder = () => {
            borderColor.sensitive = settings.get_int('border-thickness') > 0;
        };
        syncBorder();
        this._watch('border-thickness', syncBorder);
        shape.add(borderColor);
        page.add(shape);

        const text = new Adw.PreferencesGroup({title: 'Text size'});
        text.add(this._spinRow(settings, 'entry-font-size', 'Search box', 0, 40, 1, 'Points, 0 for the theme default'));
        text.add(this._spinRow(settings, 'font-size', 'Results', 0, 40, 1, 'Points, 0 for the theme default'));
        page.add(text);

        const blur = new Adw.PreferencesGroup({title: 'Blur'});
        const blurRow = new Adw.SwitchRow({
            title: 'Blurred wallpaper',
            subtitle: 'Show a blurred wallpaper behind the background colour',
        });
        settings.bind('blur-background', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        blur.add(blurRow);
        const strength = this._spinRow(settings, 'blur-sigma', 'Strength', 0, 200, 1);
        settings.bind('blur-background', strength, 'sensitive', Gio.SettingsBindFlags.GET);
        blur.add(strength);
        const brightness = this._scaleRow(settings, 'blur-brightness', 'Brightness', 0, 1, 0.01);
        settings.bind('blur-background', brightness, 'sensitive', Gio.SettingsBindFlags.GET);
        blur.add(brightness);
        page.add(blur);

        return page;
    }

    _spinRow(settings, key, title, min, max, step, subtitle = null) {
        const row = Adw.SpinRow.new_with_range(min, max, step);
        row.set({title});
        if (subtitle)
            row.subtitle = subtitle;
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _scaleRow(settings, key, title, min, max, step) {
        const row = new Adw.ActionRow({title});
        const scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
            digits: 2,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 260,
            valign: Gtk.Align.CENTER,
        });
        settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(scale);
        return row;
    }

    _colorRow(settings, key, title) {
        const row = new Adw.ActionRow({title});
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true}),
            valign: Gtk.Align.CENTER,
        });

        let updating = false;
        const sync = () => {
            updating = true;
            const [r, g, b, a] = readColor(settings, key);
            // Show the text colour opaque while "automatic" hides its alpha.
            button.rgba = toRgba([r, g, b, key === 'text-color' && a <= 0 ? 1 : a]);
            updating = false;
        };
        sync();
        this._watch(key, sync);
        button.connect('notify::rgba', () => {
            if (!updating)
                settings.set_value(key, fromRgba(button.rgba));
        });

        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }
}
