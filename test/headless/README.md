# Headless test harness

Runs Search Beam in a throwaway GNOME Shell (no logout needed) and checks
open/close, clearing the search, focus return, launching results, Activities
still working, work-area clamping, blur, disable-while-open, the settings window
and the top-bar button.

```sh
make pack                      # from the repo root
test/headless/run.sh &         # start the isolated shell
test/headless/suite.sh         # 49 checks; screenshots land in shots/
```

Use a fresh shell for each suite run (the checks assume the settings `run.sh`
seeds). To try another screen size, start it with
`SB_MONITOR=1366x768 test/headless/run.sh`.

Stopping it: wait until `/run/user/$UID/gnome-shell-disable-extensions` is
gone (up to 60s after start), then kill the `gnome-shell --headless` process.
That file is shared with your real session. If it's left behind and the real
shell crashes, GNOME disables all your extensions.

The test shell also registers with logind for your real login session.
`inner.sh` turns off its lock screen and idle timer so it can never mark your
session as locked.
