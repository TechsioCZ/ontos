import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { flow } from 'effect/Function';
import { describe, expect, it } from 'effect-rstest';
import { formatAddressHeader, SmtpEmailDeliveryLive, smtpConfigurationFromEnvironment } from '../../src/smtp.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryRejected,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from '../../src/server.ts';

const smtpModes = ['accept', 'reject-rcpt', 'tempfail-rcpt', 'drop-after-data'] as const;
type Mode = (typeof smtpModes)[number];
interface FakeSmtp {
  readonly close: Effect.Effect<void, Error>;
  readonly messages: string[];
  readonly port: number;
}
const recipientReply = (mode: Mode): string => {
  if (mode === 'reject-rcpt') {
    return '550 5.1.1 no such user\r\n';
  }
  if (mode === 'tempfail-rcpt') {
    return '451 4.3.0 try later\r\n';
  }
  return '250 OK\r\n';
};

const handleSmtpConnection = (socket: Socket, mode: Mode, messages: string[]) => {
  socket.setEncoding('utf-8');
  let buffer = '';
  let inData = false;
  socket.on('error', () => {
    // The disconnect cases deliberately close a socket before its peer finishes.
  });
  socket.write('220 fake.smtp ESMTP\r\n');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) {
          return;
        }
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
      if (end === -1) {
        return;
      }
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (line.startsWith('EHLO')) {
        socket.write('250-fake.smtp\r\n250 8BITMIME\r\n');
      } else if (line.startsWith('MAIL FROM')) {
        socket.write('250 OK\r\n');
      } else if (line.startsWith('RCPT TO')) {
        socket.write(recipientReply(mode));
      } else if (line === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (line === 'QUIT') {
        socket.end('221 bye\r\n');
        return;
      } else {
        socket.write('502 unsupported\r\n');
      }
    }
  });
};

const closeSmtpServer = (server: Server, sockets: ReadonlySet<Socket>): FakeSmtp['close'] =>
  Effect.callback((resume) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close(flow((error?: Error) => (error === undefined ? Effect.void : Effect.fail(error)), resume));
  });

const startFakeSmtp = (mode: Mode = 'accept') =>
  Effect.acquireRelease(
    Effect.callback<FakeSmtp, Error>((resume, signal) => {
      const messages: string[] = [];
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => {
          sockets.delete(socket);
        });
        handleSmtpConnection(socket, mode, messages);
      });
      let closed = false;
      const close = Effect.suspend(() => {
        if (closed) {
          return Effect.void;
        }
        closed = true;
        return closeSmtpServer(server, sockets);
      });
      server.once('error', (error) => {
        resume(Effect.fail(error));
      });
      server.listen({ host: '127.0.0.1', port: 0, signal }, () => {
        const address = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Int }))(server.address());
        if (Option.isNone(address)) {
          resume(Effect.die(new Error('The SMTP fixture must bind an IP socket')));
          return;
        }
        resume(Effect.succeed({ close, messages, port: address.value.port }));
      });
      return close.pipe(Effect.orDie);
    }),
    (server) => server.close.pipe(Effect.orDie),
  );

class SmtpFixture extends Context.Service<SmtpFixture, FakeSmtp>()(
  '@app/email-delivery/tests/unit/smtp.test/SmtpFixture',
) {}
const smtpTestLayer = (mode: Mode, from = 'finance@siampark.demo') =>
  Layer.unwrap(
    Effect.map(startFakeSmtp(mode), (server) =>
      Layer.merge(
        Layer.succeed(SmtpFixture, server),
        SmtpEmailDeliveryLive({ from, host: '127.0.0.1', port: server.port }),
      ),
    ),
  );

const message = {
  html: Redacted.make('<p>Dobrý den</p>'),
  idempotencyKey: 'rent-reminder:r1',
  subject: 'Upomínka – faktura FV-2026-0007',
  text: Redacted.make('Dobrý den'),
  to: 'fakturace@odberatel.example',
};

describe('SMTP email delivery adapter', () => {
  it.layer(smtpTestLayer('accept', 'Siampark – finanční oddělení <finance@siampark.demo>'), {
    excludeTestServices: true,
  })((test) => {
    test.effect('accepts a message', () =>
      Effect.gen(function* acceptedMessage() {
        const server = yield* SmtpFixture;
        const transport = yield* EmailDeliveryService;
        const receipt = yield* transport.send(message);
        expect(receipt.accepted).toBe(true);
        expect(receipt.id.endsWith('@ontos.local')).toBe(true);
        expect(server.messages.length).toBe(1);
        expect(server.messages[0]).toContain(`Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`);
        expect(server.messages[0]).toContain(
          `From: =?UTF-8?B?${Buffer.from('Siampark – finanční oddělení').toString('base64')}?= <finance@siampark.demo>`,
        );
        expect(server.messages[0]).toContain('Content-Type: text/html; charset=utf-8');
      }),
    );
  });

  it.layer(smtpTestLayer('reject-rcpt'), { excludeTestServices: true })((test) => {
    test.effect('rejected recipient is permanent', () =>
      Effect.gen(function* rejectedRecipient() {
        const transport = yield* EmailDeliveryService;
        const error = yield* Effect.flip(transport.send(message));
        expect(Schema.is(EmailDeliveryRejected)(error)).toBe(true);
      }),
    );
  });

  it.layer(smtpTestLayer('tempfail-rcpt'), { excludeTestServices: true })((test) => {
    test.effect('temporary SMTP failure before DATA is safe to retry', () =>
      Effect.gen(function* temporaryFailure() {
        const server = yield* SmtpFixture;
        const transport = yield* EmailDeliveryService;
        const error = yield* Effect.flip(transport.send(message));
        expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
        if (!Schema.is(EmailDeliveryUnavailable)(error)) {
          expect.unreachable('A temporary rejection before DATA must be retryable');
        }
        expect(error.status).toBe(451);
        expect(server.messages.length).toBe(0);
      }),
    );
  });

  it.layer(smtpTestLayer('accept'), { excludeTestServices: true })((test) => {
    test.effect('connection refused is safe to retry', () =>
      Effect.gen(function* refusedConnection() {
        const server = yield* SmtpFixture;
        yield* server.close;
        const transport = yield* EmailDeliveryService;
        const error = yield* Effect.flip(transport.send(message));
        expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
        if (!Schema.is(EmailDeliveryUnavailable)(error)) {
          expect.unreachable('A refused connection must remain retryable');
        }
        expect(error.reason).toBe('provider_unavailable');
      }),
    );
  });

  it.layer(smtpTestLayer('drop-after-data'), { excludeTestServices: true })((test) => {
    test.effect('broken connection after DATA is indeterminate', () =>
      Effect.gen(function* interruptedAcceptance() {
        const server = yield* SmtpFixture;
        const transport = yield* EmailDeliveryService;
        const error = yield* Effect.flip(transport.send(message));
        expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
        expect(server.messages.length).toBe(1);
      }),
    );
  });

  it.effect('reads SMTP configuration defaults from the environment', () =>
    Effect.gen(function* defaultConfiguration() {
      const config = yield* smtpConfigurationFromEnvironment({});
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(1025);
      expect(config.secure).toBe(false);
      expect(config.timeoutMs).toBe(10_000);
      expect(config.user).toBeUndefined();
    }),
  );

  it.layer(
    SmtpEmailDeliveryLive({
      from: 'OntOS <oznameni@ontos.demo>',
      host: '127.0.0.1',
      port: 1025,
      timeoutMs: Number.NaN,
    }),
    { excludeTestServices: true },
  )((test) => {
    test.effect('invalid timeout is a configuration error, not an indeterminate send', () =>
      Effect.gen(function* invalidTimeout() {
        const configuration = yield* Effect.result(smtpConfigurationFromEnvironment({ SMTP_TIMEOUT_MS: 'abc' }));
        // Invalid configuration fails before the transport is constructed, so it cannot become ambiguous acceptance.
        expect(Result.isFailure(configuration)).toBe(true);
        const transport = yield* EmailDeliveryService;
        const error = yield* Effect.flip(transport.send(message));
        expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
        if (!Schema.is(EmailDeliveryUnavailable)(error)) {
          expect.unreachable('Invalid transport configuration must remain unavailable');
        }
        expect(error.reason).toBe('configuration');
      }),
    );
  });

  it('formats address headers with RFC 2047 encoded display names', () => {
    expect(formatAddressHeader('AKROS e-shop <eshop@akros.demo>')).toBe('AKROS e-shop <eshop@akros.demo>');
    const encodedName = formatAddressHeader('Siampark – finanční oddělení <finance@siampark.demo>');
    expect(encodedName.startsWith('=?UTF-8?B?')).toBe(true);
    expect(encodedName.endsWith(' <finance@siampark.demo>')).toBe(true);
    expect(formatAddressHeader('a@b.cz')).toBe('a@b.cz');
  });
});
