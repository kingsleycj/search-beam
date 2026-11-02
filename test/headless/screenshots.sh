#!/bin/bash
# Regenerates docs/*.png from a running headless shell (start ./run.sh first).
# Needs python3-pil for cropping.
S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$S/../.." && pwd)"
ev() { "$S/ev.sh" "$1" >/dev/null; }
val() { "$S/ev.sh" "$1" | python3 -c "import sys,ast,json; r=sys.stdin.read(); print(json.loads(ast.literal_eval(r[r.index(chr(39)):r.rindex(chr(39))+1])))"; }
setting() { DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" XDG_CONFIG_HOME=$S/config gsettings --schemadir "$S/data/gnome-shell/extensions/search-beam@kingsleycj/schemas" set org.gnome.shell.extensions.search-beam "$@"; }
crop() { # name x y w h
  python3 - "$S/shots/$1.png" "$ROOT/docs/$1.png" "$2" "$3" "$4" "$5" <<'PY'
import sys
from PIL import Image
src, dst, x, y, w, h = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:])
Image.open(src).crop((x, y, x + w, y + h)).save(dst, optimize=True)
PY
}

for i in $(seq 60); do [ -s $S/bus ] && timeout 3 "$S/ev.sh" 'globalThis.sbTest ? "ready" : "no"' 2>/dev/null | grep -q ready && break; sleep 1; done
sleep 2
setting animation-speed 0.0
M=48   # margin around the popup
read -r X Y W <<<"$(val 'const m = Main.layoutManager.primaryMonitor; const w = Math.round(600 + m.width / 2 * 0.18); [Math.round(m.x + (m.width - w) / 2), Math.round(m.y + (m.height - 405) / 2), w].join(" ")')"

ev 'sbTest.chord("Alt_L","space")'; sleep 1
"$S/shot.sh" compact >/dev/null; crop compact $((X-M)) $((Y-M)) $((W+2*M)) $((63+2*M))
ev 'sbTest.type("sett")'; sleep 2
"$S/shot.sh" results >/dev/null; crop results $((X-M)) $((Y-M)) $((W+2*M)) $((405+2*M))
ev 'sbTest.chord("Escape")'; sleep 0.5

setting blur-background true
ev 'sbTest.chord("Alt_L","space")'; sleep 1
ev 'sbTest.type("sett")'; sleep 2
"$S/shot.sh" blur >/dev/null; crop blur $((X-M)) $((Y-M)) $((W+2*M)) $((405+2*M))
ev 'sbTest.chord("Escape")'; sleep 0.5
setting blur-background false

DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" WAYLAND_DISPLAY=search-beam-test XDG_CONFIG_HOME=$S/config XDG_DATA_HOME=$S/data gnome-extensions prefs search-beam@kingsleycj; sleep 4
read -r PX PY PW PH <<<"$(val 'const w = global.get_window_actors().map(a => a.meta_window).find(w => w.title === "Search Beam"); const r = w.get_frame_rect(); [r.x, r.y, r.width, r.height].join(" ")')"
"$S/shot.sh" prefs-general >/dev/null; crop prefs-general $((PX-M)) $((PY-M)) $((PW+2*M)) $((PH+2*M))
ev "sbTest.click($((PX+PW/2+64)), $((PY+23)))"; sleep 1
"$S/shot.sh" prefs-appearance >/dev/null; crop prefs-appearance $((PX-M)) $((PY-M)) $((PW+2*M)) $((PH+2*M))
ls -la "$ROOT/docs"
