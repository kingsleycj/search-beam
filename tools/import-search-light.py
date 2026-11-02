#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Copy your Search Light settings into Search Beam.

Reads /org/gnome/shell/extensions/search-light/ with `dconf` and writes the
matching Search Beam keys. Only keys you actually changed in Search Light are
copied; everything else keeps Search Beam's defaults.

    tools/import-search-light.py --dry-run   # show what would change
    tools/import-search-light.py             # do it
"""

import argparse
import math
import subprocess
import sys

SOURCE = '/org/gnome/shell/extensions/search-light/'
TARGET = '/org/gnome/shell/extensions/search-beam/'

# Keys whose meaning and type are the same in both extensions.
SAME = [
    'shortcut-search', 'secondary-shortcut-search',
    'background-color', 'text-color', 'border-color', 'border-thickness',
    'scale-width', 'scale-height',
    'preferred-monitor', 'popup-at-cursor-monitor',
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


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true', help='print the changes without writing them')
    args = parser.parse_args()

    changes = {}
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

    if not changes:
        print('No Search Light settings found, nothing to import.')
        return 0

    for key, value in changes.items():
        print(f'{key} = {value}')
        if not args.dry_run:
            subprocess.run(['dconf', 'write', TARGET + key, value], check=True)

    if args.dry_run:
        print('\n(dry run: nothing was written)')
    else:
        print(f'\nImported {len(changes)} settings into Search Beam.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
