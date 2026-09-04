import { describe, it, expect } from 'vitest';
import { smtpFromEnv } from './smtp.js';

const full = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  SMTP_USER: 'me@example.com',
  SMTP_PASS: 'secret',
  SMTP_FROM: 'Aegis <me@example.com>',
};

describe('smtpFromEnv', () => {
  it('returns null when nothing is configured — email is optional', () => {
    // The system must stay runnable with no mail account; a missing password
    // should degrade to console output, not stop the daemon booting.
    expect(smtpFromEnv({})).toBeNull();
    expect(smtpFromEnv({ SMTP_HOST: '   ' })).toBeNull();
  });

  it('reads a complete configuration', () => {
    const c = smtpFromEnv(full)!;
    expect(c.host).toBe('smtp.gmail.com');
    expect(c.port).toBe(587);
    expect(c.user).toBe('me@example.com');
  });

  it('refuses a half-configured setup rather than silently not sending', () => {
    // Someone who sets a host intended email. Falling back to console here
    // gives them silence and no reason for it.
    for (const drop of ['SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
      const env = { ...full, [drop]: '' };
      expect(() => smtpFromEnv(env)).toThrow(drop);
    }
  });

  it('names every missing field at once, not just the first', () => {
    expect(() => smtpFromEnv({ SMTP_HOST: 'x' })).toThrow(/SMTP_USER.*SMTP_PASS.*SMTP_FROM/);
  });

  it('infers implicit TLS from the port', () => {
    // 465 is implicit TLS; 587 negotiates with STARTTLS and must not set it.
    expect(smtpFromEnv({ ...full, SMTP_PORT: '465' })!.secure).toBe(true);
    expect(smtpFromEnv({ ...full, SMTP_PORT: '587' })!.secure).toBe(false);
  });

  it('lets the port inference be overridden', () => {
    expect(smtpFromEnv({ ...full, SMTP_PORT: '587', SMTP_SECURE: 'true' })!.secure).toBe(true);
  });

  it('defaults to 587 when no port is given', () => {
    const { SMTP_PORT: _drop, ...noPort } = full;
    expect(smtpFromEnv(noPort)!.port).toBe(587);
  });

  it('rejects a port that is not a port', () => {
    expect(() => smtpFromEnv({ ...full, SMTP_PORT: 'yes please' })).toThrow('SMTP_PORT');
    expect(() => smtpFromEnv({ ...full, SMTP_PORT: '99999' })).toThrow('SMTP_PORT');
  });

  it('trims surrounding whitespace from pasted values', () => {
    const c = smtpFromEnv({ ...full, SMTP_USER: '  me@example.com  ' })!;
    expect(c.user).toBe('me@example.com');
  });
});
