import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { flow } from 'effect/Function';
import { describe, expect, it } from 'effect-rstest';
import { formatAddressHeader, SmtpEmailDeliveryLive, smtpConfigurationFromEnvironment } from '../../src/smtp.ts';
import type { SmtpConfiguration } from '../../src/smtp.ts';
import { emailTransport } from '../../src/transport.node.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryRejected,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from '../../src/server.ts';

const smtpModes = [
  'accept',
  'drop-quit',
  'reject-rcpt',
  'tempfail-rcpt',
  'drop-before-data',
  'drop-after-data',
  'stall-after-data',
  'tempfail-data',
  'reject-data',
] as const;
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
        if (mode === 'stall-after-data') {
          return;
        }
        if (mode === 'tempfail-data') {
          socket.write('451 4.3.0 try later\r\n');
        } else if (mode === 'reject-data') {
          socket.write('550 5.7.1 rejected\r\n');
        } else {
          socket.write('250 2.0.0 queued\r\n');
        }
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
        if (mode === 'drop-before-data') {
          socket.destroy();
          return;
        }
        socket.write(recipientReply(mode));
      } else if (line === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (line === 'QUIT') {
        if (mode === 'drop-quit') {
          socket.destroy();
          return;
        }
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
const smtpTestLayer = (mode: Mode, from = 'finance@siampark.demo', timeoutMs = 10_000) =>
  Layer.unwrap(
    Effect.map(startFakeSmtp(mode), (server) =>
      Layer.merge(
        Layer.succeed(SmtpFixture, server),
        SmtpEmailDeliveryLive({ from, host: '127.0.0.1', port: server.port, timeoutMs }).pipe(
          Layer.provideMerge(NodeCrypto.layer),
        ),
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
const sendWithConfiguration = Effect.fn('SmtpTest.sendWithConfiguration')(function* configuredSend(
  config: SmtpConfiguration,
) {
  const context = yield* Layer.build(SmtpEmailDeliveryLive(config));
  return yield* Context.get(context, EmailDeliveryService).send(message);
}, Effect.scoped);

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

  it.layer(smtpTestLayer('drop-before-data'), { excludeTestServices: true })((test) => {
    test.effect('broken connection before DATA is safe to retry without submitting', () =>
      Effect.gen(function* droppedBeforeData() {
        const server = yield* SmtpFixture;
        const error = yield* Effect.flip((yield* EmailDeliveryService).send(message));
        expect(Schema.is(EmailDeliveryUnavailable)(error)).toBe(true);
        expect(server.messages).toHaveLength(0);
      }),
    );
  });

  it.layer(smtpTestLayer('drop-quit'), { excludeTestServices: true })((test) => {
    test.effect('DATA 250 remains accepted when the server drops QUIT without a 221', () =>
      Effect.gen(function* acceptedBeforeQuit() {
        const server = yield* SmtpFixture;
        const receipt = yield* (yield* EmailDeliveryService).send(message);
        yield* server.close;
        expect(receipt.accepted).toBe(true);
        expect(server.messages).toHaveLength(1);
      }),
    );
  });

  it.layer(smtpTestLayer('stall-after-data', 'finance@siampark.demo', 100), { excludeTestServices: true })((test) => {
    test.effect('lost DATA acknowledgement times out indeterminate without a second submission', () =>
      Effect.gen(function* uncertainAcceptance() {
        const server = yield* SmtpFixture;
        const error = yield* Effect.flip((yield* EmailDeliveryService).send(message));
        if (!Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)) {
          expect.unreachable('A lost DATA acknowledgement must remain indeterminate');
        }
        expect(error.reason).toBe('timeout');
        expect(server.messages).toHaveLength(1);
      }),
    );
  });

  for (const mode of ['tempfail-data', 'reject-data'] as const) {
    it.layer(smtpTestLayer(mode), { excludeTestServices: true })((test) => {
      test.effect(`${mode} preserves a definite negative DATA reply`, () =>
        Effect.gen(function* definiteNonAcceptance() {
          const server = yield* SmtpFixture;
          const error = yield* Effect.flip((yield* EmailDeliveryService).send(message));
          expect(Schema.is(mode === 'tempfail-data' ? EmailDeliveryUnavailable : EmailDeliveryRejected)(error)).toBe(
            true,
          );
          expect(server.messages).toHaveLength(1);
        }),
      );
    });
  }

  it.layer(smtpTestLayer('accept'), { excludeTestServices: true })((test) => {
    test.effect('the selected test capture never inherits production TLS or credentials', () =>
      Effect.gen(function* isolatedCapture() {
        const server = yield* SmtpFixture;
        const transport = yield* emailTransport.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              EMAIL_TEST_SMTP_HOST: '127.0.0.1',
              EMAIL_TEST_SMTP_PORT: `${server.port}`,
              SMTP_HOST: '127.0.0.1',
              SMTP_PASSWORD: ['private', 'production', 'password'].join('-'),
              SMTP_PORT: `${server.port}`,
              SMTP_SECURE: 'true',
              SMTP_USER: 'production-user',
            }),
          ),
        );
        const context = yield* Layer.build(transport.deliveryLayer('a@b.cz', 'audit@example.org'));
        expect(server.messages).toHaveLength(0);
        const receipt = yield* Context.get(context, EmailDeliveryService).send({
          ...message,
          to: 'audit@example.org',
        });
        expect(receipt.accepted).toBe(true);
        expect(server.messages).toHaveLength(1);
        expect(server.messages[0]).not.toContain('private-production-password');
      }),
    );
  });

  it.layer(smtpTestLayer('accept'), { excludeTestServices: true })((test) => {
    test.effect.each([0, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
      'rejects a direct invalid timeout before submitting: %j',
      (timeoutMs) =>
        Effect.gen(function* invalidDirectTimeout() {
          const server = yield* SmtpFixture;
          const error = yield* Effect.flip(
            sendWithConfiguration({ from: 'a@b.cz', host: '127.0.0.1', port: server.port, timeoutMs }),
          );
          if (!Schema.is(EmailDeliveryUnavailable)(error)) {
            expect.unreachable('Expected invalid configuration before connection');
          }
          expect(error.reason).toBe('configuration');
          expect(server.messages).toHaveLength(0);
        }),
    );

    test.effect('rejects blank endpoints, plaintext credentials and injected sender headers before submitting', () =>
      Effect.gen(function* invalidDirectEndpoint() {
        const server = yield* SmtpFixture;
        const invalid: readonly Partial<SmtpConfiguration>[] = [
          { host: '' },
          { host: '   ' },
          { from: '' },
          { from: '   ' },
          { from: 'bad\r\nBcc: victim@b.cz <a@b.cz>' },
          { from: 'bad\0name <a@b.cz>' },
          { password: Redacted.make('private'), user: 'user' },
          { port: 0 },
          { port: 65_536 },
          { port: 1.5 },
        ];
        for (const settings of invalid) {
          const error = yield* Effect.flip(
            sendWithConfiguration({ from: 'a@b.cz', host: '127.0.0.1', port: server.port, ...settings }),
          );
          if (!Schema.is(EmailDeliveryUnavailable)(error)) {
            expect.unreachable('Expected unsafe configuration before connection');
          }
          expect(error.reason).toBe('configuration');
          expect(server.messages).toHaveLength(0);
        }
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
    }).pipe(Layer.provide(NodeCrypto.layer)),
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
