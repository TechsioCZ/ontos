// @effect-diagnostics *:off
import { createConnection } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { createHash } from 'node:crypto';
import { Effect, Redacted } from 'effect';
import type { EmailDeliveryMessage, EmailDeliveryServiceContract } from './server.ts';
import { EmailDeliveryAcceptanceIndeterminate, EmailDeliveryInvalidMessage, EmailDeliveryRejected, EmailDeliveryUnavailable } from './server.ts';

export interface SmtpConfiguration {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  /** Implicit TLS (normally port 465). Never sends credentials over plaintext. */
  readonly secure?: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly timeoutMs?: number;
}
const address = (value: string) => value.match(/^(?:[^<>\r\n]+<)?([^<>\s@]+@[^<>\s@]+)>?$/u)?.[1];
const header = (value: string) => value.length > 0 && value.length < 999 && !/[\r\n\x00]/u.test(value);
const encoded = (value: string) => Buffer.from(value).toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? '';
/** RFC 2047: a non-ASCII display name ("Siampark – finanční oddělení <a@b>") becomes =?UTF-8?B?…?= <a@b>. */
export const formatAddressHeader = (value: string): string => {
  const match = value.match(/^\s*"?([^"<>\r\n]*?)"?\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/u);
  if (match === null) return value.trim();
  const name = (match[1] ?? '').trim();
  const mail = match[2] ?? '';
  if (name.length === 0) return `<${mail}>`;
  return /[^\x20-\x7e]/u.test(name) ? `=?UTF-8?B?${Buffer.from(name).toString('base64')}?= <${mail}>` : `${name} <${mail}>`;
};

/** Single SMTP attempt. A broken connection after DATA is ambiguous, never automatically retried. */
export const makeSmtpEmailDelivery = (config: SmtpConfiguration): EmailDeliveryServiceContract => ({
  send: (message: EmailDeliveryMessage) => Effect.tryPromise({
    try: async () => {
      if (!address(config.from) || !config.host || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || (config.user && !config.secure)
        || (config.timeoutMs !== undefined && !(Number.isFinite(config.timeoutMs) && config.timeoutMs > 0))) {
        throw new EmailDeliveryUnavailable({ reason: 'configuration' });
      }
      if (!address(message.to) || !header(message.to)) throw new EmailDeliveryInvalidMessage({ field: 'to', reason: 'invalid_format' });
      if (!header(message.subject)) throw new EmailDeliveryInvalidMessage({ field: 'subject', reason: 'control_character' });
      const id = `${createHash('sha256').update(message.idempotencyKey ?? crypto.randomUUID()).digest('hex')}@ontos.local`;
      const socket = config.secure ? connectTls({ host: config.host, port: config.port, servername: config.host }) : createConnection({ host: config.host, port: config.port });
      let buffer = '';
      const replies: string[] = [];
      let wake: (() => void) | undefined;
      let failure: Error | undefined;
      let dataStarted = false;
      socket.setEncoding('utf8');
      socket.setTimeout(config.timeoutMs ?? 10000, () => socket.destroy(new Error('SMTP timeout')));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^\d{3} /u.test(line)) replies.push(line);
        }
        wake?.();
      });
      socket.on('error', (error) => { failure = error; wake?.(); });
      socket.on('close', () => { failure ??= new Error('SMTP closed'); wake?.(); });
      const reply = async (expected: number) => {
        while (!replies.length && !failure) await new Promise<void>((resolve) => { wake = resolve; });
        const line = replies.shift();
        if (!line) throw new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' });
        const status = Number(line.slice(0, 3));
        if (status !== expected) throw new EmailDeliveryRejected({ reason: 'provider_rejected', status });
      };
      const command = async (value: string, expected = 250) => { socket.write(`${value}\r\n`); await reply(expected); };
      try {
        await reply(220);
        await command('EHLO ontos.local');
        if (config.user) await command(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.password ?? ''}`).toString('base64')}`, 235);
        await command(`MAIL FROM:<${address(config.from)}>`);
        await command(`RCPT TO:<${address(message.to)}>`);
        await command('DATA', 354);
        const boundary = `ontos-${id.split('@')[0]}`;
        const parts = [
          `From: ${formatAddressHeader(config.from)}`, `To: ${formatAddressHeader(message.to)}`, `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
          `Date: ${new Date().toUTCString()}`, `Message-ID: <${id}>`, 'MIME-Version: 1.0',
          `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
          `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encoded(Redacted.value(message.text)),
          ...(message.html ? [`--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encoded(Redacted.value(message.html))] : []),
          `--${boundary}--`, '', '.', '',
        ];
        dataStarted = true;
        socket.write(parts.join('\r\n'));
        await reply(250);
        // The DATA 250 is the acceptance boundary; a failed QUIT must not turn success into a retry.
        socket.end('QUIT\r\n');
        return { accepted: true as const, id };
      } catch (error) {
        if (!dataStarted && !(error instanceof EmailDeliveryRejected) && !(error instanceof EmailDeliveryInvalidMessage) && !(error instanceof EmailDeliveryUnavailable)) {
          throw new EmailDeliveryUnavailable({ reason: 'provider_unavailable' });
        }
        throw error;
      } finally { socket.destroy(); }
    },
    catch: (error) => error instanceof EmailDeliveryRejected || error instanceof EmailDeliveryInvalidMessage || error instanceof EmailDeliveryUnavailable || error instanceof EmailDeliveryAcceptanceIndeterminate
      ? error : new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' }),
  }),
});

export const smtpConfigurationFromEnvironment = (env: Readonly<Record<string, string | undefined>>): SmtpConfiguration => ({
  host: env['SMTP_HOST'] ?? '127.0.0.1', port: Number(env['SMTP_PORT'] ?? 1025),
  from: env['SMTP_FROM'] ?? 'OntOS <oznameni@ontos.demo>', secure: env['SMTP_SECURE'] === 'true', timeoutMs: Number(env['SMTP_TIMEOUT_MS'] ?? 10000),
  ...(env['SMTP_USER'] ? { user: env['SMTP_USER'], password: env['SMTP_PASSWORD'] ?? '' } : {}),
});
