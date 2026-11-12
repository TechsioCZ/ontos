import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Config, Effect, Option, Redacted, Schema } from 'effect';

/**
 * Shell-held relay credentials (#1157, phase 2 D-P4): `ONTOS_PAYMENT_NOTIFICATION_RELAY_CREDENTIALS` is a
 * JSON array `[{ tenantId, apiKey }]`, one managed integration API key per tenant. It is read for every
 * request and every entry is decoded on its own, so one malformed entry never disables another tenant.
 * A tenant without exactly one valid entry has no relay credential: the relay answers as for an unknown
 * route. No key value ever leaves this module except as `Redacted`.
 */
export const PAYMENT_NOTIFICATION_RELAY_CREDENTIALS_VARIABLE = 'ONTOS_PAYMENT_NOTIFICATION_RELAY_CREDENTIALS';

const RelayCredentialDocumentSchema = Schema.fromJsonString(Schema.Array(Schema.Json));
const RelayApiKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000), Schema.isTrimmed()).pipe(
  Schema.brand('PaymentNotificationRelayApiKey'),
);
const RelayCredentialEntrySchema = Schema.Struct({
  apiKey: Schema.RedactedFromValue(RelayApiKeySchema),
  tenantId: TenantIdSchema,
});
const decodeDocument = Schema.decodeUnknownEffect(RelayCredentialDocumentSchema);
const decodeEntry = Schema.decodeUnknownOption(RelayCredentialEntrySchema, { onExcessProperty: 'error' });

export const resolveNotificationRelayCredential = Effect.fn('PaymentRelayCredentials.resolve')(function* resolve(
  tenantId: string,
) {
  const configured = yield* Config.option(Config.Redacted(PAYMENT_NOTIFICATION_RELAY_CREDENTIALS_VARIABLE)).pipe(
    Effect.catchTag('ConfigError', () => Effect.succeed(Option.none<Redacted.Redacted>())),
  );
  if (Option.isNone(configured)) {
    return Option.none<Redacted.Redacted>();
  }
  const entries = yield* decodeDocument(Redacted.value(configured.value)).pipe(
    Effect.catchTag('SchemaError', () => Effect.succeed([])),
  );
  const keys = entries.flatMap((entry) =>
    Option.match(decodeEntry(entry), {
      onNone: () => [],
      onSome: (decoded) => (decoded.tenantId === tenantId ? [decoded.apiKey] : []),
    }),
  );
  const [key] = keys;
  return keys.length === 1 && key !== undefined
    ? Option.some<Redacted.Redacted>(key)
    : Option.none<Redacted.Redacted>();
});
