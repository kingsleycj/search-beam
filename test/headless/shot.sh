#!/bin/bash
S="$(cd "$(dirname "$0")" && pwd)"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$S/shots/$1.png"
