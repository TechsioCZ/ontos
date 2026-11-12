# Private module credential channels of the local demo (sourced by scripts/demo/up.sh).
#
# Each calling module's server reads its key on file descriptor 3, opened read-write on a FIFO in a private directory,
# so the key never sits in an environment variable, an argument or a file. The directory is removed when the
# launching shell exits, and a handover never blocks on a server that is gone.
#
# Needs: say, PID_DIR. Provides: CHANNEL_DIR, channel_open <app-id>, hand_over <app-id> <bytes>.

CHANNEL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ontos-demo-channels.XXXXXX")"
chmod 700 "$CHANNEL_DIR"
# Every exit path, including die, removes the channels; the servers keep the FIFOs they already opened.
trap 'rm -rf "$CHANNEL_DIR"' EXIT

channel_open() { # channel_open <app-id>: a fresh FIFO the module's server opens as its file descriptor 3
  rm -f "$CHANNEL_DIR/$1" && mkfifo -m 600 "$CHANNEL_DIR/$1"
}

hand_over() { # hand_over <app-id> <handover line>: write one module's handover to its channel, never blocking
  local fifo="$CHANNEL_DIR/$1" pid
  pid="$(cat "$PID_DIR/$1.pid" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    say "WARN $1 is not running; no module credential handed over"
    rm -f "$fifo"
    return 1
  fi
  # Opened read-write, the FIFO never blocks the open, and one line fits the pipe buffer, so the write never blocks
  # either: if the server dies in between, the line is simply dropped with the last open end.
  exec 9<>"$fifo"
  printf '%s\n' "$2" >&9
  exec 9>&-
  rm -f "$fifo"
}
