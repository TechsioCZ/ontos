// @effect-diagnostics *:off
import { describe, expect, test } from '@rstest/core';
import { Effect, Redacted, Schema } from 'effect';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { formatAddressHeader, makeSmtpEmailDelivery, smtpConfigurationFromEnvironment } from '../../src/smtp.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryRejected,
  EmailDeliveryUnavailable,
} from '../../src/server.ts';

type Mode = 'accept' | 'reject-rcpt' | 'tempfail-rcpt' | 'drop-after-data';
const startFakeSmtp = (mode: Mode = 'accept') =>
  new Promise<{ readonly close: () => Promise<void>; readonly messages: string[]; readonly port: number }>(
    (resolve) => {
      const messages: string[] = [];
      const server = createServer((socket) => {
        socket.setEncoding('utf8');
        let buffer = '';
        let inData = false;
        socket.on('error', () => undefined);
        socket.write('220 fake.smtp ESMTP\r\n');
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          for (;;) {
            if (inData) {
              const end = buffer.indexOf('\r\n.\r\n');
              if (end < 0) return;
              messages.push(buffer.slice(0, end));
              buffer = buffer.slice(end + 5);
              inData = false;
              if (mode === 'drop-after-data') {
                socket.destroy();
                return;
              }
              socket.write('250 2.0.0 queued\r\n');
              continue;
            }
            const end = buffer.indexOf('\r\n');
            if (end < 0) return;
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (line.startsWith('EHLO')) socket.write('250-fake.smtp\r\n250 8BITMIME\r\n');
            else if (line.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
            else if (line.startsWith('RCPT TO'))
              socket.write(
                mode === 'reject-rcpt'
                  ? '550 5.1.1 no such user\r\n'
                  : mode === 'tempfail-rcpt'
                    ? '451 4.3.0 try later\r\n'
                    : '250 OK\r\n',
              );
            else if (line === 'DATA') {
              inData = true;
              socket.write('354 go ahead\r\n');
            } else if (line === 'QUIT') {
              socket.end('221 bye\r\n');
              return;
            } else socket.write('502 unsupported\r\n');
          }
        });
      });
      server.listen(0, '127.0.0.1', () =>
        resolve({
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
          messages,
          port: (server.address() as AddressInfo).port,
        }),
      );
    },
  );
const message = {
  html: Redacted.make('<p>Dobrý den</p>'),
  idempotencyKey: 'rent-reminder:r1',
  subject: 'Upomínka – faktura FV-2026-0007',
  text: Redacted.make('Dobrý den'),
  to: 'fakturace@odberatel.example',
};

describe('SMTP email delivery adapter', () => {
  test('accepts a message', async () => {
    const server = await startFakeSmtp('accept');
    try {
      const transport = makeSmtpEmailDelivery({
        from: 'Siampark – finanční oddělení <finance@siampark.demo>',
        host: '127.0.0.1',
        port: server.port,
      });
      const receipt = await Effect.runPromise(transport.send(message));
      expect(receipt.accepted).toBe(true);
      expect(receipt.id.endsWith('@ontos.local')).toBe(true);
      expect(server.messages.length).toBe(1);
      expect(server.messages[0]).toContain(`Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`);
      expect(server.messages[0]).toContain(
        `From: =?UTF-8?B?${Buffer.from('Siampark – finanční oddělení').toString('base64')}?= <finance@siampark.demo>`,
      );
      expect(server.messages[0]).toContain('Content-Type: text/html; charset=utf-8');
    } finally {
      await server.close();
    }
  });

  test('rejected recipient is permanent', async () => {
    const server = await startFakeSmtp('reject-rcpt');
    try {
      const transport = makeSmtpEmailDelivery({ from: 'finance@siampark.demo', host: '127.0.0.1', port: server.port });
      const error = await Effect.runPromise(Effect.flip(transport.send(message)));
      expect(Schema.is(EmailDeliveryRejected)(error)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('temporary SMTP failure before DATA is safe to retry', async () => {
    const server = await startFakeSmtp('tempfail-rcpt');
    try {
      const transport = makeSmtpEmailDelivery({ from: 'finance@siampark.demo', host: '127.0.0.1', port: server.port });
      const error = await Effect.runPromise(Effect.flip(transport.send(message)));
      expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
      expect((error as { status?: number }).status).toBe(451);
      expect(server.messages.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('connection refused is safe to retry', async () => {
    const server = await startFakeSmtp('accept');
    const port = server.port;
    await server.close();
    const transport = makeSmtpEmailDelivery({ from: 'finance@siampark.demo', host: '127.0.0.1', port });
    const error = await Effect.runPromise(Effect.flip(transport.send(message)));
    expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
    expect((error as { reason?: string }).reason).toBe('provider_unavailable');
  });

  test('broken connection after DATA is indeterminate', async () => {
    const server = await startFakeSmtp('drop-after-data');
    try {
      const transport = makeSmtpEmailDelivery({ from: 'finance@siampark.demo', host: '127.0.0.1', port: server.port });
      const error = await Effect.runPromise(Effect.flip(transport.send(message)));
      expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
      expect(server.messages.length).toBe(1);
    } finally {
      await server.close();
    }
  });

  test('reads SMTP configuration defaults from the environment', () => {
    const config = smtpConfigurationFromEnvironment({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(1025);
    expect(config.secure).toBe(false);
    expect(config.timeoutMs).toBe(10000);
    expect(config.user).toBeUndefined();
  });

  test('invalid timeout is a configuration error, not an indeterminate send', async () => {
    const transport = makeSmtpEmailDelivery(smtpConfigurationFromEnvironment({ SMTP_TIMEOUT_MS: 'abc' }));
    const error = await Effect.runPromise(Effect.flip(transport.send(message)));
    expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
    expect((error as { reason?: string }).reason).toBe('configuration');
  });

  test('formats address headers with RFC 2047 encoded display names', () => {
    expect(formatAddressHeader('AKROS e-shop <eshop@akros.demo>')).toBe('AKROS e-shop <eshop@akros.demo>');
    const encodedName = formatAddressHeader('Siampark – finanční oddělení <finance@siampark.demo>');
    expect(encodedName.startsWith('=?UTF-8?B?')).toBe(true);
    expect(encodedName.endsWith(' <finance@siampark.demo>')).toBe(true);
    expect(formatAddressHeader('a@b.cz')).toBe('a@b.cz');
  });
});
