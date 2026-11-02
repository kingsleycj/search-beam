#!/bin/bash
# Runs inside the private D-Bus session started by run.sh: seeds the throwaway
# settings, then starts the headless shell. Lock screen and idle are turned
# off because the shell registers with logind for your real session. The
# Search Beam values match the expectations in suite.sh (Alt+Space, 405px tall).
S="$1"
echo "$DBUS_SESSION_BUS_ADDRESS" > "$S/bus"
SB=$S/data/gnome-shell/extensions/search-beam@kingsleycj.github.io/schemas
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['unsafe-helper@test','search-beam@kingsleycj.github.io']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.desktop.search-providers disable-external true
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.wm.keybindings activate-window-menu "['<Super>space']"
gsettings --schemadir $SB set org.gnome.shell.extensions.search-beam shortcut-search "['<Alt>space']"
gsettings --schemadir $SB set org.gnome.shell.extensions.search-beam background-color "(0.06, 0.0546, 0.0546, 0.66333335638046265)"
gsettings --schemadir $SB set org.gnome.shell.extensions.search-beam border-radius 20
gsettings --schemadir $SB set org.gnome.shell.extensions.search-beam entry-font-size 16
gsettings --schemadir $SB set org.gnome.shell.extensions.search-beam scale-width 0.18
gsettings --schemadir $SB set org.gnome.shell.extensions.search-beam scale-height 0.01
exec gnome-shell --headless --virtual-monitor "${SB_MONITOR:-1920x1080}" --wayland --no-x11 --wayland-display search-beam-test --force-animations > "$S/shell.log" 2>&1
