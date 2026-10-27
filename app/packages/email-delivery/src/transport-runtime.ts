import { Config, Effect, Option, Schema } from 'effect';
import type { Layer } from 'effect';

import type { EmailProviderView } from './dispatcher/contract.ts';
import type { EmailDeliveryService } from './server.ts';

/** Finite deployment settings shared by the dispatcher and its request adapters. */
export const EmailEnvironmentSchema = Schema.Struct({
  AKROS_EMAIL_FROM: Schema.optional(Schema.String),
  AKROS_INQUIRY_EMAIL_TO: Schema.optional(Schema.String),
  AKROS_STOREFRONT_PUBLIC_URL: Schema.optional(Schema.String),
  EMAIL_PROVIDER: Schema.optional(Schema.String),
  EMAIL_TEST_SMTP_HOST: Schema.optional(Schema.String),
  EMAIL_TEST_SMTP_PORT: Schema.optional(Schema.String),
  OBCHODNI_FIRMA_EMAIL_FROM: Schema.optional(Schema.String),
  ONTOS_EMAIL_DISPATCH_SECRET: Schema.optional(Schema.RedactedFromValue(Schema.String)),
  ONTOS_EMAIL_FROM: Schema.optional(Schema.String),
  ONTOS_EMAIL_UNDELIVERABLE_DOMAINS: Schema.optional(Schema.String),
  ONTOS_PUBLIC_URL: Schema.optional(Schema.String),
  SIAMPARK_AGENDA_EMAIL_FROM: Schema.optional(Schema.String),
  SIAMPARK_EMAIL_FROM: Schema.optional(Schema.String),
  SMTP_FROM: Schema.optional(Schema.String),
});
export type EmailEnvironment = typeof EmailEnvironmentSchema.Type;
export type EmailEnvironmentInput = typeof EmailEnvironmentSchema.Encoded;

const optionalString = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined));

export const emailSettings = Config.all({
  AKROS_EMAIL_FROM: optionalString('AKROS_EMAIL_FROM'),
  AKROS_INQUIRY_EMAIL_TO: optionalString('AKROS_INQUIRY_EMAIL_TO'),
  AKROS_STOREFRONT_PUBLIC_URL: optionalString('AKROS_STOREFRONT_PUBLIC_URL'),
  EMAIL_PROVIDER: optionalString('EMAIL_PROVIDER'),
  EMAIL_TEST_SMTP_HOST: optionalString('EMAIL_TEST_SMTP_HOST'),
  EMAIL_TEST_SMTP_PORT: optionalString('EMAIL_TEST_SMTP_PORT'),
  OBCHODNI_FIRMA_EMAIL_FROM: optionalString('OBCHODNI_FIRMA_EMAIL_FROM'),
  ONTOS_EMAIL_DISPATCH_SECRET: Config.Redacted('ONTOS_EMAIL_DISPATCH_SECRET').pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  ONTOS_EMAIL_FROM: optionalString('ONTOS_EMAIL_FROM'),
  ONTOS_EMAIL_UNDELIVERABLE_DOMAINS: optionalString('ONTOS_EMAIL_UNDELIVERABLE_DOMAINS'),
  ONTOS_PUBLIC_URL: optionalString('ONTOS_PUBLIC_URL'),
  SIAMPARK_AGENDA_EMAIL_FROM: optionalString('SIAMPARK_AGENDA_EMAIL_FROM'),
  SIAMPARK_EMAIL_FROM: optionalString('SIAMPARK_EMAIL_FROM'),
  SMTP_FROM: optionalString('SMTP_FROM'),
});

/** A Layer per configured submission; its resources belong to the dispatching request. */
export interface EmailTransportRuntime {
  readonly deliveryLayer: (from: string, recipient: string) => Layer.Layer<EmailDeliveryService>;
  readonly kind: 'cloudflare' | 'smtp';
  readonly provider: EmailProviderView;
}

export const configuredProvider = Config.String('EMAIL_PROVIDER').pipe(
  Config.withDefault('smtp'),
  Config.map((value) => value.trim().toLowerCase()),
  Config.mapEffect((value) =>
    Schema.decodeUnknownEffect(Schema.Literals(['smtp', 'cloudflare', 'none']))(value).pipe(
      Effect.mapError((issue) => new Config.ConfigError(issue)),
    ),
  ),
);
