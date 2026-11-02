// SPDX-License-Identifier: GPL-2.0-or-later
//
// The preview panel beside the results: a large icon or image, the name,
// what kind of thing it is, details (where, size, modified) and, for text
// files, the first lines.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {wrappedLabel} from './answerView.js';

const ICON_SIZE = 96;
export const PREVIEW_IMAGE_SIZE = 180;

export const PreviewPane = GObject.registerClass(
class SearchBeamPreviewPane extends St.BoxLayout {
    _init() {
        super._init({
            name: 'searchBeamPreview',
            style_class: 'search-beam-preview',
            orientation: Clutter.Orientation.VERTICAL,
            y_expand: true,
            visible: false,
        });
        this.info = null;

        this._iconBin = new St.Bin({
            style_class: 'search-beam-preview-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._title = wrappedLabel('search-beam-preview-title');
        this._type = wrappedLabel('search-beam-preview-type');
        this._description = wrappedLabel('search-beam-preview-description');
        this._details = new St.BoxLayout({
            style_class: 'search-beam-preview-details',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._snippet = wrappedLabel('search-beam-preview-snippet');

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        for (const child of [this._iconBin, this._title, this._type,
            this._description, this._details, this._snippet])
            content.add_child(child);

        this._scroll = new St.ScrollView({
            style_class: 'search-beam-preview-scroll vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: content,
        });
        this.add_child(this._scroll);
    }

    // info: {title, typeLabel, description?, details?, snippet?, image?,
    // icon? (a Gio.Icon), createIcon? (() => actor)}
    setInfo(info) {
        this.info = info;
        this._scroll.vadjustment.value = 0;

        this._iconBin.child?.destroy();
        this._iconBin.child = this._makeIcon(info);

        this._title.text = info.title ?? '';
        this._type.text = info.typeLabel ?? '';
        this._type.visible = this._type.text !== '';
        this._description.text = info.description ?? '';
        this._description.visible = this._description.text !== '';

        this._details.destroy_all_children();
        for (const [key, value] of info.details ?? []) {
            const row = new St.BoxLayout({style_class: 'search-beam-preview-detail'});
            row.add_child(new St.Label({
                style_class: 'search-beam-preview-detail-key',
                text: key,
                y_align: Clutter.ActorAlign.START,
            }));
            const valueLabel = wrappedLabel('search-beam-preview-detail-value');
            valueLabel.text = value;
            row.add_child(valueLabel);
            this._details.add_child(row);
        }
        this._details.visible = (info.details ?? []).length > 0;

        this._snippet.text = info.snippet ?? '';
        this._snippet.visible = this._snippet.text !== '';
    }

    // The decoded picture (a Gio.BytesIcon from loadScaledImage) replaces
    // the file-type icon once it's ready.
    setImage(gicon) {
        this._iconBin.child?.destroy();
        this._iconBin.child = new St.Icon({
            style_class: 'search-beam-preview-image',
            gicon,
            fallback_gicon: this.info?.icon ?? null,
            icon_size: PREVIEW_IMAGE_SIZE,
        });
        this.imageShown = true;
    }

    _makeIcon(info) {
        this.imageShown = false;
        const actor = info.createIcon?.(ICON_SIZE);
        if (actor)
            return actor;
        return new St.Icon({
            gicon: info.icon ?? null,
            icon_name: info.icon ? null : 'text-x-generic-symbolic',
            icon_size: ICON_SIZE,
        });
    }
});
