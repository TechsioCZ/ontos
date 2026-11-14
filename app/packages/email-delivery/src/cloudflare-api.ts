import { Config, Effect, Layer, Option, Redacted, Schema } from 'effect';
import type { Duration } from 'effect';

import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryRejected,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from './server.ts';
import type {
  EmailDeliveryError,
  EmailDeliveryMessage,
  EmailDeliveryReceipt,
  EmailDeliveryServiceContract,
} from './server.ts';

/** Cloudflare Email Service REST API. The account id is part of the path; the API token is the bearer credential. */
const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const DEFAULT_CLOUDFLARE_TIMEOUT: Duration.Input = '10 seconds';
const MAX_API_TOKEN_LENGTH = 512;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const EMAIL_ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;

export interface CloudflareEmailApiSettings {
  readonly accountId: string | undefined;
  readonly apiToken: Redacted.Redacted | undefined;
}

export interface CloudflareEmailApiConfig extends CloudflareEmailApiSettings {
  readonly from: string;
  readonly timeout?: Duration.Input;
}

/** The plain account id and the existing secret-backed API token, read from the Node deployment environment. */
export const cloudflareEmailApiConfiguration = Config.all({
  accountId: Config.String('CLOUDFLARE_EMAIL_ACCOUNT_ID').pipe(Config.option, Config.map(Option.getOrUndefined)),
  apiToken: Config.Redacted('CLOUDFLARE_EMAIL_API_TOKEN').pipe(Config.option, Config.map(Option.getOrUndefined)),
});

const validApiToken = (apiToken: Redacted.Redacted): boolean => {
  const value = Redacted.value(apiToken);
  return value.length > 0 && value.length <= MAX_API_TOKEN_LENGTH && !/\s/u.test(value);
};

const resolveCredentials = (
  settings: CloudflareEmailApiSettings,
): { readonly accountId: string; readonly apiToken: Redacted.Redacted } | undefined => {
  if (settings.accountId === undefined || settings.apiToken === undefined) {
    return undefined;
  }
  if (!ACCOUNT_ID.test(settings.accountId) || !validApiToken(settings.apiToken)) {
    return undefined;
  }
  return { accountId: settings.accountId, apiToken: settings.apiToken };
};

export const isCloudflareEmailApiConfigured = (settings: CloudflareEmailApiSettings): boolean =>
  resolveCredentials(settings) !== undefined;

const hasForbiddenControlCharacter = (value: string, allows: (codePoint: number) => boolean): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) &&
      !allows(codePoint)
    ) {
      return true;
    }
  }
  return false;
};

const hasHeaderControlCharacter = (value: string): boolean => hasForbiddenControlCharacter(value, () => false);
const hasBodyControlCharacter = (value: string): boolean =>
  hasForbiddenControlCharacter(value, (codePoint) => codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d);

const validateMessage = (message: EmailDeliveryMessage): EmailDeliveryInvalidMessage | undefined => {
  if (!EMAIL_ADDRESS.test(message.to)) {
    return new EmailDeliveryInvalidMessage({ field: 'to', reason: 'invalid_format' });
  }
  if (message.subject.length === 0) {
    return new EmailDeliveryInvalidMessage({ field: 'subject', reason: 'empty' });
  }
  if (hasHeaderControlCharacter(message.subject)) {
    return new EmailDeliveryInvalidMessage({ field: 'subject', reason: 'control_character' });
  }
  const text = Redacted.value(message.text);
  if (text.length === 0) {
    return new EmailDeliveryInvalidMessage({ field: 'text', reason: 'empty' });
  }
  if (hasBodyControlCharacter(text)) {
    return new EmailDeliveryInvalidMessage({ field: 'text', reason: 'control_character' });
  }
  if (message.html !== undefined && hasBodyControlCharacter(Redacted.value(message.html))) {
    return new EmailDeliveryInvalidMessage({ field: 'html', reason: 'control_character' });
  }
  return undefined;
};

/** The submission body. Encoding goes through this schema so JSON key order and escaping are owned here. */
const CloudflareSubmissionRequestSchema = Schema.Struct({
  from: Schema.String,
  html: Schema.optionalKey(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  to: Schema.String,
});
const encodeSubmissionRequest = Schema.encodeEffect(Schema.fromJsonString(CloudflareSubmissionRequestSchema));

const submissionRequest = (
  configuration: CloudflareEmailApiConfig,
  message: EmailDeliveryMessage,
): typeof CloudflareSubmissionRequestSchema.Type => {
  const payload = {
    from: configuration.from.trim(),
    subject: message.subject,
    text: Redacted.value(message.text),
    to: message.to,
  };
  return message.html === undefined ? payload : { ...payload, html: Redacted.value(message.html) };
};

/** A 2xx envelope. `result.message_id` identifies the submission; the recipient lists decide whether it was accepted. */
const CloudflareSubmissionSchema = Schema.Struct({
  result: Schema.Struct({
    delivered: Schema.Array(Schema.String),
    message_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    permanent_bounces: Schema.Array(Schema.String),
    queued: Schema.Array(Schema.String),
    suppressed_recipients: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
});
const decodeSubmission = Schema.decodeUnknownEffect(CloudflareSubmissionSchema);

/** Keeps the underlying failure as a redacted cause, as the Workers adapter does, without exposing it in messages. */
const withRedactedCause = <E extends object>(error: E, cause: unknown): E =>
  Object.defineProperty(error, 'cause', { value: Redacted.make(cause) });
const invalidResponse = (cause: unknown) =>
  withRedactedCause(new EmailDeliveryAcceptanceIndeterminate({ reason: 'response_invalid' }), cause);
const transportFailure = (cause: unknown) =>
  withRedactedCause(new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' }), cause);
const timedOut = () => new EmailDeliveryAcceptanceIndeterminate({ reason: 'timeout' });

/** 5xx may follow an accepted submission, so it is unavailable rather than a rejection. */
const classifyRejected = (status: number): EmailDeliveryError =>
  status >= 500
    ? new EmailDeliveryUnavailable({ reason: 'provider_unavailable', status })
    : new EmailDeliveryRejected({ reason: status === 429 ? 'rate_limited' : 'provider_rejected', status });

const receiptFor = (
  to: string,
  status: number,
  submission: typeof CloudflareSubmissionSchema.Type,
): Effect.Effect<EmailDeliveryReceipt, EmailDeliveryError> => {
  const recipient = to.trim().toLowerCase();
  const listed = (addresses: readonly string[]) => addresses.some((address) => address.toLowerCase() === recipient);
  const { delivered, permanent_bounces, queued, suppressed_recipients = [] } = submission.result;
  if (listed(delivered) || listed(queued)) {
    return Effect.succeed({ accepted: true as const, id: submission.result.message_id });
  }
  if (listed(permanent_bounces) || listed(suppressed_recipients)) {
    return Effect.fail(new EmailDeliveryRejected({ reason: 'provider_rejected', status }));
  }
  return Effect.fail(invalidResponse('recipient_not_listed'));
};

/** One exchange: the status plus the parsed JSON body on a 2xx, or null when the body is not JSON. */
interface CloudflareExchange {
  readonly body: unknown;
  readonly status: number;
}

const exchange = (
  fetchImpl: typeof globalThis.fetch,
  url: string,
  token: Redacted.Redacted,
  body: string,
  timeout: Duration.Input,
) => {
  // Interrupting the request (the timeout below) aborts the fetch, so a stalled submission is cancelled too.
  const controller = new AbortController();
  return Effect.tryPromise({
    catch: (cause) => transportFailure(cause),
    try: fetchImpl.bind(globalThis, url, {
      body,
      headers: { authorization: `Bearer ${Redacted.value(token)}`, 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    }),
  }).pipe(
    Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({ catch: (cause) => transportFailure(cause), try: response.json.bind(response) }).pipe(
            // A success status with an unreadable body still reports the status; the caller decodes the body.
            Effect.orElseSucceed(() => null),
            Effect.map((parsed): CloudflareExchange => ({ body: parsed, status: response.status })),
          )
        : Effect.succeed<CloudflareExchange>({ body: null, status: response.status }),
    ),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(timedOut()),
    }),
  );
};

const sendWithCloudflare = (
  fetchImpl: typeof globalThis.fetch,
  configuration: CloudflareEmailApiConfig,
  message: EmailDeliveryMessage,
): Effect.Effect<EmailDeliveryReceipt, EmailDeliveryError> => {
  const credentials = resolveCredentials(configuration);
  if (credentials === undefined || configuration.from.trim() === '' || hasHeaderControlCharacter(configuration.from)) {
    return Effect.fail(new EmailDeliveryUnavailable({ reason: 'configuration' }));
  }
  const messageFailure = validateMessage(message);
  if (messageFailure !== undefined) {
    return Effect.fail(messageFailure);
  }
  const url = `${CLOUDFLARE_API_ORIGIN}/accounts/${credentials.accountId}/email/sending/send`;
  return encodeSubmissionRequest(submissionRequest(configuration, message)).pipe(
    Effect.mapError((cause) => withRedactedCause(new EmailDeliveryUnavailable({ reason: 'configuration' }), cause)),
    Effect.flatMap((body) =>
      exchange(fetchImpl, url, credentials.apiToken, body, configuration.timeout ?? DEFAULT_CLOUDFLARE_TIMEOUT),
    ),
    Effect.flatMap(({ body: parsed, status }) => {
      if (status < 200 || status >= 300) {
        return Effect.fail(classifyRejected(status));
      }
      return decodeSubmission(parsed).pipe(
        Effect.mapError((cause) => invalidResponse(cause)),
        Effect.flatMap((submission) => receiptFor(message.to, status, submission)),
      );
    }),
  );
};

/**
 * One Cloudflare Email Service REST submission per send, with no automatic retry. The Node stage host uses
 * this instead of SMTP because the platform blocks outbound SMTP over implicit TLS on port 465. The fetch
 * implementation is an explicit parameter so tests can substitute a fixture.
 */
export const CloudflareEmailApiDeliveryLive = (
  configuration: CloudflareEmailApiConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) =>
  Layer.succeed(EmailDeliveryService, {
    send: (message: EmailDeliveryMessage) => sendWithCloudflare(fetchImpl, configuration, message),
  } satisfies EmailDeliveryServiceContract);
