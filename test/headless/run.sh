#!/bin/bash
# Starts an isolated, headless GNOME Shell with Search Beam (from build/) and
# the test helper. Your real session and settings are not touched; all state
# lives under this directory. Run `make pack` first, then in another terminal
# run ./suite.sh. Stop the shell only after the 60s startup window (see README).
S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$S/../.." && pwd)"
rm -rf "$S/data" "$S/config" "$S/cache" "$S/state" "$S/bus" "$S/shell.log"
mkdir -p "$S/data/gnome-shell/extensions/search-beam@kingsleycj" "$S/data/gnome-shell/extensions/unsafe-helper@test" "$S/shots"
cp "$S/helper/"* "$S/data/gnome-shell/extensions/unsafe-helper@test/"
unzip -q -o "$ROOT/build/search-beam@kingsleycj.shell-extension.zip" -d "$S/data/gnome-shell/extensions/search-beam@kingsleycj"
glib-compile-schemas "$S/data/gnome-shell/extensions/search-beam@kingsleycj/schemas"
export XDG_CONFIG_HOME=$S/config XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_STATE_HOME=$S/state
unset DISPLAY WAYLAND_DISPLAY
exec dbus-run-session -- "$S/inner.sh" "$S"
