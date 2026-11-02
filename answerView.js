// SPDX-License-Identifier: GPL-2.0-or-later
//
// The answer card (a short definition or summary above the search results)
// and the reader (the full entry, shown in place of the results).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {truncate} from './answers.js';

const SUMMARY_CHARS = 240;

const ATTRIBUTION = {
    Wikipedia: 'From Wikipedia, the free encyclopedia · CC BY-SA 4.0',
    Wiktionary: 'From Wiktionary, the free dictionary · CC BY-SA 4.0',
};

function wrappedLabel(styleClass, text = '') {
    const label = new St.Label({style_class: styleClass, text, x_expand: true});
    label.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.NONE,
    });
    return label;
}

function iconButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'search-beam-reader-button',
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
        accessible_name: accessibleName,
        can_focus: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export const AnswerCard = GObject.registerClass({
    Signals: {'activate': {}},
}, class SearchBeamAnswerCard extends St.Button {
    _init() {
        super._init({
            name: 'searchBeamAnswer',
            style_class: 'search-beam-answer',
            x_expand: true,
            can_focus: false,
            visible: false,
        });
        this.answer = null;

        this._thumb = new St.Icon({
            style_class: 'search-beam-answer-thumb',
            icon_size: 56,
            visible: false,
            y_align: Clutter.ActorAlign.START,
        });

        this._title = new St.Label({style_class: 'search-beam-answer-title', x_expand: true});
        this._source = new St.Label({
            style_class: 'search-beam-answer-source',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(this._title);
        header.add_child(this._source);

        this._subtitle = new St.Label({style_class: 'search-beam-answer-subtitle'});
        this._summary = wrappedLabel('search-beam-answer-summary');
        const hint = new St.Label({
            style_class: 'search-beam-answer-hint',
            text: 'Click or press Ctrl+Enter to read more',
        });

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        text.add_child(header);
        text.add_child(this._subtitle);
        text.add_child(this._summary);
        text.add_child(hint);

        const row = new St.BoxLayout({style_class: 'search-beam-answer-row', x_expand: true});
        row.add_child(this._thumb);
        row.add_child(text);
        this.set_child(row);

        this.connect('clicked', () => this.emit('activate'));
    }

    setAnswer(answer) {
        this.answer = answer;
        this._title.text = answer.title;
        this._source.text = answer.source;
        this._subtitle.text = answer.subtitle;
        this._subtitle.visible = answer.subtitle !== '';
        this._summary.text = truncate(answer.summary, SUMMARY_CHARS);
        this.setThumbnail(null);
    }

    setThumbnail(gicon) {
        this._thumb.gicon = gicon;
        this._thumb.visible = gicon !== null;
    }
});

export const AnswerReader = GObject.registerClass({
    Signals: {
        'back': {},
        'open-url': {param_types: [GObject.TYPE_STRING]},
        'copy': {param_types: [GObject.TYPE_STRING]},
    },
}, class SearchBeamAnswerReader extends St.BoxLayout {
    _init() {
        super._init({
            name: 'searchBeamReader',
            style_class: 'search-beam-reader',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.answer = null;
        this._copyText = '';

        const back = iconButton('go-previous-symbolic', 'Back to results');
        back.connect('clicked', () => this.emit('back'));
        this._title = new St.Label({
            style_class: 'search-beam-reader-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._copyButton = iconButton('edit-copy-symbolic', 'Copy text');
        this._copyButton.connect('clicked', () => {
            this.emit('copy', this._copyText);
            this._copyButton.child.icon_name = 'object-select-symbolic';
        });
        const open = iconButton('web-browser-symbolic', 'Open in browser');
        open.connect('clicked', () => this.emit('open-url', this.answer?.url ?? ''));

        const header = new St.BoxLayout({style_class: 'search-beam-reader-header', x_expand: true});
        header.add_child(back);
        header.add_child(this._title);
        header.add_child(this._copyButton);
        header.add_child(open);
        this.add_child(header);

        this._content = new St.BoxLayout({
            style_class: 'search-beam-reader-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'search-beam-reader-scroll vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._content,
        });
        this.add_child(this._scroll);
    }

    // Show what the answer already carries: every sense for a definition,
    // the summary (while the full article loads) for Wikipedia.
    showAnswer(answer) {
        this.answer = answer;
        this._title.text = answer.title;
        this._copyButton.child.icon_name = 'edit-copy-symbolic';
        this._scroll.vadjustment.value = 0;

        if (answer.kind === 'dictionary') {
            const blocks = [];
            const lines = [answer.title];
            for (const entry of answer.entries) {
                blocks.push({type: 'heading', text: entry.partOfSpeech, level: 2});
                lines.push('', entry.partOfSpeech);
                entry.definitions.forEach((sense, i) => {
                    blocks.push({type: 'text', text: `${i + 1}. ${sense.text}`});
                    lines.push(`${i + 1}. ${sense.text}`);
                    for (const example of sense.examples) {
                        blocks.push({type: 'example', text: example});
                        lines.push(`   “${example}”`);
                    }
                });
            }
            this._render(blocks, false);
            this._copyText = lines.join('\n');
        } else {
            this._render([
                {type: 'text', text: answer.summary},
                {type: 'status', text: 'Loading the full article…'},
            ], false);
            this._copyText = `${answer.title}\n\n${answer.summary}`;
        }
    }

    showArticle(article) {
        this._render(article.blocks, article.truncated);
        this._copyText = [this.answer.title, ...article.blocks.map(b => b.text)].join('\n\n');
    }

    showArticleError() {
        // Keep the summary; replace the "loading" line.
        this._render([
            {type: 'text', text: this.answer.summary},
            {type: 'status', text: "Couldn't load the full article."},
        ], true);
    }

    // Keyboard scrolling while focus stays in the search box.
    scroll(symbol) {
        const adj = this._scroll.vadjustment;
        const step = {
            [Clutter.KEY_Up]: -adj.step_increment,
            [Clutter.KEY_Down]: adj.step_increment,
            [Clutter.KEY_Page_Up]: -adj.page_increment,
            [Clutter.KEY_Page_Down]: adj.page_increment,
        }[symbol];
        if (step !== undefined)
            adj.value = Math.max(adj.lower, Math.min(adj.value + step, adj.upper - adj.page_size));
        else if (symbol === Clutter.KEY_Home)
            adj.value = adj.lower;
        else if (symbol === Clutter.KEY_End)
            adj.value = adj.upper - adj.page_size;
        else
            return false;
        return true;
    }

    get scrollPosition() {
        return this._scroll.vadjustment.value;
    }

    _render(blocks, offerMore) {
        this._content.destroy_all_children();
        for (const block of blocks) {
            const style = {
                heading: block.level > 2 ? 'search-beam-reader-subheading' : 'search-beam-reader-heading',
                text: 'search-beam-reader-text',
                example: 'search-beam-reader-example',
                status: 'search-beam-reader-status',
            }[block.type];
            this._content.add_child(wrappedLabel(style, block.text));
        }

        if (offerMore) {
            const more = new St.Button({
                style_class: 'search-beam-reader-more',
                label: `Continue reading on ${this.answer.source}`,
                can_focus: false,
                x_align: Clutter.ActorAlign.START,
            });
            more.connect('clicked', () => this.emit('open-url', this.answer.url));
            this._content.add_child(more);
        }

        this._content.add_child(wrappedLabel('search-beam-reader-footer',
            ATTRIBUTION[this.answer.source] ?? ''));
    }
});
