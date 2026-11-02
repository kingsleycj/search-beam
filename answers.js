// SPDX-License-Identifier: GPL-2.0-or-later
//
// Online answers for the popup: dictionary definitions from Wiktionary and
// article summaries from Wikipedia (both run by Wikimedia; text is
// CC BY-SA 4.0). Only used when the user turns on "Look up answers online".
//
// This module has no GNOME Shell imports, so the pure helpers below can be
// unit-tested with plain gjs (test/unit/answers.test.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// Wikimedia asks API clients to identify themselves with a contact URL.
const USER_AGENT = 'SearchBeam/1.1 (https://github.com/kingsleycj/search-beam)';
const MIN_LENGTH = 3;
const CACHE_SIZE = 100;
const ARTICLE_CHARS = 12000;

// Sections that are lists of links rather than reading material.
const SKIP_SECTIONS = new Set([
    'see also', 'references', 'external links', 'notes', 'further reading',
    'citations', 'sources', 'bibliography', 'footnotes', 'notes and references',
]);

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'what', 'who', 'whom', 'which', 'how', 'why',
    'when', 'where', 'does', 'did', 'are', 'was', 'were', 'from', 'into',
]);

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

// Entry types that are rarely what someone looking up a word means; they go
// after the real senses ("run" should lead with the verb, not a language code).
const MINOR_PARTS = new Set([
    'symbol', 'letter', 'abbreviation', 'initialism', 'acronym', 'prefix', 'suffix',
]);

// --- pure helpers -----------------------------------------------------------

// Decide whether a query is worth looking up and which sources to try, in
// order. Returns null for things other providers answer better (app-name
// fragments are filtered later by exact-title matching; numbers and
// arithmetic belong to Calculator).
export function planLookup(query) {
    const q = query.trim().replace(/\s+/g, ' ');

    const define = q.match(/^define\s+(\S.*)$/i);
    if (define)
        return {term: define[1], steps: ['dictionary']};

    if (q.length < MIN_LENGTH || /^\d/.test(q) || /[+*/=^%]/.test(q))
        return null;

    if (!q.includes(' ')) {
        // A lowercase word is probably a word to define; a capitalised one
        // is probably a name (Paris, Linux).
        return q === q.toLowerCase()
            ? {term: q, steps: ['dictionary', 'wikipedia-title']}
            : {term: q, steps: ['wikipedia-title', 'dictionary']};
    }
    return {term: q, steps: ['wikipedia-search']};
}

export function htmlToText(html) {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
            if (entity[0] === '#') {
                const code = entity[1].toLowerCase() === 'x'
                    ? parseInt(entity.slice(2), 16)
                    : parseInt(entity.slice(1), 10);
                return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
            }
            return ENTITIES[entity.toLowerCase()] ?? match;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

// Wiktionary's definition endpoint returns entries per language code; keep
// the English ones that have at least one non-empty sense.
export function parseDefinitions(json) {
    const entries = (json?.en ?? [])
        .map(entry => ({
            partOfSpeech: entry.partOfSpeech ?? '',
            definitions: (entry.definitions ?? [])
                .map(sense => {
                    // parsedExamples, when present, repeats examples with
                    // extra metadata; use one or the other.
                    const raw = sense.parsedExamples?.length
                        ? sense.parsedExamples.map(p => p.example ?? '')
                        : sense.examples ?? [];
                    return {
                        text: htmlToText(sense.definition ?? ''),
                        examples: raw.map(htmlToText).filter(Boolean),
                    };
                })
                .filter(sense => sense.text),
        }))
        .filter(entry => entry.definitions.length);
    const isMinor = e => MINOR_PARTS.has(e.partOfSpeech.toLowerCase());
    entries.sort((a, b) => isMinor(a) - isMinor(b));
    return entries.length ? entries : null;
}

export function isCommonWord(entries) {
    return entries.some(e => e.partOfSpeech.toLowerCase() !== 'proper noun');
}

function normalizeTitle(title) {
    return title.replace(/_/g, ' ').trim().toLowerCase();
}

export function pickExactTitle(pages, term) {
    const wanted = normalizeTitle(term);
    return pages.find(p => normalizeTitle(p.title ?? p.key ?? '') === wanted) ?? null;
}

function significantWords(text) {
    return text.toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

// Full-text search always returns something; only accept a result whose
// title or description shares at least half of the query's important words.
// Comparing the first five letters lets "invented" match "invention".
export function isRelevant(page, query) {
    const words = significantWords(query);
    if (!words.length)
        return false;
    const stem = w => w.slice(0, 5);
    const available = new Set(
        significantWords(`${page.title ?? ''} ${page.description ?? ''}`).map(stem));
    const hits = words.filter(w => available.has(stem(w))).length;
    return hits / words.length >= 0.5;
}

// Turn Wikipedia's plain-text extract ("== Heading ==" lines between
// paragraphs) into blocks, skipping link-list sections, stopping near
// maxChars of body text, and dropping headings left with nothing under them.
export function splitArticle(text, maxChars) {
    const blocks = [];
    let used = 0;
    let truncated = false;
    let skipLevel = 0;

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line)
            continue;

        const heading = line.match(/^(={2,6})\s*(.+?)\s*\1$/);
        if (heading) {
            const level = heading[1].length;
            if (skipLevel && level > skipLevel)
                continue;
            skipLevel = SKIP_SECTIONS.has(heading[2].toLowerCase()) ? level : 0;
            if (!skipLevel)
                blocks.push({type: 'heading', text: heading[2], level});
            continue;
        }
        if (skipLevel)
            continue;

        if (used > 0 && used + line.length > maxChars) {
            truncated = true;
            break;
        }
        blocks.push({type: 'text', text: line});
        used += line.length;
    }

    const cleaned = blocks.filter((block, i) => {
        if (block.type !== 'heading')
            return true;
        const next = blocks.slice(i + 1).find(b =>
            b.type === 'text' || b.level <= block.level);
        return next?.type === 'text';
    });
    return {blocks: cleaned, truncated};
}

export function normalizeLanguage(code) {
    const c = (code ?? '').trim().toLowerCase();
    return /^[a-z]{2,3}(-[a-z]{2,8})?$/.test(c) ? c : 'en';
}

export function truncate(text, max) {
    if (text.length <= max)
        return text;
    let cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    if (space > max / 2)
        cut = cut.slice(0, space);
    return `${cut.trimEnd()}…`;
}

// --- network ------------------------------------------------------------

export class AnswerService {
    constructor() {
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 8});
        this._cache = new Map();
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
        this._cache.clear();
    }

    // Abandon any lookups still in flight (the query changed).
    cancelPending() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
    }

    // Resolves to an answer object, or null when nothing fits. Rejects on
    // network errors and cancellation; those results are not cached.
    async lookup(query, language) {
        const plan = planLookup(query);
        if (!plan)
            return null;

        const lang = normalizeLanguage(language);
        const key = `${lang}|${plan.steps.join(',')}|${plan.term}`;
        if (this._cache.has(key))
            return this._cache.get(key);

        const cancellable = this._cancellable;
        // When the dictionary is only the first guess, a proper-noun-only
        // entry ("paris") should fall through to Wikipedia.
        const commonOnly = plan.steps[0] === 'dictionary' && plan.steps.length > 1;
        let answer = null;
        for (const step of plan.steps) {
            if (step === 'dictionary')
                // eslint-disable-next-line no-await-in-loop
                answer = await this._dictionary(plan.term, lang, commonOnly, cancellable);
            else if (step === 'wikipedia-title')
                // eslint-disable-next-line no-await-in-loop
                answer = await this._wikipediaTitle(plan.term, lang, cancellable);
            else
                // eslint-disable-next-line no-await-in-loop
                answer = await this._wikipediaSearch(plan.term, lang, cancellable);
            if (answer)
                break;
        }

        this._cache.delete(key);
        this._cache.set(key, answer);
        if (this._cache.size > CACHE_SIZE)
            this._cache.delete(this._cache.keys().next().value);
        return answer;
    }

    // The full article as reading blocks, for the "read more" view.
    async fetchArticle(title, language) {
        const lang = normalizeLanguage(language);
        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts` +
            `&explaintext=1&exsectionformat=wiki&redirects=1&format=json&formatversion=2` +
            `&titles=${encodeURIComponent(title)}`;
        const json = await this._getJson(url, this._cancellable);
        const extract = json?.query?.pages?.[0]?.extract;
        return extract ? splitArticle(extract, ARTICLE_CHARS) : null;
    }

    async fetchImage(url) {
        if (!url?.startsWith('https://'))
            return null;
        const {status, bytes} = await this._get(url, this._cancellable);
        return status === Soup.Status.OK ? bytes : null;
    }

    async _dictionary(term, lang, commonOnly, cancellable) {
        // Wiktionary's definition API is English-only.
        if (lang !== 'en')
            return null;

        let entries = null;
        let word = term;
        for (const candidate of new Set([term, term.toLowerCase()])) {
            // eslint-disable-next-line no-await-in-loop
            const json = await this._getJson(
                `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(candidate)}`,
                cancellable);
            entries = json ? parseDefinitions(json) : null;
            if (entries) {
                word = candidate;
                break;
            }
        }
        if (!entries || (commonOnly && !isCommonWord(entries)))
            return null;

        const parts = [...new Set(entries.map(e => e.partOfSpeech.toLowerCase()))];
        return {
            kind: 'dictionary',
            source: 'Wiktionary',
            title: word,
            subtitle: parts.join(' · '),
            summary: entries[0].definitions[0].text,
            entries,
            url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
        };
    }

    async _wikipediaTitle(term, lang, cancellable) {
        const json = await this._getJson(
            `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(term)}&limit=5`,
            cancellable);
        const page = pickExactTitle(json?.pages ?? [], term);
        return page ? this._summary(page.key, lang, cancellable) : null;
    }

    async _wikipediaSearch(term, lang, cancellable) {
        const json = await this._getJson(
            `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(term)}&limit=3`,
            cancellable);
        const page = (json?.pages ?? []).find(p => isRelevant(p, term));
        return page ? this._summary(page.key, lang, cancellable) : null;
    }

    async _summary(key, lang, cancellable) {
        const json = await this._getJson(
            `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`,
            cancellable);
        // Disambiguation pages ("Mercury may refer to…") make poor answers.
        if (!json?.extract || json.type === 'disambiguation')
            return null;
        return {
            kind: 'wikipedia',
            source: 'Wikipedia',
            lang,
            title: json.title,
            subtitle: json.description ?? '',
            summary: json.extract,
            thumbnail: json.thumbnail?.source ?? null,
            url: json.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(key)}`,
        };
    }

    async _getJson(url, cancellable) {
        const {status, bytes} = await this._get(url, cancellable);
        if (status === Soup.Status.NOT_FOUND)
            return null;
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status}`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    _get(url, cancellable) {
        if (!this._session)
            return Promise.reject(new Error('answers service destroyed'));
        const message = Soup.Message.new('GET', url);
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        resolve({status: message.get_status(), bytes});
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
