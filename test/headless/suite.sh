#!/bin/bash
# Behaviour checks for Search Beam. Start ./run.sh first (needs a fresh shell:
# the checks assume the settings run.sh seeds). Prints PASS/FAIL per check.
S="$(cd "$(dirname "$0")" && pwd)"
UUID=search-beam@kingsleycj.github.io

ev() { "$S/ev.sh" "$1"; }
field() { "$S/ev.sh" 'JSON.stringify(sbTest.popup())' | python3 "$S/field.py" "$1"; }
check() { # name, field, expected
  local got; got=$(field "$2"); if [[ "$got" == "$3" ]]; then echo "PASS  $1 ($got)"; else echo "FAIL  $1 (got $got, want $3)"; fi; }
setting() { DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" XDG_CONFIG_HOME=$S/config gsettings --schemadir "$S/data/gnome-shell/extensions/$UUID/schemas" set org.gnome.shell.extensions.search-beam "$@"; }
open_popup() { ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6; }
# popup-relative point: px py (offsets from the popup's top-left)
at() { local x y; x=$(field x); y=$(field y); echo "$((x + $1)) $((y + $2))"; }

for i in $(seq 60); do [ -s $S/bus ] && timeout 3 "$S/ev.sh" 'globalThis.sbTest ? "ready" : "no"' 2>/dev/null | grep -q ready && break; sleep 1; done
sleep 2
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" WAYLAND_DISPLAY=search-beam-test GDK_BACKEND=wayland XDG_CONFIG_HOME=$S/config XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache gjs -m $S/testwin.js > $S/testwin.log 2>&1 &
TESTWIN=$!
cleanup() {
  kill $TESTWIN 2>/dev/null
  pkill -f "[g]nome-tweaks" 2>/dev/null
  setting blur-background false 2>/dev/null; setting show-panel-icon false 2>/dev/null; setting scale-height 0.01 2>/dev/null; setting answers-enabled false 2>/dev/null; setting show-preview true 2>/dev/null; setting scale-width 0.18 2>/dev/null
}
trap cleanup EXIT
sleep 3
echo "ext: $(ev 'JSON.stringify(sbTest.ext())')"
check "test window focused at start" focusWindow '"TestWindow"'

echo "== 1. shortcut opens popup"
open_popup
check "popup visible" visible true
check "entry moved into popup" entryParent '"St_BoxLayout:searchBeamBox"'
check "window focus released" focusWindow null
check "search box has focus" focusInPopup true
"$S/shot.sh" 01-compact >/dev/null

echo "== 2. typing shows results"
ev 'sbTest.type("sett")' >/dev/null; sleep 1.5
check "search active" searchActive true
check "expanded height" h 405
"$S/shot.sh" 02-results >/dev/null

echo "== 3. clearing the search keeps the popup open"
set -- $(at $(( $(field w) - 34 )) 31)
ev "sbTest.click($1, $2)" >/dev/null; sleep 0.8
check "clear icon: still open" visible true
check "clear icon: text cleared" text '""'
check "clear icon: search box keeps focus" focusInPopup true
ev 'sbTest.type(" ")' >/dev/null; sleep 0.6
check "lone space: still open" visible true
set -- $(at 33 31)
ev "sbTest.click($1, $2)" >/dev/null; sleep 0.8
check "click magnifier on empty box: still open" visible true
check "click magnifier: search box keeps focus" focusInPopup true

echo "== 4. Esc closes and returns focus"
ev 'sbTest.chord("Escape")' >/dev/null; sleep 1
check "popup hidden" visible false
check "entry back in overview" entryParent '"St_Bin:null"'
check "controller back in overview" controllerParent '"controls-manager"'
check "search text cleared" text '""'
check "overview methods restored" toggleOwn false
check "focus returned to window" focusWindow '"TestWindow"'

echo "== 5. shortcut toggles closed"
open_popup
check "opened" visible true
ev 'sbTest.chord("Alt_L","space")' >/dev/null; sleep 0.6
check "closed again" visible false
check "focus returned to window" focusWindow '"TestWindow"'

echo "== 6. Super closes popup, keeps Activities closed, returns focus"
open_popup
ev 'sbTest.chord("Super_L")' >/dev/null; sleep 1
check "popup hidden" visible false
check "overview not shown" overview false
check "focus returned to window" focusWindow '"TestWindow"'

echo "== 7. clicks inside keep it open, outside close it"
open_popup
ev 'sbTest.type("te")' >/dev/null; sleep 1
ev 'sbTest.click(900, 370)' >/dev/null; sleep 1
check "click inside keeps it open" visible true
ev 'sbTest.click(100, 900)' >/dev/null; sleep 1
check "click on desktop closes it" visible false
check "entry back in overview" entryParent '"St_Bin:null"'
check "focus returned to window" focusWindow '"TestWindow"'

echo "== 8. tall popup stays clear of the top bar"
setting scale-height 1.0; open_popup
ev 'sbTest.type("sett")' >/dev/null; sleep 1
check "inside work area" insideWorkArea true
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
setting scale-height 0.01

echo "== 9. Enter launches the top result, closes, no Activities"
open_popup
ev 'sbTest.type("tweaks")' >/dev/null; sleep 1.5
ev 'sbTest.chord("Return")' >/dev/null; sleep 0.4
check "popup hidden" visible false
check "overview not shown" overview false
check "overview methods restored" toggleOwn false
for i in $(seq 10); do [[ "$(field focusWindow)" == '"GNOME Tweaks"' ]] && break; sleep 1; done
check "launched app gets focus (not the old window)" focusWindow '"GNOME Tweaks"'

echo "== 10. Activities search still works after"
ev 'Main.overview.show(); "ok"' >/dev/null; sleep 1.5
ev 'sbTest.type("sett")' >/dev/null; sleep 1.5
check "overview shown" overview true
check "overview search active" searchActive true
check "entry in overview" entryParent '"St_Bin:null"'
"$S/shot.sh" 10-overview-search >/dev/null
ev 'Main.overview.hide(); "ok"' >/dev/null; sleep 1.5
check "overview hidden" overview false

echo "== 11. blur on"
setting blur-background true
open_popup
ev 'sbTest.type("sett")' >/dev/null; sleep 1.5
"$S/shot.sh" 11-blur >/dev/null
check "popup visible with blur" visible true

echo "== 12. disable while open restores everything"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" gnome-extensions disable $UUID; sleep 1
check "entry back in overview" entryParent '"St_Bin:null"'
check "controller back in overview" controllerParent '"controls-manager"'
check "overview methods restored" toggleOwn false
check "popup actor removed" exists false
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" gnome-extensions enable $UUID; sleep 1
open_popup
check "re-enabled and opens" visible true
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
setting blur-background false

echo "== 13. top bar button"
setting show-panel-icon true; sleep 1
XY=$("$S/ev.sh" "const b = Main.panel.statusArea['$UUID']; const [x, y] = b.get_transformed_position(); JSON.stringify([Math.round(x + b.width / 2), Math.round(y + b.height / 2)])" | python3 -c "import sys,ast,json; r=sys.stdin.read(); print(' '.join(map(str, json.loads(json.loads(ast.literal_eval(r[r.index(chr(39)):r.rindex(chr(39))+1]))))))")
set -- $XY
ev "sbTest.click($1, $2)" >/dev/null; sleep 1
check "click opens popup" visible true
ev "sbTest.click($1, $2)" >/dev/null; sleep 1
check "second click closes it" visible false
ev "sbTest.press($1, $2)" >/dev/null; sleep 0.4; ev 'sbTest.release()' >/dev/null; sleep 1
check "slow click opens popup" visible true
ev "sbTest.press($1, $2)" >/dev/null; sleep 0.4; ev 'sbTest.release()' >/dev/null; sleep 1
check "slow click closes it" visible false

echo "== 14. online answers (needs internet)"
waitfor() { # field expected [seconds]
  for i in $(seq $(( ${3:-10} * 4 ))); do [[ "$(field "$1")" == "$2" ]] && return 0; sleep 0.25; done; return 1; }
online=1
for u in https://en.wiktionary.org/api/rest_v1/page/definition/serendipity https://en.wikipedia.org/api/rest_v1/page/summary/Paris; do
  curl -s -o /dev/null --max-time 8 -A "SearchBeam-tests" -w '%{http_code}' "$u" | grep -q 200 || online=0
done
if [ $online = 0 ]; then
  echo "SKIP  online answers: Wikimedia isn't reachable from this machine right now"
else
setting show-panel-icon false
setting answers-enabled true
open_popup
ev 'sbTest.type("serendipity")' >/dev/null; waitfor cardVisible true 12
check "word: definition card appears" cardVisible true
check "word: from Wiktionary" cardSource '"Wiktionary"'
check "word: right entry" cardTitle '"serendipity"'
"$S/shot.sh" 14-answer-word >/dev/null
ev 'sbTest.chord("Control_L", "Return")' >/dev/null; sleep 0.8
check "Ctrl+Enter opens the reader" readerVisible true
check "reader replaces the results" controllerVisible false
check "search text kept while reading" text '"serendipity"'
ev 'sbTest.chord("Return")' >/dev/null; sleep 0.8
check "Enter in the reader doesn't launch a result" visible true
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
check "Esc closes the reader" readerVisible false
check "Esc keeps the popup open" visible true
check "card is back" cardVisible true
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
check "second Esc closes the popup" visible false

open_popup
ev 'sbTest.type("serendipity")' >/dev/null; waitfor cardVisible true 12
ev 'sbTest.chord("Tab")' >/dev/null; sleep 0.6
check "a result has keyboard focus" focusOnResult true
ev 'sbTest.chord("Control_L", "Return")' >/dev/null; sleep 0.8
check "Ctrl+Enter with a result focused opens the reader" readerVisible true
check "…and keeps the popup open" visible true
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
ev 'sbTest.chord("Tab")' >/dev/null; sleep 0.6
set -- $(field cardX) $(field cardY)
ev "sbTest.click($1, $2)" >/dev/null; sleep 0.8
check "clicking the card with a result focused opens the reader" readerVisible true
check "…and keeps the popup open" visible true
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.3; ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

open_popup
ev 'sbTest.type("sett")' >/dev/null; sleep 3
check "typing an app's name (sett → Settings): no card" cardVisible false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

open_popup
ev 'sbTest.type("Paris")' >/dev/null; waitfor cardVisible true 12
check "name: Wikipedia card appears" cardSource '"Wikipedia"'
check "name: right article" cardTitle '"Paris"'
waitfor cardThumb true 10
check "name: thumbnail loads" cardThumb true
"$S/shot.sh" 14-answer-name >/dev/null
set -- $(field cardX) $(field cardY)
ev "sbTest.click($1, $2)" >/dev/null; sleep 0.5
check "clicking the card opens the reader" readerVisible true
for i in $(seq 40); do [ "$(field readerBlocks)" -gt 5 ] 2>/dev/null && break; sleep 0.25; done
echo "reader blocks after load: $(field readerBlocks)"
ev 'sbTest.chord("Page_Down")' >/dev/null; sleep 0.4
check "Page Down scrolls the article" readerScrolled true
"$S/shot.sh" 14-reader >/dev/null
ev 'sbTest.type("x")' >/dev/null; sleep 0.5
check "typing closes the reader" readerVisible false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

open_popup
ev 'sbTest.type("firef")' >/dev/null; sleep 3
check "partial app name: no card" cardVisible false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
open_popup
ev 'sbTest.type("5 km in miles")' >/dev/null; sleep 3
check "conversion: no card (Calculator's job)" cardVisible false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

fi
setting answers-enabled false
open_popup
ev 'sbTest.type("serendipity")' >/dev/null; sleep 3
check "answers off: no card" cardVisible false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

echo "== 15. preview panel"
open_popup
ev 'sbTest.type("sett")' >/dev/null; waitfor previewVisible true 5
check "preview shows the top result" previewVisible true
check "top app result previewed" previewTitle '"Settings"'
check "apps are labelled as applications" previewType '"Application"'
"$S/shot.sh" 15-preview-app >/dev/null
before=$(field previewTitle)
ev 'sbTest.chord("Tab")' >/dev/null; sleep 0.6
after=$(field previewTitle)
if [[ "$after" != "$before" && "$after" != null ]]; then echo "PASS  Tab moves the preview to the next result ($after)"; else echo "FAIL  Tab moves the preview to the next result (before $before, after $after)"; fi
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

open_popup
ev 'sbTest.type("beamtest")' >/dev/null; waitfor previewTitle '"beamtest-notes.txt"' 5
check "file result previewed" previewTitle '"beamtest-notes.txt"'
waitfor previewDetailKeys '"Where,Size,Modified"' 5
check "file details shown" previewDetailKeys '"Where,Size,Modified"'
check "text file snippet shown" previewSnippet '"Search Beam preview test\nsecond line"'
"$S/shot.sh" 15-preview-file >/dev/null
xy=$("$S/ev.sh" 'JSON.stringify(sbTest.resultCenters().find(r => r.name === "beamtest-image.png"))' | python3 -c "import sys,ast,json; r=sys.stdin.read(); d=json.loads(json.loads(ast.literal_eval(r[r.index(chr(39)):r.rindex(chr(39))+1]))); print(d['x'], d['y'])")
set -- $xy
ev "sbTest.move($1, $2)" >/dev/null; waitfor previewTitle '"beamtest-image.png"' 3
check "pointing at a result previews it" previewTitle '"beamtest-image.png"'
waitfor previewImage true 3
check "image file shows the picture" previewImage true
check "provider column folded while the panel shows" boxPreviewing true
"$S/shot.sh" 15-preview-image >/dev/null
set -- $(at 120 31)
ev "sbTest.move($1, $2)" >/dev/null; waitfor previewTitle '"beamtest-notes.txt"' 3
check "moving off the results previews the top result again" previewTitle '"beamtest-notes.txt"'
for i in $(seq 8); do ev 'sbTest.chord("BackSpace")' >/dev/null; done
ev 'sbTest.type("zqzqzq")' >/dev/null; sleep 1
check "preview hides when nothing matches" previewVisible false
check "provider column unfolded when the panel is hidden" boxPreviewing false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6

setting show-preview false
open_popup
ev 'sbTest.type("sett")' >/dev/null; sleep 1
check "preview off: no panel" previewVisible false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
setting show-preview true
setting scale-width 0.0
open_popup
ev 'sbTest.type("sett")' >/dev/null; sleep 1
check "narrow popup (600px): no panel" previewVisible false
ev 'sbTest.chord("Escape")' >/dev/null; sleep 0.6
setting scale-width 0.18

echo "== 16. settings window opens"
DBUS_SESSION_BUS_ADDRESS="$(cat $S/bus)" WAYLAND_DISPLAY=search-beam-test XDG_CONFIG_HOME=$S/config XDG_DATA_HOME=$S/data gnome-extensions prefs $UUID; sleep 4
check "settings window focused" focusWindow '"Search Beam"'

echo "== log check"
grep -n "JS ERROR\|search-beam.*\(Error\|error\)\|too much recursion" "$S/shell.log" | head -10 || true
echo "JS errors: $(grep -c 'JS ERROR' "$S/shell.log")"
