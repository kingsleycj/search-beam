// SPDX-License-Identifier: GPL-2.0-or-later
//
// File details for the preview panel: name, kind, location, size, date,
// thumbnail and a text snippet. Local files only; nothing leaves the machine.
// No GNOME Shell imports, so it can be unit-tested with plain gjs.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ATTRIBUTES = [
    'standard::display-name', 'standard::content-type', 'standard::type',
    'standard::size', 'standard::icon', 'time::modified',
    'thumbnail::path', 'thumbnail::is-valid',
].join(',');

// Only peek into reasonably small files, and only their start.
const SNIPPET_MAX_FILE = 512 * 1024;
const SNIPPET_BYTES = 4096;
const SNIPPET_LINES = 14;
const SNIPPET_LINE_CHARS = 120;
// Show an image file itself (when no thumbnail exists) only if it's small.
const IMAGE_MAX_FILE = 20 * 1024 * 1024;

export function snippetFrom(text, maxLines, maxLineChars) {
    if (text.includes('\u0000'))
        return null;
    const lines = [];
    let blank = false;
    let count = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        // Collapse runs of blank lines into one; only text lines count
        // towards maxLines.
        if (!line) {
            if (!blank && lines.length)
                lines.push('');
            blank = true;
            continue;
        }
        blank = false;
        const chars = Array.from(line);
        lines.push(chars.length > maxLineChars
            ? `${chars.slice(0, maxLineChars - 1).join('')}…`
            : line);
        if (++count >= maxLines)
            break;
    }
    while (lines.length && !lines[lines.length - 1])
        lines.pop();
    return lines.length ? lines.join('\n') : null;
}

export function formatLocation(dirPath, home) {
    if (dirPath === home)
        return '~';
    if (dirPath.startsWith(`${home}/`))
        return `~${dirPath.slice(home.length)}`;
    return dirPath;
}

export function isTextType(contentType) {
    return Gio.content_type_is_a(contentType, 'text/plain') ||
        contentType.startsWith('text/');
}

function queryInfo(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async(ATTRIBUTES, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (f, result) => {
                try {
                    resolve(f.query_info_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function readStart(file, cancellable) {
    const stream = await new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (f, result) => {
            try {
                resolve(f.read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    try {
        const bytes = await new Promise((resolve, reject) => {
            stream.read_bytes_async(SNIPPET_BYTES, GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
                try {
                    resolve(s.read_bytes_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        return new TextDecoder('utf-8', {fatal: false}).decode(bytes.get_data() ?? new Uint8Array());
    } finally {
        stream.close(null);
    }
}

// Resolves to a description, or null if the file can't be read (deleted,
// no permission, not a local file). Rejects only on cancellation.
export async function describeFile(uri, cancellable) {
    const file = Gio.File.new_for_uri(uri);
    let info;
    try {
        info = await queryInfo(file, cancellable);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return null;
    }

    const contentType = info.get_content_type() ?? 'application/octet-stream';
    const isFolder = info.get_file_type() === Gio.FileType.DIRECTORY;
    const size = info.get_size();
    const details = [];

    const parent = file.get_parent()?.get_path();
    if (parent)
        details.push(['Where', formatLocation(parent, GLib.get_home_dir())]);
    if (!isFolder)
        details.push(['Size', GLib.format_size(size)]);
    const modified = info.get_modification_date_time();
    if (modified)
        details.push(['Modified', modified.to_local().format('%e %b %Y, %H:%M').trim()]);

    const thumbnail = info.get_attribute_boolean('thumbnail::is-valid')
        ? info.get_attribute_byte_string('thumbnail::path')
        : null;
    const isImage = Gio.content_type_is_a(contentType, 'image/*') ||
        contentType.startsWith('image/');

    let snippet = null;
    if (!isFolder && size > 0 && size <= SNIPPET_MAX_FILE && isTextType(contentType)) {
        try {
            snippet = snippetFrom(await readStart(file, cancellable),
                SNIPPET_LINES, SNIPPET_LINE_CHARS);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }
    }

    return {
        kind: 'file',
        title: info.get_display_name(),
        typeLabel: isFolder ? 'Folder' : Gio.content_type_get_description(contentType),
        icon: info.get_icon(),
        image: thumbnail ?? (isImage && file.get_path() && size <= IMAGE_MAX_FILE ? file.get_path() : null),
        details,
        snippet,
    };
}

// Decode an image scaled down to fit size×size and re-encode it as a small
// PNG. The panel shows it from memory (Gio.BytesIcon) rather than by path:
// St caches path-based icons for the whole session, which would keep every
// photo ever previewed in gnome-shell's memory. Resolves to null if the
// format can't be decoded.
export async function loadScaledImage(path, size, cancellable) {
    const file = Gio.File.new_for_path(path);
    try {
        const stream = await new Promise((resolve, reject) => {
            file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (f, result) => {
                try {
                    resolve(f.read_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        const pixbuf = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, size, size, true,
                cancellable, (s, result) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        stream.close(null);
        const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
        return ok ? new GLib.Bytes(buffer) : null;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return null;
    }
}
