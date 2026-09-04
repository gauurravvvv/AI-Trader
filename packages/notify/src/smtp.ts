import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from '@aegis/logger';
import type { Transport } from './notifier.js';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS. Port 465 is secure; 587 uses STARTTLS and should be false. */
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * Read SMTP settings from the environment.
 *
 * Returns null when nothing is configured, which is not an error: the system
 * must stay fully runnable with no mail account, and a missing password should
 * degrade to console output rather than stop the daemon from starting.
 *
 * A partial configuration IS an error, though. Half-set credentials mean
 * someone intended email and got silence, which is the worst of both.
 */
export function smtpFromEnv(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const host = env['SMTP_HOST']?.trim();
  if (host === undefined || host === '') return null;

  const missing = (['SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const).filter(
    (k) => (env[k] ?? '').trim() === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `SMTP_HOST is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not. ` +
        'Either configure all of them or unset SMTP_HOST to log notifications instead.',
    );
  }

  const port = Number(env['SMTP_PORT'] ?? '587');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`SMTP_PORT must be a port number; got ${String(env['SMTP_PORT'])}`);
  }

  return {
    host,
    port,
    // 465 is implicit TLS; 587 negotiates with STARTTLS and must not set this.
    secure: (env['SMTP_SECURE'] ?? String(port === 465)) === 'true',
    user: (env['SMTP_USER'] ?? '').trim(),
    pass: env['SMTP_PASS'] ?? '',
    from: (env['SMTP_FROM'] ?? '').trim(),
  };
}

/**
 * Sends real email.
 *
 * Deliberately does not verify the connection at construction: a mail server
 * that is briefly unreachable should not stop the daemon booting. A send that
 * fails throws, and the Notifier's outbox retries it — the record of what was
 * decided is in the database either way.
 */
export class SmtpTransport implements Transport {
  readonly name = 'smtp';
  private readonly mailer: Transporter;

  constructor(
    private readonly cfg: SmtpConfig,
    private readonly log: Logger,
  ) {
    this.mailer = createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }

  async send(to: string, subject: string, body: string): Promise<void> {
    await this.mailer.sendMail({ from: this.cfg.from, to, subject, text: body });
    this.log.event('notifier', `[email → ${to}] ${subject}`);
  }

  /** Optional pre-flight, so a bad password is reported at boot not at 3am. */
  async verify(): Promise<boolean> {
    try {
      await this.mailer.verify();
      return true;
    } catch (err) {
      this.log.warn(
        'notifier',
        `SMTP verify failed (${err instanceof Error ? err.message : String(err)}) — ` +
          'mail will be attempted anyway and retried by the outbox',
      );
      return false;
    }
  }
}
