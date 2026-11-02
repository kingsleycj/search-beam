#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Copy your Search Light settings into Search Beam.

Reads /org/gnome/shell/extensions/search-light/ with `dconf` and writes the
matching Search Beam settings through `gsettings`, so every value is checked
against Search Beam's schema. Only keys you actually changed in Search Light
are copied; everything else keeps Search Beam's defaults. Install Search Beam
first (`make install`); you don't need to have logged back in yet.

    tools/import-search-light.py --dry-run   # show what would change
    tools/import-search-light.py             # do it
"""

import argparse
import math
import os
import subprocess
import sys

SOURCE = '/org/gnome/shell/extensions/search-light/'
SCHEMA = 'org.gnome.shell.extensions.search-beam'
UUID = 'search-beam@kingsleycj.github.io'
SCHEMA_DIRS = [
    os.path.expanduser(f'~/.local/share/gnome-shell/extensions/{UUID}/schemas'),
    f'/usr/share/gnome-shell/extensions/{UUID}/schemas',
]

# Keys whose meaning and type are the same in both extensions.
SAME = [
    'shortcut-search', 'secondary-shortcut-search',
    'background-color', 'text-color', 'border-color', 'border-thickness',
    'scale-width', 'scale-height',
    'popup-at-cursor-monitor',
    'blur-background', 'blur-sigma', 'blur-brightness',
    'show-panel-icon', 'use-animations', 'animation-speed',
]

# Search Light stored these as an index into a list; Search Beam stores the
# actual pixel / point value.
RADIUS_PX = [0, 16, 18, 20, 22, 24, 28, 32]
FONT_PT = [0, 16, 18, 20, 22, 24]


def dconf_read(path):
    out = subprocess.run(['dconf', 'read', path], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def from_index(raw, table):
    index = int(math.floor(float(raw)))
    return str(table[max(0, min(index, len(table) - 1))])


def find_schema_dir():
    for d in SCHEMA_DIRS:
        if os.path.exists(os.path.join(d, 'gschemas.compiled')):
            return d
    return None


def gsettings(schema_dir, *args):
    return subprocess.run(['gsettings', '--schemadir', schema_dir, *args],
                          capture_output=True, text=True)


def out_of_range(schema_dir, key, value):
    """Return a reason if value is outside the key's declared range."""
    spec = gsettings(schema_dir, 'range', SCHEMA, key).stdout.split()
    if len(spec) == 4 and spec[0] == 'range':
        lo, hi = float(spec[2]), float(spec[3])
        try:
            v = float(value)
        except ValueError:
            return None
        if not lo <= v <= hi:
            return f'outside Search Beam\'s range {spec[2]}–{spec[3]}'
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true', help='print the changes without writing them')
    args = parser.parse_args()

    schema_dir = find_schema_dir()
    if not schema_dir:
        print('Search Beam is not installed. Run `make install` first.', file=sys.stderr)
        return 1

    changes = {}
    notes = []
    for key in SAME:
        value = dconf_read(SOURCE + key)
        if value:
            changes[key] = value

    radius = dconf_read(SOURCE + 'border-radius')
    if radius:
        changes['border-radius'] = from_index(radius, RADIUS_PX)
    for key in ('font-size', 'entry-font-size'):
        value = dconf_read(SOURCE + key)
        if value:
            changes[key] = from_index(value, FONT_PT)

    # Search Light numbers non-primary monitors in a layout-dependent way, so
    # only "primary" (0) translates directly.
    monitor = dconf_read(SOURCE + 'preferred-monitor')
    if monitor == '0':
        changes['preferred-monitor'] = '0'
    elif monitor:
        notes.append('preferred-monitor: Search Light numbers monitors differently; '
                     'pick the monitor again in Search Beam\'s settings.')

    if not changes and not notes:
        print('No Search Light settings found, nothing to import.')
        return 0

    imported = 0
    for key, value in changes.items():
        reason = out_of_range(schema_dir, key, value)
        if reason:
            notes.append(f'{key} = {value}: skipped, {reason}.')
            continue
        if args.dry_run:
            print(f'{key} = {value}')
            imported += 1
            continue
        result = gsettings(schema_dir, 'set', SCHEMA, key, value)
        if result.returncode == 0:
            print(f'{key} = {value}')
            imported += 1
        else:
            notes.append(f'{key} = {value}: skipped, {result.stderr.strip()}')

    for note in notes:
        print(f'Note: {note}')

    if args.dry_run:
        print(f'\n(dry run: {imported} settings would be imported, nothing was written)')
    else:
        print(f'\nImported {imported} settings into Search Beam.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
