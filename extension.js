// SPDX-License-Identifier: GPL-2.0-or-later
//
// Search Beam: GNOME's search in a Spotlight-style popup.
// A GNOME 50 replacement for Search Light (github.com/icedman/search-light).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SearchBeamPopup} from './popup.js';

const SHORTCUT_KEYS = ['shortcut-search', 'secondary-shortcut-search'];

const PanelButton = GObject.registerClass(
class SearchBeamPanelButton extends PanelMenu.Button {
    _init(onActivate) {
        super._init(0.0, 'Search Beam', true);

        this.add_child(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'system-status-icon',
        }));

        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => onActivate());
        this.add_action(click);
    }
});

export default class SearchBeamExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        const stylesheetPath = GLib.build_filenamev(
            [GLib.get_user_runtime_dir(), `${this.uuid}.css`]);
        this._popup = new SearchBeamPopup(this._settings, stylesheetPath);

        for (const key of SHORTCUT_KEYS) {
            Main.wm.addKeybinding(key, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                () => this._popup.toggle());
        }

        this._settings.connectObject('changed::show-panel-icon',
            () => this._syncPanelButton(), this);
        this._syncPanelButton();
    }

    disable() {
        for (const key of SHORTCUT_KEYS)
            Main.wm.removeKeybinding(key);

        this._settings.disconnectObject(this);

        this._panelButton?.destroy();
        this._panelButton = null;

        this._popup.destroy();
        this._popup = null;

        this._settings = null;
    }

    _syncPanelButton() {
        const wanted = this._settings.get_boolean('show-panel-icon');

        if (wanted && !this._panelButton) {
            this._panelButton = new PanelButton(() => this._popup.toggle());
            Main.panel.addToStatusArea(this.uuid, this._panelButton, 0, 'right');
        } else if (!wanted && this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }
    }
}
