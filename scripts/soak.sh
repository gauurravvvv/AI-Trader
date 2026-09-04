#!/usr/bin/env bash
#
# Phase 9: the 30-day soak.
#
# Runs the daemon unattended, restarts it if it dies, and writes a dated log.
# This is the only phase that cannot be written faster — it is wall-clock — and
# until it finishes there is no track record, only a system that works.
#
#   scripts/soak.sh                 # SHADOW: decides and logs, places nothing
#   scripts/soak.sh --autonomy AUTO # places simulated orders
#   scripts/soak.sh --days 7        # shorter run
#
# Stop it with:  kill "$(cat .soak/soak.pid)"
# Watch it with: tail -f .soak/soak.log
# Read results:  pnpm report

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DAYS=30
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

DIR=.soak
mkdir -p "$DIR"
LOG="$DIR/soak.log"
PIDFILE="$DIR/soak.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "A soak is already running (pid $(cat "$PIDFILE")). Stop it first." >&2
  exit 1
fi

echo $$ > "$PIDFILE"
# Deadline in seconds since epoch. Computed once, so a restart does not extend
# the run — the point is a fixed window, not a fixed number of restarts.
DEADLINE=$(( $(date +%s) + DAYS * 86400 ))

CHILD=""
STOPPING=0

# Kill the daemon too. Without this, stopping the soak leaves an orphaned
# process still trading and still spending credit, and the next soak refuses to
# start because the port is taken.
cleanup() {
  # The trap is on INT, TERM and EXIT, so a signalled stop would otherwise run
  # this twice and log two "stopped" lines for one stop.
  [ "$STOPPING" -eq 1 ] && return
  STOPPING=1
  if [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null; then
    kill -INT "$CHILD" 2>/dev/null
    # Give the daemon its clean shutdown — it drains the notifier and closes
    # the database — then insist.
    for _ in $(seq 1 20); do
      kill -0 "$CHILD" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$CHILD" 2>/dev/null && kill -KILL "$CHILD" 2>/dev/null
  fi
  rm -f "$PIDFILE"
  echo "[soak] stopped $(date -u +%FT%TZ)" >> "$LOG"
}
trap cleanup EXIT INT TERM

{
  echo "[soak] started $(date -u +%FT%TZ) · ${DAYS}d · args: ${EXTRA[*]:-none}"
  echo "[soak] PAPER TRADING ONLY. This spends metered Claude credit; see README."
} >> "$LOG"

RESTARTS=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  echo "[soak] launching daemon $(date -u +%FT%TZ) (restart #$RESTARTS)" >> "$LOG"
  # Backgrounded and waited on, rather than run in the foreground, so the trap
  # can reach the child: a foreground child swallows the signal and the soak
  # cannot shut it down cleanly.
  node --env-file-if-exists=.env --import tsx apps/daemon/src/main.ts "${EXTRA[@]:-}" >> "$LOG" 2>&1 &
  CHILD=$!
  # `|| true` so a non-zero exit is a restart, not the end of the soak: an
  # unattended run that stops at the first crash has not soaked anything.
  wait "$CHILD" || true
  CHILD=""

  [ "$STOPPING" -eq 1 ] && break
  [ "$(date +%s)" -ge "$DEADLINE" ] && break
  RESTARTS=$((RESTARTS + 1))
  echo "[soak] daemon exited; restarting in 30s" >> "$LOG"
  sleep 30
done

echo "[soak] window complete after $RESTARTS restart(s) $(date -u +%FT%TZ)" >> "$LOG"
echo "[soak] run 'pnpm report' for the verdict" >> "$LOG"
