import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class Helper extends Extension {
    enable() {
        global.context.unsafe_mode = true;
        const seat = Clutter.get_default_backend().get_default_seat();
        const kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const t = () => GLib.get_monotonic_time();
        const find = () => Main.layoutManager.uiGroup.get_children().find(a => a.name === 'searchBeam');
        globalThis.sbTest = {
            chord(...names) {
                const ks = names.map(n => Clutter[`KEY_${n}`]);
                ks.forEach(k => kbd.notify_keyval(t(), k, Clutter.KeyState.PRESSED));
                ks.reverse().forEach(k => kbd.notify_keyval(t(), k, Clutter.KeyState.RELEASED));
                return ks;
            },
            type(str) {
                for (const c of str) {
                    const k = Clutter.unicode_to_keysym(c.codePointAt(0));
                    kbd.notify_keyval(t(), k, Clutter.KeyState.PRESSED);
                    kbd.notify_keyval(t(), k, Clutter.KeyState.RELEASED);
                }
            },
            click(x, y) {
                ptr.notify_absolute_motion(t(), x, y);
                ptr.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
                ptr.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            },
            ext() {
                const e = Main.extensionManager.lookup('search-beam@kingsleycj');
                return {state: e?.state, error: `${e?.error ?? ''}`};
            },
            popup() {
                const a = find();
                const entry = Main.overview.searchEntry;
                return {
                    exists: !!a,
                    visible: a?.visible, opacity: a?.opacity,
                    x: a?.x, y: a?.y, w: a?.width, h: a?.height,
                    entryParent: `${entry.get_parent()?.constructor?.name}:${entry.get_parent()?.name}`,
                    controllerParent: `${Main.overview.searchController.get_parent()?.name ?? Main.overview.searchController.get_parent()?.style_class}`,
                    text: entry.text,
                    searchActive: Main.overview.searchController.searchActive,
                    keyFocus: `${global.stage.key_focus}`,
                    focusWindow: global.display.focus_window?.title ?? null,
                    overview: Main.overview.visible,
                    toggleOwn: Object.prototype.hasOwnProperty.call(Main.overview, 'toggle') || Object.prototype.hasOwnProperty.call(Main.overview, 'hide'),
                };
            },
        };
    }

    disable() {}
}
