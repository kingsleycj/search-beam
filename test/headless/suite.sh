#!/bin/bash
S="$(cd "$(dirname "$0")" && pwd)"
ev() { "$S/ev.sh" "$1"; }
field() { "$S/ev.sh" 'JSON.stringify(sbTest.popup())' | python3 "$S/field.py" "$1"; }
check() { # name, field, expected
  local got; got=$(field "$2"); if [[ "$got" == "$3" ]]; then echo "PASS  $1 ($got)"; else echo "FAIL  $1 (got $got, want $3)"; fi; }

for i in $(seq 60); do [ -s $S/bus ] && timeout 3 "$S/ev.sh" 'globalThis.sbTest ? "ready" : "no"' 2>/dev/null | grep -q ready && break; sleep 1; done
sleep 2
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" WAYLAND_DISPLAY=search-beam-test GDK_BACKEND=wayland XDG_CONFIG_HOME=$S/config XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache nohup gjs -m $S/testwin.js > $S/testwin.log 2>&1 &
sleep 3
echo "ext: $(ev 'JSON.stringify(sbTest.ext())')"
check "test window focused at start" focusWindow '"TestWindow"'

echo "== 1. shortcut opens popup"
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 1
check "popup visible" visible true
check "entry moved into popup" entryParent '"St_BoxLayout:searchBeamBox"'
check "window focus released" focusWindow null
field h; "$S/shot.sh" 01-compact >/dev/null

echo "== 2. typing shows results"
ev 'sbTest.type("sett")' >/dev/null; sleep 1.5
check "search active" searchActive true
check "expanded height" h 405
"$S/shot.sh" 02-results >/dev/null

echo "== 3. Esc closes and returns focus"
ev 'sbTest.chord("Escape")' >/dev/null; sleep 1
check "popup hidden" visible false
check "entry back in overview" entryParent '"St_Bin:null"'
check "controller back in overview" controllerParent '"controls-manager"'
check "search text cleared" text '""'
check "overview.toggle restored" toggleOwn false
check "focus returned to window" focusWindow '"TestWindow"'

echo "== 4. shortcut toggles closed"
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
check "opened" visible true
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
check "closed again" visible false
check "focus returned to window" focusWindow '"TestWindow"'

echo "== 5. Super while open closes popup, does not open Activities"
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
ev 'sbTest.chord("Super_L")' >/dev/null; sleep 1
check "popup hidden" visible false
check "overview not shown" overview false

echo "== 6. click outside closes"
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
ev 'sbTest.type("te")' >/dev/null; sleep 1
ev 'sbTest.click(900, 370)' >/dev/null; sleep 1
check "click inside keeps it open" visible true
ev 'sbTest.click(100, 900)' >/dev/null; sleep 1
check "popup hidden" visible false
check "entry back in overview" entryParent '"St_Bin:null"'

echo "== 7. Enter launches the top result, closes, no Activities"
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
ev 'sbTest.type("tweaks")' >/dev/null; sleep 1.5
ev 'sbTest.chord("Return")' >/dev/null; sleep 0.4
check "popup hidden" visible false
check "overview not shown" overview false
check "overview.toggle restored" toggleOwn false
sleep 4; echo "focused window after launch: $(field focusWindow)"

echo "== 8. Activities search still works after"
ev 'imports.ui?.main ?? 0' >/dev/null
ev 'Main.overview.show(); "ok"' >/dev/null; sleep 1.5
ev 'sbTest.type("sett")' >/dev/null; sleep 1.5
check "overview shown" overview true
check "overview search active" searchActive true
"$S/shot.sh" 08-overview-search >/dev/null
ev 'Main.overview.hide(); "ok"' >/dev/null; sleep 1.5
check "overview hidden" overview false

echo "== 9. blur on"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" XDG_CONFIG_HOME=$S/config gsettings --schemadir $S/data/gnome-shell/extensions/search-beam@kingsleycj/schemas set org.gnome.shell.extensions.search-beam blur-background true
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
ev 'sbTest.type("sett")' >/dev/null; sleep 1.5
"$S/shot.sh" 09-blur >/dev/null
check "popup visible with blur" visible true

echo "== 10. disable while open restores everything"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" gnome-extensions disable search-beam@kingsleycj; sleep 1
check "entry back in overview" entryParent '"St_Bin:null"'
check "controller back in overview" controllerParent '"controls-manager"'
check "overview.toggle restored" toggleOwn false
check "popup actor removed" exists false
echo "ext: $(ev 'JSON.stringify(sbTest.ext())')"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" gnome-extensions enable search-beam@kingsleycj; sleep 1
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
check "re-enabled and opens" visible true
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

echo "== 11. settings window opens"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" WAYLAND_DISPLAY=search-beam-test XDG_CONFIG_HOME=$S/config XDG_DATA_HOME=$S/data gnome-extensions prefs search-beam@kingsleycj; sleep 4
"$S/shot.sh" 11-prefs >/dev/null
echo "focused: $(field focusWindow)"

echo "== 12. top bar button"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" XDG_CONFIG_HOME=$S/config gsettings --schemadir $S/data/gnome-shell/extensions/search-beam@kingsleycj/schemas set org.gnome.shell.extensions.search-beam show-panel-icon true; sleep 1
XY=$("$S/ev.sh" 'const b = Main.panel.statusArea["search-beam@kingsleycj"]; const [x, y] = b.get_transformed_position(); JSON.stringify([Math.round(x + b.width / 2), Math.round(y + b.height / 2)])' | python3 -c "import sys,ast,json; r=sys.stdin.read(); print(' '.join(map(str, json.loads(json.loads(ast.literal_eval(r[r.index(chr(39)):r.rindex(chr(39))+1]))))))")
echo "button at $XY"; set -- $XY
ev "sbTest.click($1, $2)" >/dev/null; sleep 1
check "click opens popup" visible true
ev "sbTest.click($1, $2)" >/dev/null; sleep 1
check "second click closes it" visible false

echo "== log check"
grep -n "JS ERROR\|search-beam.*\(Error\|error\)\|too much recursion" "$S/shell.log" | head -10 || true
grep -c "JS ERROR" "$S/shell.log"
