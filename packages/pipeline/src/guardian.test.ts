import { describe, it, expect } from 'vitest';
import { evaluateExit, DRIFT_EXIT } from './guardian.js';

describe('evaluateExit', () => {
  it('holds a position sitting near entry', () => {
    const d = evaluateExit('100', '101', '101', 3);
    expect(d.exit).toBe(false);
  });

  it('stops out at the loss threshold', () => {
    const d = evaluateExit('100', '92', '100', 3);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('STOP_LOSS');
  });

  it('does not stop out just above the threshold', () => {
    expect(evaluateExit('100', '92.5', '100', 3).exit).toBe(false);
  });

  it('takes profit at the target', () => {
    const d = evaluateExit('100', '115', '115', 5);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TAKE_PROFIT');
  });

  it('does not arm the trailing stop before the position has run', () => {
    // Up only 2%, then back to entry. That is noise, not a give-back.
    expect(evaluateExit('100', '100', '102', 3).exit).toBe(false);
  });

  it('trails once the position has run and then gives back', () => {
    // Ran to +10%, now 5.5% off the high.
    const d = evaluateExit('100', '104', '110', 10);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TRAILING_STOP');
  });

  it('closes on the time stop once the drift window has passed', () => {
    const d = evaluateExit('100', '101', '101', 45);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TIME_STOP');
  });

  it('holds one day short of the time stop', () => {
    expect(evaluateExit('100', '101', '101', 44).exit).toBe(false);
  });

  it('prefers the stop-loss when a position is both old and losing', () => {
    // Protecting capital outranks the calendar.
    const d = evaluateExit('100', '85', '100', 60);
    expect(d.reason).toBe('STOP_LOSS');
  });

  it('treats the current price as the high when it exceeds the recorded mark', () => {
    const d = evaluateExit('100', '120', '105', 5);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TAKE_PROFIT');
  });

  it('does not divide by zero on a missing entry price', () => {
    expect(evaluateExit('0', '100', '100', 5).exit).toBe(false);
  });

  it('respects a custom rule', () => {
    const tight = { ...DRIFT_EXIT, stopLossPct: 0.02 };
    expect(evaluateExit('100', '97', '100', 1, tight).reason).toBe('STOP_LOSS');
  });
});
