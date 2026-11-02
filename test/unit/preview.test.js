// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for previewInfo.js (file details for the preview panel).
// Run from the repo root:  gjs -m test/unit/preview.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import * as P from '../../previewInfo.js';

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
    pending.push((async () => {
        try {
            await fn();
            passed++;
            print(`PASS  ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL  ${name}: ${e.message}`);
        }
    })());
}

function eq(actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`expected ${b}, got ${a}`);
}

// A scratch folder with a few files to describe.
const dir = GLib.Dir.make_tmp('search-beam-preview-XXXXXX');
const write = (name, bytes) => {
    const path = GLib.build_filenamev([dir, name]);
    GLib.file_set_contents(path, bytes);
    return Gio.File.new_for_path(path).get_uri();
};
const TEXT = 'first line\nsecond line\n\nthird line\n';
const textUri = write('notes.txt', TEXT);
const binaryUri = write('blob.bin', new Uint8Array([0, 159, 146, 150, 0, 1, 2]));
GLib.mkdir_with_parents(GLib.build_filenamev([dir, 'folder']), 0o755);
const folderUri = Gio.File.new_for_path(GLib.build_filenamev([dir, 'folder'])).get_uri();

// --- pure helpers -----------------------------------------------------------

test('snippetFrom keeps the first lines, trimmed', () => {
    eq(P.snippetFrom('a\nb\n\n\nc\nd\ne', 3, 100), 'a\nb\n\nc');
});

test('snippetFrom shortens long lines', () => {
    eq(P.snippetFrom('abcdefghij', 5, 6), 'abcde…');
});

test('snippetFrom rejects binary content', () => {
    eq(P.snippetFrom('PNG\u0000\u0001data', 5, 100), null);
});

test('formatLocation shortens the home folder to ~', () => {
    eq(P.formatLocation('/home/ada/Documents', '/home/ada'), '~/Documents');
    eq(P.formatLocation('/home/ada', '/home/ada'), '~');
    eq(P.formatLocation('/etc/xdg', '/home/ada'), '/etc/xdg');
    eq(P.formatLocation('/home/adam/x', '/home/ada'), '/home/adam/x');
});

test('isTextType accepts text and source code, rejects images', () => {
    eq(P.isTextType('text/plain'), true);
    eq(P.isTextType('text/markdown'), true);
    eq(P.isTextType('application/json'), true);
    eq(P.isTextType('image/png'), false);
});

// --- describeFile -------------------------------------------------------------

test('describeFile reads a text file: name, kind, place, size, snippet', async () => {
    const info = await P.describeFile(textUri, null);
    eq(info.title, 'notes.txt');
    eq(info.snippet, 'first line\nsecond line\n\nthird line');
    eq(info.details.map(d => d[0]), ['Where', 'Size', 'Modified']);
    eq(info.details[1][1], GLib.format_size(TEXT.length));
    if (!info.typeLabel)
        throw new Error('missing type label');
});

test('describeFile gives folders no size or snippet', async () => {
    const info = await P.describeFile(folderUri, null);
    eq(info.title, 'folder');
    eq(info.typeLabel, 'Folder');
    eq(info.details.map(d => d[0]), ['Where', 'Modified']);
    eq(info.snippet, null);
});

test('describeFile shows no snippet for binary files', async () => {
    const info = await P.describeFile(binaryUri, null);
    eq(info.snippet, null);
});

test('describeFile returns null for a missing file', async () => {
    eq(await P.describeFile(`${textUri}.missing`, null), null);
});

const loop = new GLib.MainLoop(null, false);
Promise.all(pending).then(() => {
    print(`\n${passed} passed, ${failed} failed`);
    loop.quit();
});
loop.run();
GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(dir)}`);
if (failed)
    System.exit(1);
