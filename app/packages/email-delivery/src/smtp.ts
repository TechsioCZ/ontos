import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import {
  Cause,
  Config,
  ConfigProvider,
  DateTime,
  Effect,
  Layer,
  Option,
  Queue,
  Random,
  Redacted,
  Schema,
} from 'effect';
import type { Scope } from 'effect';

import type { EmailDeliveryError, EmailDeliveryMessage, EmailDeliveryReceipt } from './server.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryRejected,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from './server.ts';

export interface SmtpConfiguration {
  readonly from: string;
  readonly host: string;
  readonly password?: Redacted.Redacted;
  readonly port: number;
  /** Implicit TLS. Credentials are never sent over plaintext. */
  readonly secure?: boolean;
  readonly timeoutMs?: number;
  readonly user?: string;
}

const address = (value: string) =>
  Option.fromNullishOr(/^(?:[^<>\r\n]+<)?(?<address>[^<>\s@]+@[^<>\s@]+)>?$/u.exec(value)?.groups?.['address']);
const header = (value: string) =>
  value.length > 0 && value.length < 999 && !value.includes('\r') && !value.includes('\n') && !value.includes('\0');
const encoded = (value: string) =>
  Buffer.from(value)
    .toString('base64')
    .match(/.{1,76}/gu)
    ?.join('\r\n') ?? '';

/** Encode non-ASCII display names using RFC 2047. */
export const formatAddressHeader = (value: string): string => {
  const match = /^\s*"?(?<name>[^"<>\r\n]*?)"?\s*<(?<address>[^<>\s@]+@[^<>\s@]+)>\s*$/u.exec(value);
  if (match === null) {
    return value.trim();
  }
  const name = (match.groups?.['name'] ?? '').trim();
  const mail = match.groups?.['address'] ?? '';
  if (name.length === 0) {
    return `<${mail}>`;
  }
  return /[^\u0020-\u007E]/u.test(name)
    ? `=?UTF-8?B?${Buffer.from(name).toString('base64')}?= <${mail}>`
    : `${name} <${mail}>`;
};

const transportFailure = (cause: Schema.Defect['Type']) =>
  Object.defineProperty(new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' }), 'cause', {
    value: Redacted.make(cause),
  });

type SmtpReplies = Queue.Queue<string, EmailDeliveryAcceptanceIndeterminate>;

const openSocket = (config: SmtpConfiguration, replies: SmtpReplies) =>
  Effect.acquireRelease(
    Effect.try({
      catch: transportFailure,
      try: () => {
        const socket =
          config.secure === true
            ? connectTls({ host: config.host, port: config.port, servername: config.host })
            : createConnection({ host: config.host, port: config.port });
        let buffer = '';
        const onData = (chunk: string) => {
          buffer += chunk;
          let end = buffer.indexOf('\r\n');
          while (end !== -1) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (/^\d{3} /u.test(line)) {
              Queue.offerUnsafe(replies, line);
            }
            end = buffer.indexOf('\r\n');
          }
        };
        const onError = (cause: Error) => {
          Queue.failCauseUnsafe(replies, Cause.fail(transportFailure(cause)));
        };
        const onClose = () => {
          Queue.failCauseUnsafe(replies, Cause.fail(new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' })));
        };
        socket.setEncoding('utf-8');
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
        return { onClose, onData, onError, socket };
      },
    }),
    ({ onClose, onData, onError, socket }) =>
      Effect.sync(() => {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        socket.destroy();
      }),
  );

const reply = Effect.fn('Smtp.reply')(function* readReply(replies: SmtpReplies, expected: number, timeoutMs: number) {
  const line = yield* Queue.take(replies).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new EmailDeliveryAcceptanceIndeterminate({ reason: 'timeout' })),
    }),
  );
  const status = Number(line.slice(0, 3));
  if (status >= 400 && status < 500) {
    return yield* new EmailDeliveryUnavailable({ reason: 'provider_unavailable', status });
  }
  if (status !== expected) {
    return yield* new EmailDeliveryRejected({ reason: 'provider_rejected', status });
  }
  return yield* Effect.void;
});

const write = (socket: Socket, value: string) =>
  Effect.try({
    catch: transportFailure,
    try: () => {
      socket.write(value);
    },
  });
const command = Effect.fn('Smtp.command')(function* sendCommand(
  socket: Socket,
  replies: SmtpReplies,
  timeoutMs: number,
  value: string,
  expected: number,
) {
  yield* write(socket, `${value}\r\n`);
  yield* reply(replies, expected, timeoutMs);
});

const mimeMessage = (config: SmtpConfiguration, message: EmailDeliveryMessage, id: string, date: Date): string => {
  const boundary = `ontos-${id.split('@')[0]}`;
  return [
    `From: ${formatAddressHeader(config.from)}`,
    `To: ${formatAddressHeader(message.to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encoded(Redacted.value(message.text)),
    ...(message.html === undefined
      ? []
      : [
          `--${boundary}`,
          'Content-Type: text/html; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          encoded(Redacted.value(message.html)),
        ]),
    `--${boundary}--`,
    '',
    '.',
    '',
  ].join('\r\n');
};

/** One socket and one SMTP attempt. A lost DATA acknowledgement is never retried automatically. */
export const SmtpEmailDeliveryLive = (config: SmtpConfiguration) =>
  Layer.succeed(EmailDeliveryService, {
    send: Effect.fn('Smtp.send')(function* sendMessage(
      message: EmailDeliveryMessage,
    ): Effect.fn.Return<EmailDeliveryReceipt, EmailDeliveryError, Scope.Scope> {
      const from = address(config.from);
      const to = address(message.to);
      const authenticated = config.user !== undefined && config.user !== '';
      if (
        Option.isNone(from) ||
        config.host === '' ||
        !Number.isInteger(config.port) ||
        config.port < 1 ||
        config.port > 65_535 ||
        (authenticated && config.secure !== true) ||
        (config.timeoutMs !== undefined && !(Number.isFinite(config.timeoutMs) && config.timeoutMs > 0))
      ) {
        return yield* new EmailDeliveryUnavailable({ reason: 'configuration' });
      }
      if (Option.isNone(to) || !header(message.to)) {
        return yield* new EmailDeliveryInvalidMessage({ field: 'to', reason: 'invalid_format' });
      }
      if (!header(message.subject)) {
        return yield* new EmailDeliveryInvalidMessage({ field: 'subject', reason: 'control_character' });
      }
      const nonce =
        message.idempotencyKey ??
        (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 })).join(':');
      const id = `${createHash('sha256').update(nonce).digest('hex')}@ontos.local`;
      const replies = yield* Queue.unbounded<string, EmailDeliveryAcceptanceIndeterminate>();
      let dataStarted = false;
      return yield* Effect.gen(function* submitSmtp() {
        const { socket } = yield* openSocket(config, replies);
        const timeoutMs = config.timeoutMs ?? 10_000;
        yield* reply(replies, 220, timeoutMs);
        yield* command(socket, replies, timeoutMs, 'EHLO ontos.local', 250);
        if (authenticated) {
          const credentials = `\0${config.user}\0${config.password === undefined ? '' : Redacted.value(config.password)}`;
          yield* command(socket, replies, timeoutMs, `AUTH PLAIN ${Buffer.from(credentials).toString('base64')}`, 235);
        }
        yield* command(socket, replies, timeoutMs, `MAIL FROM:<${from.value}>`, 250);
        yield* command(socket, replies, timeoutMs, `RCPT TO:<${to.value}>`, 250);
        yield* command(socket, replies, timeoutMs, 'DATA', 354);
        const date = yield* DateTime.nowAsDate;
        const body = mimeMessage(config, message, id, date);
        dataStarted = true;
        yield* write(socket, body);
        yield* reply(replies, 250, timeoutMs);
        // DATA 250 is acceptance. A failed QUIT cannot turn success into a retry.
        yield* Effect.try({
          catch: transportFailure,
          try: () => {
            socket.end('QUIT\r\n');
          },
        }).pipe(Effect.ignore);
        return { accepted: true as const, id };
      }).pipe(
        Effect.catchTag(
          'EmailDeliveryAcceptanceIndeterminate',
          (failure): Effect.Effect<never, EmailDeliveryAcceptanceIndeterminate | EmailDeliveryUnavailable> =>
            dataStarted
              ? Effect.fail(failure)
              : Effect.fail(
                  Object.defineProperty(new EmailDeliveryUnavailable({ reason: 'provider_unavailable' }), 'cause', {
                    value: Redacted.make(failure),
                  }),
                ),
        ),
      );
    }, Effect.scoped),
  });

export const SmtpEnvironmentSchema = Schema.Struct({
  SMTP_FROM: Schema.optionalKey(Schema.String),
  SMTP_HOST: Schema.optionalKey(Schema.String),
  SMTP_PASSWORD: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  SMTP_PORT: Schema.optionalKey(Schema.String),
  SMTP_SECURE: Schema.optionalKey(Schema.String),
  SMTP_TIMEOUT_MS: Schema.optionalKey(Schema.String),
  SMTP_USER: Schema.optionalKey(Schema.String),
});
export type SmtpEnvironment = typeof SmtpEnvironmentSchema.Encoded;

export const smtpConfiguration = Config.all({
  from: Config.String('SMTP_FROM').pipe(Config.withDefault('OntOS <oznameni@ontos.demo>')),
  host: Config.String('SMTP_HOST').pipe(Config.withDefault('127.0.0.1')),
  password: Config.Redacted('SMTP_PASSWORD').pipe(Config.option),
  port: Config.Port('SMTP_PORT').pipe(Config.withDefault(1025)),
  secure: Config.Boolean('SMTP_SECURE').pipe(Config.withDefault(false)),
  timeoutMs: Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), 'SMTP_TIMEOUT_MS').pipe(
    Config.withDefault(10_000),
  ),
  user: Config.String('SMTP_USER').pipe(Config.option),
}).pipe(
  Config.map((values): SmtpConfiguration => {
    const config = {
      from: values.from,
      host: values.host,
      port: values.port,
      secure: values.secure,
      timeoutMs: values.timeoutMs,
    };
    if (Option.isSome(values.user) && values.user.value !== '') {
      return {
        ...config,
        password: Option.getOrElse(values.password, () => Redacted.make('')),
        user: values.user.value,
      };
    }
    return config;
  }),
);

export const smtpConfigurationFromEnvironment = (environment: SmtpEnvironment) =>
  smtpConfiguration.parse(ConfigProvider.fromUnknown(environment));
