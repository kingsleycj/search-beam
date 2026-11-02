// SPDX-License-Identifier: GPL-2.0-or-later
//
// The preview panel beside the results: a large icon or image, the name,
// what kind of thing it is, details (where, size, modified) and, for text
// files, the first lines.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

const ICON_SIZE = 96;
const IMAGE_SIZE = 180;

function wrappedLabel(styleClass) {
    const label = new St.Label({style_class: styleClass, x_expand: true});
    label.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.NONE,
    });
    return label;
}

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

    _makeIcon(info) {
        if (info.image) {
            return new St.Icon({
                style_class: 'search-beam-preview-image',
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(info.image)),
                icon_size: IMAGE_SIZE,
            });
        }
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
