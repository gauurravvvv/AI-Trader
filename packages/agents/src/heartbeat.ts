/**
 * Holds the Node event loop open and emits a periodic tick.
 *
 * A signal handler registered with `process.on('SIGINT', ...)` does NOT keep
 * the process alive — a daemon with no scheduled agents will drain its event
 * loop and exit silently, which looks identical to a crash. The heartbeat is
 * the thing that makes it a daemon, and it doubles as the periodic budget
 * report. Deliberately NOT unref'd.
 */
export function startHeartbeat(intervalMs: number, onBeat: () => void): () => void {
  const timer = setInterval(onBeat, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
