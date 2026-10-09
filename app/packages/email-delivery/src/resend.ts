import type {
  EmailDeliveryError,
  EmailDeliveryMessage,
  EmailDeliveryReceipt,
  EmailDeliveryServiceContract,
} from './server.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryRejected,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from './server.ts';
import { ResendEmailDeliveryConfigurationError } from './configuration-error.ts';
import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Schema } from 'effect';
import type { Duration } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

/** The sole production endpoint used by the initial Resend adapter. */
export const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';

const DEFAULT_RESEND_TIMEOUT: Duration.Input = '10 seconds';
const MAX_API_KEY_LENGTH = 512;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_EMAIL_ADDRESS_LENGTH = 320;
const MAX_HEADER_LENGTH = 998;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export interface ResendEmailDeliveryConfigValue {
  readonly apiKey: Redacted.Redacted;
  readonly endpoint?: string | URL;
  readonly from: string;
  readonly timeout?: Duration.Input;
}

export class ResendEmailDeliveryConfig extends Context.Service<
  ResendEmailDeliveryConfig,
  ResendEmailDeliveryConfigValue
>()('@app/email-delivery/resend/ResendEmailDeliveryConfig') {}

export { ResendEmailDeliveryConfigurationError } from './configuration-error.ts';

export const ResendEnvironmentKeySchema = Schema.Literals(['RESEND_API_KEY', 'RESEND_API_URL', 'RESEND_FROM_EMAIL']);
export type ResendEnvironmentKey = typeof ResendEnvironmentKeySchema.Type;
export type ResendEmailDeliveryEnvironment = Readonly<Partial<Record<ResendEnvironmentKey, string>>>;

const configSource = Config.all({
  apiKey: Config.Redacted('RESEND_API_KEY'),
  endpoint: Config.String('RESEND_API_URL').pipe(Config.withDefault(RESEND_EMAILS_ENDPOINT)),
  from: Config.String('RESEND_FROM_EMAIL'),
});

const emailAddress = /^[^\s@<>()[\],:;]+@[^\s@<>()[\],:;]+$/u;

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

type InvalidField = EmailDeliveryInvalidMessage['field'];
type InvalidReason = EmailDeliveryInvalidMessage['reason'];

const invalid = (field: InvalidField, reason: InvalidReason) => new EmailDeliveryInvalidMessage({ field, reason });

const extractAddress = (value: string): string | undefined => {
  const trimmed = value.trim();
  const opening = trimmed.indexOf('<');
  if (opening === -1) {
    return trimmed;
  }
  if (!trimmed.endsWith('>') || trimmed.indexOf('>', opening + 1) !== trimmed.length - 1) {
    return undefined;
  }
  return trimmed.slice(opening + 1, -1).trim();
};

const validateAddress = (field: InvalidField, value: string): EmailDeliveryInvalidMessage | undefined => {
  if (value.trim().length === 0) {
    return invalid(field, 'empty');
  }
  if (value.length > MAX_EMAIL_ADDRESS_LENGTH || hasHeaderControlCharacter(value)) {
    return invalid(field, value.length > MAX_EMAIL_ADDRESS_LENGTH ? 'too_long' : 'control_character');
  }
  const address = extractAddress(value);
  return address === undefined || !emailAddress.test(address) ? invalid(field, 'invalid_format') : undefined;
};

const validateHeader = (field: InvalidField, value: string): EmailDeliveryInvalidMessage | undefined => {
  if (value.trim().length === 0) {
    return invalid(field, 'empty');
  }
  if (value.length > MAX_HEADER_LENGTH) {
    return invalid(field, 'too_long');
  }
  return hasHeaderControlCharacter(value) ? invalid(field, 'control_character') : undefined;
};

const validateContent = (field: InvalidField, value: string): EmailDeliveryInvalidMessage | undefined => {
  if (value.length === 0) {
    return invalid(field, 'empty');
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    return invalid(field, 'too_long');
  }
  return hasBodyControlCharacter(value) ? invalid(field, 'control_character') : undefined;
};

const validateIdempotencyKey = (value: string): EmailDeliveryInvalidMessage | undefined => {
  if (value.length === 0) {
    return invalid('idempotencyKey', 'empty');
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return invalid('idempotencyKey', 'too_long');
  }
  return hasHeaderControlCharacter(value) ? invalid('idempotencyKey', 'control_character') : undefined;
};

const resolveEndpoint = (endpoint: string | URL | undefined): string | undefined => {
  try {
    const parsed = new URL(endpoint ?? RESEND_EMAILS_ENDPOINT);
    return parsed.protocol === 'https:' && parsed.username.length === 0 && parsed.password.length === 0
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const validApiKey = (apiKey: Redacted.Redacted): boolean => {
  const value = Redacted.value(apiKey);
  return value.length > 0 && value.length <= MAX_API_KEY_LENGTH && !hasHeaderControlCharacter(value);
};

const validateConfiguration = (configuration: ResendEmailDeliveryConfigValue): boolean =>
  validApiKey(configuration.apiKey) &&
  validateAddress('from', configuration.from) === undefined &&
  resolveEndpoint(configuration.endpoint) !== undefined;

const validateMessage = (
  configuration: ResendEmailDeliveryConfigValue,
  message: EmailDeliveryMessage,
): EmailDeliveryInvalidMessage | undefined => {
  const addressFailure = validateAddress('to', message.to);
  if (addressFailure !== undefined) {
    return addressFailure;
  }
  const subjectFailure = validateHeader('subject', message.subject);
  if (subjectFailure !== undefined) {
    return subjectFailure;
  }
  const text = Redacted.value(message.text);
  const textFailure = validateContent('text', text);
  if (textFailure !== undefined) {
    return textFailure;
  }
  if (message.html !== undefined) {
    const htmlFailure = validateContent('html', Redacted.value(message.html));
    if (htmlFailure !== undefined) {
      return htmlFailure;
    }
  }
  if (message.idempotencyKey !== undefined) {
    const idempotencyFailure = validateIdempotencyKey(message.idempotencyKey);
    if (idempotencyFailure !== undefined) {
      return idempotencyFailure;
    }
  }
  return validateAddress('from', configuration.from);
};

interface ResendEmailPayload {
  readonly from: string;
  readonly html?: string;
  readonly subject: string;
  readonly text: string;
  readonly to: readonly [string];
}

const makePayload = (
  configuration: ResendEmailDeliveryConfigValue,
  message: EmailDeliveryMessage,
): ResendEmailPayload => {
  const payload = {
    from: configuration.from.trim(),
    subject: message.subject,
    text: Redacted.value(message.text),
    to: [message.to.trim()] as const,
  };
  return message.html === undefined ? payload : { ...payload, html: Redacted.value(message.html) };
};

const ResendResponseSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

const invalidResponse = () => new EmailDeliveryAcceptanceIndeterminate({ reason: 'response_invalid' });
const transportFailure = () => new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' });
const timedOut = () => new EmailDeliveryAcceptanceIndeterminate({ reason: 'timeout' });
const invalidResponseFailure = () => Effect.fail(invalidResponse());

const classifyRejected = (status: number): EmailDeliveryError =>
  new EmailDeliveryRejected({
    reason: status === 429 ? 'rate_limited' : 'provider_rejected',
    status,
  });

const sendWithResend = (
  httpClient: HttpClient.HttpClient,
  configuration: ResendEmailDeliveryConfigValue,
  message: EmailDeliveryMessage,
): Effect.Effect<EmailDeliveryReceipt, EmailDeliveryError> => {
  if (!validateConfiguration(configuration)) {
    return Effect.fail(new EmailDeliveryUnavailable({ reason: 'configuration' }));
  }
  const messageFailure = validateMessage(configuration, message);
  if (messageFailure !== undefined) {
    return Effect.fail(messageFailure);
  }
  const endpoint = resolveEndpoint(configuration.endpoint);
  if (endpoint === undefined) {
    return Effect.fail(new EmailDeliveryUnavailable({ reason: 'configuration' }));
  }
  const payload = makePayload(configuration, message);
  let request = HttpClientRequest.post(endpoint, { acceptJson: true });
  request = HttpClientRequest.bodyJsonUnsafe(payload)(request);
  request = HttpClientRequest.setHeader(request, 'authorization', `Bearer ${Redacted.value(configuration.apiKey)}`);
  if (message.idempotencyKey !== undefined) {
    request = HttpClientRequest.setHeader(request, 'idempotency-key', message.idempotencyKey);
  }
  return httpClient.execute(request).pipe(
    Effect.flatMap((response) => {
      if (response.status >= 200 && response.status < 300) {
        return HttpClientResponse.schemaBodyJson(ResendResponseSchema, { onExcessProperty: 'ignore' })(response).pipe(
          Effect.catchTags({
            HttpClientError: invalidResponseFailure,
            SchemaError: invalidResponseFailure,
          }),
          Effect.map(({ id }) => ({ accepted: true as const, id })),
        );
      }
      return response.status >= 500
        ? Effect.fail(new EmailDeliveryUnavailable({ reason: 'provider_unavailable', status: response.status }))
        : Effect.fail(classifyRejected(response.status));
    }),
    Effect.catchTag('HttpClientError', () => Effect.fail(transportFailure())),
    Effect.timeoutOrElse({
      duration: configuration.timeout ?? DEFAULT_RESEND_TIMEOUT,
      orElse: () => Effect.fail(timedOut()),
    }),
  );
};

const parseConfig = Effect.fn('ResendEmailDeliveryConfig.parse')(function* parseConfigEffect(
  provider: ConfigProvider.ConfigProvider,
): Effect.fn.Return<ResendEmailDeliveryConfigValue, ResendEmailDeliveryConfigurationError> {
  const source = yield* configSource
    .parse(provider)
    .pipe(
      Effect.catchTag('ConfigError', () =>
        Effect.fail(new ResendEmailDeliveryConfigurationError({ reason: 'api_key' })),
      ),
    );
  const endpoint = resolveEndpoint(source.endpoint);
  if (!validApiKey(source.apiKey)) {
    return yield* new ResendEmailDeliveryConfigurationError({ reason: 'api_key' });
  }
  if (validateAddress('from', source.from) !== undefined) {
    return yield* new ResendEmailDeliveryConfigurationError({ reason: 'from' });
  }
  if (endpoint === undefined) {
    return yield* new ResendEmailDeliveryConfigurationError({ reason: 'endpoint' });
  }
  return { apiKey: source.apiKey, endpoint, from: source.from.trim() };
});

export const parseResendEmailDeliveryConfig = (
  environment: ResendEmailDeliveryEnvironment,
): Effect.Effect<ResendEmailDeliveryConfigValue, ResendEmailDeliveryConfigurationError> =>
  parseConfig(ConfigProvider.fromEnvRecord(environment));

export const ResendEmailDeliveryConfigLive = Layer.effect(
  ResendEmailDeliveryConfig,
  parseConfig(ConfigProvider.fromEnv()),
);

export const ResendEmailDeliveryLive = Layer.effect(
  EmailDeliveryService,
  Effect.gen(function* makeResendEmailDeliveryEffect() {
    const configuration = yield* ResendEmailDeliveryConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const service: EmailDeliveryServiceContract = {
      send: (message) => sendWithResend(httpClient, configuration, message),
    };
    return service;
  }),
);
