// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for the pure parts of answers.js (no network, no shell).
// Run from the repo root:  gjs -m test/unit/answers.test.js

import System from 'system';

import * as A from '../../answers.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        print(`PASS  ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL  ${name}: ${e.message}`);
    }
}

function eq(actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`expected ${b}, got ${a}`);
}

// --- planLookup: when to look something up, and where -------------------

test('too-short queries are not looked up', () => {
    eq(A.planLookup('se'), null);
});

test('queries starting with a number are left to Calculator', () => {
    eq(A.planLookup('5 km in miles'), null);
});

test('arithmetic is left to Calculator', () => {
    eq(A.planLookup('12*7'), null);
    eq(A.planLookup('pi/2'), null);
});

test('a lowercase word tries the dictionary first', () => {
    eq(A.planLookup('serendipity'), {term: 'serendipity', steps: ['dictionary', 'wikipedia-title']});
});

test('a capitalised word tries Wikipedia first', () => {
    eq(A.planLookup('Paris'), {term: 'Paris', steps: ['wikipedia-title', 'dictionary']});
});

test('a phrase searches Wikipedia', () => {
    eq(A.planLookup('capital of nigeria'), {term: 'capital of nigeria', steps: ['wikipedia-search']});
});

test('"define <word>" only uses the dictionary', () => {
    eq(A.planLookup('define Serendipity'), {term: 'Serendipity', steps: ['dictionary']});
});

test('surrounding and repeated spaces are ignored', () => {
    eq(A.planLookup('  capital   of nigeria  '), {term: 'capital of nigeria', steps: ['wikipedia-search']});
});

// --- htmlToText -----------------------------------------------------------

test('htmlToText strips tags and decodes entities', () => {
    eq(A.htmlToText('The <a rel="mw:WikiLink" href="/wiki/x">phenomenon</a> of &amp; &lt;b&gt; &quot;q&quot; it&#39;s'),
        'The phenomenon of & <b> "q" it\'s');
});

test('htmlToText decodes numeric entities and non-breaking spaces', () => {
    eq(A.htmlToText('a&#8212;b&#x2014;c&nbsp;d'), 'a—b—c d');
});

test('htmlToText collapses whitespace', () => {
    eq(A.htmlToText('  one\n   two\t three  '), 'one two three');
});

// --- parseDefinitions -----------------------------------------------------

const WIKTIONARY_SAMPLE = {
    en: [
        {
            partOfSpeech: 'Noun',
            language: 'English',
            definitions: [
                {definition: 'A <b>happy</b> accident.', examples: ['<i>Pure</i> serendipity.']},
                {definition: ''},
                {definition: 'Luck.', parsedExamples: [{example: 'By <i>sheer</i> luck.'}]},
            ],
        },
        {partOfSpeech: 'Verb', language: 'English', definitions: []},
    ],
    fr: [{partOfSpeech: 'Nom', language: 'French', definitions: [{definition: 'Hasard.'}]}],
};

test('parseDefinitions keeps English senses with text, cleaned up', () => {
    eq(A.parseDefinitions(WIKTIONARY_SAMPLE), [
        {
            partOfSpeech: 'Noun',
            definitions: [
                {text: 'A happy accident.', examples: ['Pure serendipity.']},
                {text: 'Luck.', examples: ['By sheer luck.']},
            ],
        },
    ]);
});

test('parseDefinitions puts symbols, letters and abbreviations after real senses', () => {
    const json = {
        en: [
            {partOfSpeech: 'Symbol', definitions: [{definition: 'ISO code.'}]},
            {partOfSpeech: 'Verb', definitions: [{definition: 'To move fast.'}]},
            {partOfSpeech: 'Abbreviation', definitions: [{definition: 'Short for x.'}]},
            {partOfSpeech: 'Noun', definitions: [{definition: 'A jog.'}]},
        ],
    };
    eq(A.parseDefinitions(json).map(e => e.partOfSpeech), ['Verb', 'Noun', 'Symbol', 'Abbreviation']);
});

test('parseDefinitions returns null without English entries', () => {
    eq(A.parseDefinitions({fr: WIKTIONARY_SAMPLE.fr}), null);
});

test('isCommonWord is false when every entry is a proper noun', () => {
    eq(A.isCommonWord([{partOfSpeech: 'Proper noun', definitions: [{text: 'x', examples: []}]}]), false);
    eq(A.isCommonWord([{partOfSpeech: 'Noun', definitions: [{text: 'x', examples: []}]}]), true);
});

// --- choosing a Wikipedia page --------------------------------------------

test('pickExactTitle matches regardless of case and underscores', () => {
    const pages = [{key: 'New_York_City', title: 'New York City'}, {key: 'Paris', title: 'Paris'}];
    eq(A.pickExactTitle(pages, 'paris')?.key, 'Paris');
    eq(A.pickExactTitle(pages, 'new york city')?.key, 'New_York_City');
});

test('pickExactTitle ignores prefix-only matches', () => {
    eq(A.pickExactTitle([{key: 'Firefox', title: 'Firefox'}], 'firef'), null);
});

test('isRelevant accepts results that share the important words', () => {
    eq(A.isRelevant({title: 'Abuja', description: 'Capital of the Federal Republic of Nigeria'}, 'capital of nigeria'), true);
    eq(A.isRelevant({title: 'Invention of the telephone', description: ''}, 'who invented the telephone'), true);
});

test('isRelevant rejects unrelated results', () => {
    eq(A.isRelevant({title: 'Capital punishment in Nigeria', description: ''}, 'what is love'), false);
});

// --- splitArticle ---------------------------------------------------------

test('splitArticle turns plain-text sections into blocks', () => {
    const text = 'Intro para.\n\nSecond.\n\n\n== History ==\nOld times.\n\n=== Origins ===\nStart.';
    eq(A.splitArticle(text, 10000), {
        blocks: [
            {type: 'text', text: 'Intro para.'},
            {type: 'text', text: 'Second.'},
            {type: 'heading', text: 'History', level: 2},
            {type: 'text', text: 'Old times.'},
            {type: 'heading', text: 'Origins', level: 3},
            {type: 'text', text: 'Start.'},
        ],
        truncated: false,
    });
});

test('splitArticle drops reference sections and empty headings', () => {
    const text = 'Body.\n\n== Empty ==\n\n== See also ==\nList\n\n== References ==\n';
    eq(A.splitArticle(text, 10000), {blocks: [{type: 'text', text: 'Body.'}], truncated: false});
});

test('splitArticle stops at the character budget', () => {
    const result = A.splitArticle('One one one.\n\nTwo two two.\n\nThree three.', 20);
    eq(result.blocks.map(b => b.text), ['One one one.']);
    eq(result.truncated, true);
});

// --- small helpers --------------------------------------------------------

test('normalizeLanguage accepts language codes only', () => {
    eq(A.normalizeLanguage('EN'), 'en');
    eq(A.normalizeLanguage('pt-br'), 'pt-br');
    eq(A.normalizeLanguage('../evil'), 'en');
    eq(A.normalizeLanguage(''), 'en');
});

test('truncate cuts at a word boundary with an ellipsis', () => {
    eq(A.truncate('alpha beta gamma', 12), 'alpha beta…');
    eq(A.truncate('short', 12), 'short');
});

print(`\n${passed} passed, ${failed} failed`);
if (failed)
    System.exit(1);
