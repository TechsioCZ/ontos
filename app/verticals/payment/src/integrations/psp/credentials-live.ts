import { Cache, Config, Duration, Effect, Exit, Layer, Match, Option, Redacted, Schema } from 'effect';

import type { PaymentGatewayProviderFamilySchema } from '../../../shared/domain/payment-vocabulary.ts';
import type { GatewayCredentialSecretRef } from '../../../shared/domain/psp-configuration.ts';
import { GopayClientIdSchema, ProviderCredentialStore } from './credentials.ts';
import type { ProviderCredentialMaterial, ProviderCredentialStoreContract } from './credentials.ts';
import { GatewayProviderUnavailable } from './psp-errors.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';

/**
 * Live `ProviderCredentialStore` (#1155, #1154, #1158; plan D5). All gateway credential material
 * lives in one deployment value `ONTOS_PAYMENT_PROVIDER_CREDENTIALS`, a JSON object keyed by the
 * opaque secret ref: `{ "<secretRef>": { "family": "GOPAY", "clientId": "...", "clientSecret": "..." } }`.
 *
 * The value is read on each cache miss of a `resolve`, never while the Layer is built, and only the
 * requested entry is decoded. A missing, malformed, unknown or wrong-family entry fails that
 * resolve only; other refs and other families keep resolving. Decoded entries are cached per ref
 * for a short time so a rotated value is picked up; failures are never cached.
 *
 * Failure reasons are fixed codes. Neither the raw value nor a decode issue (which could echo it)
 * is ever placed in an error or a log.
 */

const CREDENTIALS_VARIABLE = 'ONTOS_PAYMENT_PROVIDER_CREDENTIALS';
const CREDENTIAL_CACHE_CAPACITY = 256;
const CREDENTIAL_CACHE_TTL = Duration.seconds(60);

type ProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

const CredentialFailureReasonSchema = Schema.Literals([
  'credentials_unavailable',
  'credentials_malformed',
  'credential_ref_unknown',
  'credential_entry_invalid',
]);
type CredentialFailureReason = typeof CredentialFailureReasonSchema.Type;

const secretValue = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)));

/** The JSON shape of one entry; `family` names the provider and must match the requested family. */
const ProviderCredentialEntrySchema = Schema.Union([
  Schema.Struct({ clientId: GopayClientIdSchema, clientSecret: secretValue, family: Schema.Literal('GOPAY') }),
  Schema.Struct({ family: Schema.Literal('STRIPE'), secretKey: secretValue, webhookSigningSecret: secretValue }),
  Schema.Struct({ family: Schema.Literal('COMGATE'), secret: secretValue }),
]);
type ProviderCredentialEntry = typeof ProviderCredentialEntrySchema.Type;

/** Top level only: entries stay undecoded JSON until one of them is requested. */
const ProviderCredentialDocumentSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

const decodeDocument = Schema.decodeUnknownEffect(ProviderCredentialDocumentSchema);
const decodeEntry = Schema.decodeUnknownEffect(ProviderCredentialEntrySchema);

interface CredentialFailure {
  readonly reason: CredentialFailureReason;
}

const credentialFailure = (reason: CredentialFailureReason): CredentialFailure => ({ reason });

const familyOf = (material: ProviderCredentialMaterial): ProviderFamily =>
  Match.value(material).pipe(
    Match.tagsExhaustive({
      COMGATE: () => 'COMGATE' as const,
      GOPAY: () => 'GOPAY' as const,
      STRIPE: () => 'STRIPE' as const,
    }),
  );

const toMaterial = (entry: ProviderCredentialEntry): ProviderCredentialMaterial =>
  Match.value(entry).pipe(
    Match.discriminatorsExhaustive('family')({
      COMGATE: ({ secret }) => ({ _tag: 'COMGATE' as const, secret }),
      GOPAY: ({ clientId, clientSecret }) => ({ _tag: 'GOPAY' as const, clientId, clientSecret }),
      STRIPE: ({ secretKey, webhookSigningSecret }) => ({ _tag: 'STRIPE' as const, secretKey, webhookSigningSecret }),
    }),
  );

/** Reads the deployment value and decodes the single entry named by `secretRef`. */
const loadCredentialEntry = (
  secretRef: GatewayCredentialSecretRef,
): Effect.Effect<ProviderCredentialMaterial, CredentialFailure> =>
  Config.option(Config.Redacted(CREDENTIALS_VARIABLE)).pipe(
    Effect.catchTag('ConfigError', () => Effect.fail(credentialFailure('credentials_unavailable'))),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(credentialFailure('credentials_unavailable')),
        onSome: (raw) =>
          decodeDocument(Redacted.value(raw)).pipe(
            Effect.catchTag('SchemaError', () => Effect.fail(credentialFailure('credentials_malformed'))),
          ),
      }),
    ),
    Effect.flatMap((document) =>
      Object.hasOwn(document, secretRef)
        ? Effect.succeed(document[secretRef])
        : Effect.fail(credentialFailure('credential_ref_unknown')),
    ),
    Effect.flatMap((entry) =>
      decodeEntry(entry, { onExcessProperty: 'error' }).pipe(
        Effect.catchTag('SchemaError', () => Effect.fail(credentialFailure('credential_entry_invalid'))),
      ),
    ),
    Effect.map(toMaterial),
  );

const unavailable = (family: ProviderFamily, reason: CredentialFailureReason): GatewayProviderUnavailableError =>
  new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason });

const makeProviderCredentialStore = Effect.gen(function* makeProviderCredentialStoreEffect() {
  const cache = yield* Cache.makeWith(loadCredentialEntry, {
    capacity: CREDENTIAL_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? CREDENTIAL_CACHE_TTL : Duration.zero),
  });
  return {
    resolve: ({ family, secretRef }) =>
      Cache.get(cache, secretRef).pipe(
        Effect.flatMap((material) =>
          familyOf(material) === family
            ? Effect.succeed(material)
            : Effect.fail(credentialFailure('credential_entry_invalid')),
        ),
        Effect.tapError(({ reason }) =>
          Effect.annotateLogs(Effect.logWarning('Payment provider credential unavailable'), {
            family,
            reason,
            secretRef,
          }),
        ),
        Effect.mapError(({ reason }) => unavailable(family, reason)),
        Effect.withSpan('Payment.PSP.credentials.resolve', { attributes: { family } }),
      ),
  } satisfies ProviderCredentialStoreContract;
});

export const ProviderCredentialStoreLive = Layer.effect(ProviderCredentialStore, makeProviderCredentialStore);
