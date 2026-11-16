import { Clock, Config, Context, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect';

import { PaymentReconciliationApiKeySchema } from '../../../shared/payment-gateway-relay.ts';
import { PaymentTenantIdSchema } from '../../../shared/domain/payment-identifiers.ts';

/**
 * Reconciliation driver credentials (#1158, phase 2 D-P5): `ONTOS_PAYMENT_RECONCILIATION_CREDENTIALS` is a
 * JSON array `[{ tenantId, apiKey }]`, one managed API key of the Tenant's integration principal bound to
 * `payment.provider-reconciliation` and `payment.source-ingress`. It is read once per driver tick, never
 * while a layer builds, and every entry is decoded on its own, so one malformed entry never disables another
 * Tenant. A Tenant without exactly one valid entry has no key: the driver skips that Tenant and says so at
 * most once per hour. No key value ever leaves this module except as `Redacted`, and nothing is logged
 * about an entry beyond the Tenant it was looked up for.
 */
export const PAYMENT_RECONCILIATION_CREDENTIALS_VARIABLE = 'ONTOS_PAYMENT_RECONCILIATION_CREDENTIALS';

/** A missing key is an operator fact; repeating it every minute would only bury it. */
const MISSING_KEY_LOG_INTERVAL_MS = 3_600_000;

const CredentialDocumentSchema = Schema.fromJsonString(Schema.Array(Schema.Json));
const CredentialEntrySchema = Schema.Struct({
  apiKey: Schema.RedactedFromValue(PaymentReconciliationApiKeySchema.check(Schema.isTrimmed())),
  tenantId: PaymentTenantIdSchema,
});
const decodeDocument = Schema.decodeUnknownEffect(CredentialDocumentSchema);
const decodeEntry = Schema.decodeUnknownOption(CredentialEntrySchema, { onExcessProperty: 'error' });

export type ReconciliationApiKey = Redacted.Redacted<typeof PaymentReconciliationApiKeySchema.Type>;

/** The keys one tick may use. */
export interface ReconciliationTickCredentials {
  /** The Tenant's single valid key; `None` (logged at most hourly) when it has none or more than one. */
  readonly forTenant: (tenantId: string) => Effect.Effect<Option.Option<ReconciliationApiKey>>;
}

export interface ReconciliationCredentialsContract {
  /** Reads and decodes the variable now; an absent or unreadable document is a tick without any key. */
  readonly load: Effect.Effect<ReconciliationTickCredentials>;
}

export class ReconciliationCredentials extends Context.Service<
  ReconciliationCredentials,
  ReconciliationCredentialsContract
>()('@app/payment/integrations/psp/reconciliation-credentials/ReconciliationCredentials') {}

const readKeys = Effect.gen(function* readReconciliationKeys() {
  const configured = yield* Config.option(Config.Redacted(PAYMENT_RECONCILIATION_CREDENTIALS_VARIABLE)).pipe(
    Effect.catchTag('ConfigError', () => Effect.succeedNone),
  );
  if (Option.isNone(configured)) {
    return new Map<string, readonly ReconciliationApiKey[]>();
  }
  const entries = yield* decodeDocument(Redacted.value(configured.value)).pipe(
    Effect.catchTag('SchemaError', () => Effect.succeed([])),
  );
  const keys = new Map<string, readonly ReconciliationApiKey[]>();
  for (const entry of entries) {
    const decoded = Option.getOrUndefined(decodeEntry(entry));
    if (decoded !== undefined) {
      keys.set(decoded.tenantId, [...(keys.get(decoded.tenantId) ?? []), decoded.apiKey]);
    }
  }
  return keys;
});

export const ReconciliationCredentialsLive = Layer.effect(
  ReconciliationCredentials,
  Effect.gen(function* makeReconciliationCredentials() {
    const lastLogged = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const reportMissing = Effect.fn('ReconciliationCredentials.reportMissing')(function* reportMissing(
      tenantId: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const due = yield* Ref.modify(lastLogged, (logged) => {
        const previous = logged.get(tenantId);
        return previous !== undefined && now - previous < MISSING_KEY_LOG_INTERVAL_MS
          ? [false, logged]
          : [true, new Map([...logged, [tenantId, now]])];
      });
      if (due) {
        // The Tenant is the misconfigured value an operator must fix, not ambient request identity.
        yield* Effect.annotateLogs(
          Effect.logWarning('The Payment reconciliation driver has no single valid key for a Tenant'),
          { tenantWithoutKey: tenantId },
        );
      }
    });
    return ReconciliationCredentials.of({
      load: readKeys.pipe(
        Effect.map((keys): ReconciliationTickCredentials => ({
          forTenant: (tenantId) => {
            const [key, ...others] = keys.get(tenantId) ?? [];
            return key !== undefined && others.length === 0
              ? Effect.succeedSome(key)
              : reportMissing(tenantId).pipe(Effect.as(Option.none<ReconciliationApiKey>()));
          },
        })),
      ),
    });
  }),
);
