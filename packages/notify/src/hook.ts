import type { NotifyKind } from './notifier.js';

/**
 * The shape a producer needs to raise a notification.
 *
 * Declared structurally so `@aegis/risk`, `@aegis/budget` and `@aegis/pipeline`
 * can raise notifications without importing `@aegis/notify` — a router should
 * not have to know an email system exists in order to report a breach, and a
 * test should be able to assert on notifications with a two-line array push.
 */
export interface NotifyHook {
  (n: { kind: NotifyKind; subject: string; body: string }): void;
}
