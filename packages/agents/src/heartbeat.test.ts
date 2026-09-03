import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startHeartbeat } from './heartbeat.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('startHeartbeat', () => {
  it('returns a stop function', () => {
    const stop = startHeartbeat(1000, () => {});
    expect(typeof stop).toBe('function');
    stop();
  });

  it('fires the callback on each interval', () => {
    const beat = vi.fn();
    const stop = startHeartbeat(1000, beat);
    vi.advanceTimersByTime(3000);
    expect(beat).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops firing after stop()', () => {
    const beat = vi.fn();
    const stop = startHeartbeat(1000, beat);
    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(beat).toHaveBeenCalledTimes(1);
  });

  it('does NOT unref the timer — the daemon must stay alive with zero agents', () => {
    // A daemon whose only work is scheduled elsewhere still has to hold the
    // event loop open. process.on('SIGINT') does not do that on its own.
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startHeartbeat(1000, () => {});
    const timer = spy.mock.results[0]!.value as NodeJS.Timeout & { hasRef?: () => boolean };
    expect(typeof timer.hasRef === 'function' ? timer.hasRef() : true).toBe(true);
    stop();
    spy.mockRestore();
  });
});
