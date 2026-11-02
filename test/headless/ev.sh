#!/bin/bash
# usage: ev.sh '<js expression>'
S="$(cd "$(dirname "$0")" && pwd)"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"
