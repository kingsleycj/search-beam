import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
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
        const findByName = (root, name) => {
            if (!root)
                return null;
            if (root.name === name)
                return root;
            for (const child of root.get_children()) {
                const found = findByName(child, name);
                if (found)
                    return found;
            }
            return null;
        };
        // A Files-like search provider returning two real files, so the
        // preview panel can be tested without the real Files search.
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'beamtest']);
        GLib.mkdir_with_parents(dir, 0o755);
        const notes = GLib.build_filenamev([dir, 'beamtest-notes.txt']);
        GLib.file_set_contents(notes, 'Search Beam preview test\nsecond line\n');
        const image = GLib.build_filenamev([dir, 'beamtest-image.png']);
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 160, 120);
        pixbuf.fill(0x7a3e9dff);
        pixbuf.savev(image, 'png', [], []);
        const uris = [notes, image].map(p => Gio.File.new_for_path(p).get_uri());
        const provider = {
            id: 'beamtest-files',
            isRemoteProvider: false,
            canLaunchSearch: false,
            appInfo: Gio.DesktopAppInfo.new('org.gnome.Nautilus.desktop'),
            getInitialResultSet: async terms =>
                terms.some(t => t.startsWith('beamtest') || t === 'serendipity') ? uris : [],
            getSubsearchResultSet: async (previous, terms) =>
                terms.some(t => t.startsWith('beamtest') || t === 'serendipity') ? uris : [],
            getResultMetas: async ids => ids.map(id => {
                const file = Gio.File.new_for_uri(id);
                return {
                    id,
                    name: file.get_basename(),
                    description: file.get_parent().get_path(),
                    createIcon: size => new St.Icon({icon_name: 'text-x-generic', icon_size: size}),
                };
            }),
            filterResults: (results, max) => results.slice(0, max),
            activateResult: () => {},
            launchSearch: () => {},
        };
        Main.overview.searchController.addProvider(provider);
        this._provider = provider;

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
            move(x, y) {
                ptr.notify_absolute_motion(t(), x, y);
            },
            // Centres of the visible result rows/icons, in order.
            resultCenters() {
                const a = find();
                const out = [];
                const walk = actor => {
                    if (!actor.mapped)
                        return;
                    if (actor.app || actor.metaInfo) {
                        const [x, y] = actor.get_transformed_position();
                        out.push({name: actor.app?.get_name() ?? actor.metaInfo.name,
                            x: Math.round(x + actor.width / 2), y: Math.round(y + actor.height / 2)});
                        return;
                    }
                    actor.get_children().forEach(walk);
                };
                if (a)
                    walk(a);
                return out;
            },
            press(x, y) {
                ptr.notify_absolute_motion(t(), x, y);
                ptr.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            },
            release() {
                ptr.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            },
            ext() {
                const e = Main.extensionManager.lookup('search-beam@kingsleycj.github.io');
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
                    focusInPopup: !!a && !!global.stage.key_focus && a.contains(global.stage.key_focus),
                    insideWorkArea: !!a && (() => {
                        const w = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
                        return a.y >= w.y && a.y + a.height <= w.y + w.height;
                    })(),
                    focusWindow: global.display.focus_window?.title ?? null,
                    overview: Main.overview.visible,
                    controllerVisible: Main.overview.searchController.mapped,
                    ...(() => {
                        const preview = findByName(a, 'searchBeamPreview');
                        const card = findByName(a, 'searchBeamAnswer');
                        const reader = findByName(a, 'searchBeamReader');
                        return {
                            cardVisible: !!card?.visible,
                            cardTitle: card?.answer?.title ?? null,
                            cardSource: card?.answer?.source ?? null,
                            cardThumb: !!card?.visible && !!card?._thumb?.visible,
                            cardX: card ? Math.round(card.get_transformed_position()[0] + card.width / 2) : null,
                            cardY: card ? Math.round(card.get_transformed_position()[1] + card.height / 2) : null,
                            readerVisible: !!reader?.visible,
                            readerBlocks: reader?._content?.get_n_children() ?? 0,
                            readerScrolled: (reader?.scrollPosition ?? 0) > 0,
                            previewVisible: !!preview?.mapped,
                            previewTitle: preview?.info?.title ?? null,
                            previewType: preview?.info?.typeLabel ?? null,
                            previewSnippet: preview?.info?.snippet ?? null,
                            previewDetailKeys: (preview?.info?.details ?? []).map(d => d[0]).join(','),
                            previewImage: !!preview?.imageShown,
                            boxPreviewing: !!findByName(a, 'searchBeamBox')?.has_style_class_name('search-beam-previewing'),
                            focusOnResult: (() => {
                                for (let f = global.stage.key_focus; f; f = f.get_parent()) {
                                    if (f.app || f.metaInfo)
                                        return true;
                                }
                                return false;
                            })(),
                        };
                    })(),
                    toggleOwn: Object.prototype.hasOwnProperty.call(Main.overview, 'toggle') || Object.prototype.hasOwnProperty.call(Main.overview, 'hide'),
                };
            },
        };
    }

    disable() {
        // GNOME re-enables extensions after one that is toggled; don't leave
        // a second copy of the test provider behind.
        Main.overview.searchController.removeProvider(this._provider);
        this._provider = null;
    }
}
