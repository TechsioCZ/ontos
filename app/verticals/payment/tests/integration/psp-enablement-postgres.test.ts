import type { PgClient } from '@effect/sql-pg';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { GatewayEnablementRejected } from '../../shared/actions/configure-gateway-enablement.ts';
import type { ConfigureGatewayEnablementPayload } from '../../shared/actions/configure-gateway-enablement.ts';
import { GatewayConfigurationResponseSchema } from '../../shared/apis/gateway-configuration.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import { paymentUnavailable, PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayProviderAccountRefSchema } from '../../shared/domain/psp-configuration.ts';
import type { GatewayProviderAccountRef } from '../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import { configureGatewayEnablementAction } from '../../src/actions/configure-gateway-enablement.action.ts';
import { readGatewayConfiguration } from '../../src/api/gateway-configuration.read.ts';
import { gatewayBindingServiceForTransaction } from '../../src/integrations/psp/gateway-binding-live.ts';
import { paymentEvidencePersistenceForTransaction } from '../../src/persistence/payment-evidence-persistence.ts';
import { paymentSourcePersistenceForTransaction } from '../../src/persistence/payment-source-persistence.ts';
import {
  pspEnablementPersistenceForTransaction,
  pspEnablementServicesForTransaction,
} from '../../src/persistence/psp-enablement-persistence.ts';
import type { PspEnablementServices } from '../../src/persistence/psp-enablement-persistence.ts';
import type {
  PaymentGatewayBindingEvidence,
  PaymentGatewayBindingVerification,
} from '../../src/ports/gateway-binding-port.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  COMPOSITION_REVISION,
  inScope,
  makeTestScope,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  randomUuid,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

/**
 * #1155/#1156 native evidence for `configure-gateway-enablement`, the `gateway-configuration` Read and the
 * live `GatewayBindingPort`: owner persistence on PostgreSQL as the shared runtime role under forced RLS,
 * with the Action run through its registered descriptor in the Core Action harness.
 */

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];
type ScopedTransaction = Effect.Success<ReturnType<typeof installOperationalScope>>;

const nativeDatabase = Effect.gen(function* nativeDatabase() {
  const { runtime: runtimeClient } = yield* testDatabaseClients;
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  return { runtime, runtimeClient };
});

const inTransaction = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (transaction: ScopedTransaction) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(Effect.flatMap(operation)),
  );

const isOwnerFailure = Schema.is(Schema.Union([GatewayEnablementRejected, PaymentUnavailable]));
const isUnavailable = Schema.is(PaymentUnavailable);
/** Transaction plumbing failures (driver, scope installation) become the owner's typed unavailability. */
type NativeFailure = Readonly<{ readonly _tag: string }>;
const ownerFailure = (failure: NativeFailure) =>
  isOwnerFailure(failure) ? failure : paymentUnavailable('Native transaction failed', failure);
const unavailableFailure = (failure: NativeFailure) =>
  isUnavailable(failure) ? failure : paymentUnavailable('Native transaction failed', failure);

/** The real Action services, each call in its own Core-scoped native transaction. */
const nativeEnablementServices = (database: PaymentTestDatabase, scope: PaymentTestScope): PspEnablementServices => {
  const withServices = <Value, Failure>(
    operation: (services: PspEnablementServices) => Effect.Effect<Value, Failure>,
  ) =>
    inTransaction(database, scope, (transaction) =>
      pspEnablementServicesForTransaction(transaction, operationalScopeOf(scope), COMPOSITION_REVISION).pipe(
        Effect.flatMap(operation),
      ),
    );
  return {
    enablement: {
      configureEnablement: (input) =>
        withServices((services) => services.enablement.configureEnablement(input)).pipe(Effect.mapError(ownerFailure)),
      listBindings: (limit) =>
        withServices((services) => services.enablement.listBindings(limit)).pipe(Effect.mapError(unavailableFailure)),
      listEnablements: (input) =>
        withServices((services) => services.enablement.listEnablements(input)).pipe(
          Effect.mapError(unavailableFailure),
        ),
      lockBinding: (input) =>
        withServices((services) => services.enablement.lockBinding(input)).pipe(Effect.mapError(unavailableFailure)),
    },
    sourceAuthorities: {
      lockGatewayAuthorities: (binding) =>
        withServices((services) => services.sourceAuthorities.lockGatewayAuthorities(binding)).pipe(
          Effect.mapError(unavailableFailure),
        ),
    },
  };
};

/** The live port, each call in its own Core-scoped native transaction of `scope`. */
const nativeGatewayPort = (database: PaymentTestDatabase, scope: PaymentTestScope): PaymentGatewayBindingEvidence => ({
  listEnabledBindings: (input) =>
    inTransaction(database, scope, (transaction) =>
      gatewayBindingServiceForTransaction(transaction).listEnabledBindings(input),
    ).pipe(Effect.orDie),
  resolveOriginalBinding: (input) =>
    inTransaction(database, scope, (transaction) =>
      gatewayBindingServiceForTransaction(transaction).resolveOriginalBinding(input),
    ).pipe(Effect.orDie),
  verifySelectedBinding: (input) =>
    inTransaction(database, scope, (transaction) =>
      gatewayBindingServiceForTransaction(transaction).verifySelectedBinding(input),
    ).pipe(Effect.orDie),
});

const MERCHANT_IDENTITIES = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<PaymentGatewayProviderFamily, string>;

interface TestBinding {
  readonly bindingId: string;
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly providerFamily: PaymentGatewayProviderFamily;
}

/** Inserts one CURRENT binding and its ACTIVE credential the way the binding configuration Action does. */
const insertBinding = Effect.fn('PspEnablementTest.insertBinding')(function* insertBinding(
  client: PgClient.PgClient,
  scope: PaymentTestScope,
  providerFamily: PaymentGatewayProviderFamily,
  environment: GatewayEnvironment = 'SANDBOX',
) {
  const bindingId = yield* randomUuid;
  const providerAccountRef = yield* Schema.decodeEffect(GatewayProviderAccountRefSchema)(
    `pab_${(yield* randomUuid).replaceAll('-', '')}`,
  );
  yield* inScope(
    client,
    scope,
    Effect.gen(function* insertBindingAndCredential() {
      yield* client.unsafe(
        `insert into payment.psp_provider_account_bindings (tenant_id, legal_entity_id, action_invocation_id,
           actor_principal_id, composition_revision, binding_id, configured_at, current_credential_revision,
           environment, merchant_identity, notification_url, provider_account_ref, provider_family, reason, revision, status)
         values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, $6, $7::jsonb,
           'https://hooks.example.test/psp', $8, $9, 'Configure the gateway account', 1, 'CURRENT')`,
        [
          scope.tenantId,
          scope.legalEntityId,
          scope.principalId,
          COMPOSITION_REVISION,
          bindingId,
          environment,
          MERCHANT_IDENTITIES[providerFamily],
          providerAccountRef,
          providerFamily,
        ],
      );
      yield* client.unsafe(
        `insert into payment.psp_credential_revisions (tenant_id, legal_entity_id, action_invocation_id,
           actor_principal_id, composition_revision, binding_id, recorded_at, revision, secret_ref, status)
         values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'never-shown-secret-ref', 'ACTIVE')`,
        [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_REVISION, bindingId],
      );
    }),
  );
  return { bindingId, environment, providerAccountRef, providerFamily } satisfies TestBinding;
});

const retireBinding = (client: PgClient.PgClient, scope: PaymentTestScope, binding: TestBinding) =>
  inScope(
    client,
    scope,
    client.unsafe(
      `update payment.psp_provider_account_bindings
       set status = 'RETIRED_FOR_NEW_INTENTS', revision = revision + 1, configured_at = now()
       where binding_id = $1`,
      [binding.bindingId],
    ),
  );

/** Configures the C16 source authorities of the binding through the C16 source persistence. */
const configureAuthorities = Effect.fn('PspEnablementTest.configureAuthorities')(function* configureAuthorities(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  binding: TestBinding,
  families: readonly ('GATEWAY_OUTCOME' | 'REFUND_EXECUTION')[],
) {
  for (const factFamily of families) {
    const provenance = yield* provenanceFor(scope);
    yield* inTransaction(database, scope, (transaction) =>
      paymentSourcePersistenceForTransaction(
        transaction,
        { principalId: scope.principalId },
        paymentEvidencePersistenceForTransaction(transaction),
      ).configureAuthority({
        expectedRevision: Option.getOrUndefined(Option.none<number>()),
        factFamily,
        method: 'ONLINE_GATEWAY',
        provenance,
        reason: 'Gateway source authority',
        refundRoute: factFamily === 'REFUND_EXECUTION',
        source: {
          accountRef: binding.providerAccountRef,
          environment: binding.environment,
          sourceKind: 'PAYMENT_GATEWAY',
          sourceSystem: binding.providerFamily,
        },
        status: 'ACTIVE',
        submitterPrincipalIds: [scope.principalId],
      }),
    );
  }
});

const principalOf = (scope: PaymentTestScope) => ({
  authBindingId: scope.principalId,
  authContextRef: 'better-auth-session:payment-gateway-enablement-tests',
  authMethod: 'session' as const,
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
});

const payloadFor = (
  binding: TestBinding,
  overrides: Partial<ConfigureGatewayEnablementPayload> = {},
): ConfigureGatewayEnablementPayload => ({
  customerConfigurationId: 'cc-gateway',
  enabled: true,
  environment: binding.environment,
  providerAccountRef: binding.providerAccountRef,
  reason: 'Offer the gateway',
  returnUrl: 'https://shop.example.test/payment/return',
  ...overrides,
});

const executionBindingOf = (binding: TestBinding): PaymentGatewayAccountBinding => ({
  _tag: 'GATEWAY_ACCOUNT',
  environment: binding.environment,
  providerAccountRef: binding.providerAccountRef,
  providerFamily: binding.providerFamily,
});

const harnessFor = (database: PaymentTestDatabase, scope: PaymentTestScope, access: 'allowed' | 'denied') =>
  makeActionTestHarness({
    access,
    ownerRegistration: paymentRegistration,
    services: [bindActionTestServices(configureGatewayEnablementAction, nativeEnablementServices(database, scope))],
  });

let keySequence = 0;
const runEnablement = (
  harness: Effect.Success<ReturnType<typeof harnessFor>>,
  scope: PaymentTestScope,
  payload: ConfigureGatewayEnablementPayload,
) => {
  keySequence += 1;
  return harness.runtime.runAction({
    payload,
    principal: principalOf(scope),
    registration: configureGatewayEnablementAction,
    transport: { correlationId: 'payment-gateway-enablement', idempotencyKey: `gateway-enablement-${keySequence}` },
  });
};

const isRejected = Schema.is(GatewayEnablementRejected);
const rejectionCode = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.flip(operation).pipe(Effect.map((failure) => (isRejected(failure) ? failure.code : failure)));

const isEnabled = (verification: PaymentGatewayBindingVerification) =>
  Match.value(verification).pipe(
    Match.tag('ENABLED', () => true),
    Match.tag('NOT_ENABLED', () => false),
    Match.exhaustive,
  );

const countEnablements = (client: PgClient.PgClient, scope: PaymentTestScope) =>
  inScope(
    client,
    scope,
    client.unsafe<{ readonly count: number }>(
      'select count(*)::integer as count from payment.psp_gateway_enablement_revisions',
    ),
  ).pipe(Effect.map((rows) => rows[0]?.count ?? -1));

describe('#1155 configure-gateway-enablement through the Core Action runtime', () => {
  it.live('#1155 Enable without source authorities is rejected and writes nothing', () =>
    Effect.scoped(
      Effect.gen(function* enableWithoutAuthorities() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const gopay = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        const harness = yield* harnessFor(runtime, scope, 'allowed');

        expect(yield* rejectionCode(runEnablement(harness, scope, payloadFor(gopay)))).toBe(
          'gateway_source_authority_missing',
        );
        yield* configureAuthorities(runtime, scope, gopay, ['GATEWAY_OUTCOME']);
        expect(yield* rejectionCode(runEnablement(harness, scope, payloadFor(gopay)))).toBe(
          'gateway_source_authority_missing',
        );
        expect(yield* countEnablements(runtimeClient, scope)).toBe(0);

        yield* configureAuthorities(runtime, scope, gopay, ['REFUND_EXECUTION']);
        const enabled = yield* runEnablement(harness, scope, payloadFor(gopay));
        expect(enabled).toMatchObject({
          bindingId: gopay.bindingId,
          changed: true,
          enabled: true,
          environment: 'SANDBOX',
          providerFamily: 'GOPAY',
          revision: 1,
        });
        // Disabling never needs authorities and re-stating the Current state appends nothing.
        const disabled = yield* runEnablement(
          harness,
          scope,
          payloadFor(gopay, { enabled: false, expectedRevision: 1 }),
        );
        expect([disabled.changed, disabled.revision, disabled.enabled]).toEqual([true, 2, false]);
        const unchanged = yield* runEnablement(
          harness,
          scope,
          payloadFor(gopay, { enabled: false, expectedRevision: 2 }),
        );
        expect([unchanged.changed, unchanged.revision]).toEqual([false, 2]);
        expect(yield* rejectionCode(runEnablement(harness, scope, payloadFor(gopay, { expectedRevision: 7 })))).toBe(
          'gateway_enablement_revision_conflict',
        );
        expect(yield* countEnablements(runtimeClient, scope)).toBe(2);
      }),
    ),
  );

  it.live('#1155 Comgate enablement is no longer refused once its source authorities are active', () =>
    Effect.scoped(
      Effect.gen(function* comgateEnabled() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const comgate = yield* insertBinding(runtimeClient, scope, 'COMGATE');
        const harness = yield* harnessFor(runtime, scope, 'allowed');
        expect(yield* rejectionCode(runEnablement(harness, scope, payloadFor(comgate)))).toBe(
          'gateway_source_authority_missing',
        );
        yield* configureAuthorities(runtime, scope, comgate, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        const enabled = yield* runEnablement(harness, scope, payloadFor(comgate));
        expect(enabled).toMatchObject({
          bindingId: comgate.bindingId,
          changed: true,
          enabled: true,
          environment: 'SANDBOX',
          providerFamily: 'COMGATE',
          revision: 1,
        });
        expect(yield* countEnablements(runtimeClient, scope)).toBe(1);
      }),
    ),
  );

  it.live('#1155 A binding of another environment or Legal Entity is not found', () =>
    Effect.scoped(
      Effect.gen(function* bindingNotFound() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const otherLegalEntity = { ...scope, legalEntityId: yield* randomUuid };
        const gopay = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        yield* configureAuthorities(runtime, scope, gopay, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        const harness = yield* harnessFor(runtime, scope, 'allowed');
        expect(yield* rejectionCode(runEnablement(harness, scope, payloadFor(gopay, { environment: 'LIVE' })))).toBe(
          'gateway_binding_not_found',
        );
        const foreign = yield* harnessFor(runtime, otherLegalEntity, 'allowed');
        expect(yield* rejectionCode(runEnablement(foreign, otherLegalEntity, payloadFor(gopay)))).toBe(
          'gateway_binding_not_found',
        );
        yield* retireBinding(runtimeClient, scope, gopay);
        expect(yield* rejectionCode(runEnablement(harness, scope, payloadFor(gopay)))).toBe(
          'gateway_binding_not_current',
        );
      }),
    ),
  );

  it.live('#1155 A principal without the configure permission is denied and nothing is written', () =>
    Effect.scoped(
      Effect.gen(function* nonAdminDenied() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const gopay = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        yield* configureAuthorities(runtime, scope, gopay, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        const denied = yield* harnessFor(runtime, scope, 'denied');
        const refusal = yield* Effect.flip(runEnablement(denied, scope, payloadFor(gopay)));
        expect(Predicate.isTagged(refusal, 'ActionPermissionDenied')).toBe(true);
        expect(denied.snapshot().stages).not.toContain('handler_executed');
        expect(yield* countEnablements(runtimeClient, scope)).toBe(0);
      }),
    ),
  );
});

describe('#1155/#1156 live GatewayBindingPort over Current Gateway Enablement', () => {
  it.live('#1155 Disabled gateway is not offered to new intents', () =>
    Effect.scoped(
      Effect.gen(function* disabledNotOffered() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const gopay = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        yield* configureAuthorities(runtime, scope, gopay, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        const harness = yield* harnessFor(runtime, scope, 'allowed');
        const port = nativeGatewayPort(runtime, scope);
        const query = { customerConfigurationId: 'cc-gateway', scope };
        const verify = port.verifySelectedBinding({ ...query, binding: executionBindingOf(gopay) });

        expect(yield* port.listEnabledBindings(query)).toEqual([]);
        expect(isEnabled(yield* verify)).toBe(false);

        yield* runEnablement(harness, scope, payloadFor(gopay));
        expect(yield* port.listEnabledBindings(query)).toEqual([executionBindingOf(gopay)]);
        expect(isEnabled(yield* verify)).toBe(true);
        // Another Customer Configuration is not enabled by it.
        expect(yield* port.listEnabledBindings({ ...query, customerConfigurationId: 'cc-other' })).toEqual([]);

        yield* runEnablement(harness, scope, payloadFor(gopay, { enabled: false, expectedRevision: 1 }));
        expect(yield* port.listEnabledBindings(query)).toEqual([]);
        expect(isEnabled(yield* verify)).toBe(false);

        // An enabled binding retired for new intents is no longer offered either.
        yield* runEnablement(harness, scope, payloadFor(gopay, { expectedRevision: 2 }));
        yield* retireBinding(runtimeClient, scope, gopay);
        expect(yield* port.listEnabledBindings(query)).toEqual([]);
        expect(isEnabled(yield* verify)).toBe(false);
      }),
    ),
  );

  it.live('#1155 One provider outage does not gate unrelated providers', () =>
    Effect.scoped(
      Effect.gen(function* providerIsolation() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const gopay = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        const stripe = yield* insertBinding(runtimeClient, scope, 'STRIPE');
        for (const binding of [gopay, stripe]) {
          yield* configureAuthorities(runtime, scope, binding, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        }
        const harness = yield* harnessFor(runtime, scope, 'allowed');
        yield* runEnablement(harness, scope, payloadFor(gopay));
        yield* runEnablement(harness, scope, payloadFor(stripe));
        const port = nativeGatewayPort(runtime, scope);
        const query = { customerConfigurationId: 'cc-gateway', scope };

        // GoPay is switched off and its account retired; Stripe stays offered and verified.
        yield* runEnablement(harness, scope, payloadFor(gopay, { enabled: false, expectedRevision: 1 }));
        yield* retireBinding(runtimeClient, scope, gopay);
        expect(yield* port.listEnabledBindings(query)).toEqual([executionBindingOf(stripe)]);
        expect(isEnabled(yield* port.verifySelectedBinding({ ...query, binding: executionBindingOf(stripe) }))).toBe(
          true,
        );
        expect(isEnabled(yield* port.verifySelectedBinding({ ...query, binding: executionBindingOf(gopay) }))).toBe(
          false,
        );
      }),
    ),
  );

  it.live('#1156 Selected binding must equal an enabled binding exactly', () =>
    Effect.scoped(
      Effect.gen(function* exactBinding() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const sandbox = yield* insertBinding(runtimeClient, scope, 'GOPAY', 'SANDBOX');
        const live = yield* insertBinding(runtimeClient, scope, 'GOPAY', 'LIVE');
        yield* configureAuthorities(runtime, scope, sandbox, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        const harness = yield* harnessFor(runtime, scope, 'allowed');
        yield* runEnablement(harness, scope, payloadFor(sandbox));
        const port = nativeGatewayPort(runtime, scope);
        const verify = (binding: PaymentGatewayAccountBinding) =>
          port
            .verifySelectedBinding({ binding, customerConfigurationId: 'cc-gateway', scope })
            .pipe(Effect.map(isEnabled));
        const exact = executionBindingOf(sandbox);

        expect(yield* verify(exact)).toBe(true);
        // Same family, other environment: the LIVE binding of the same family is not enabled.
        expect(yield* verify(executionBindingOf(live))).toBe(false);
        expect(yield* verify({ ...exact, environment: 'LIVE' })).toBe(false);
        expect(yield* verify({ ...exact, providerAccountRef: live.providerAccountRef })).toBe(false);
        expect(yield* verify({ ...exact, providerFamily: 'STRIPE' })).toBe(false);
      }),
    ),
  );

  it.live('#1155 An existing Payment keeps its original binding after disablement and replacement', () =>
    Effect.scoped(
      Effect.gen(function* originalBindingKept() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const other = yield* makeTestScope;
        const original = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        const foreign = yield* insertBinding(runtimeClient, other, 'GOPAY');
        yield* configureAuthorities(runtime, scope, original, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        const harness = yield* harnessFor(runtime, scope, 'allowed');
        const port = nativeGatewayPort(runtime, scope);
        const resolve = (binding: PaymentGatewayAccountBinding) => port.resolveOriginalBinding({ binding, scope });
        const exact = executionBindingOf(original);

        yield* runEnablement(harness, scope, payloadFor(original));
        expect(yield* resolve(exact)).toEqual(Option.some(exact));
        // Disabled for new intents, then retired and replaced by another Current account: still the original.
        yield* runEnablement(harness, scope, payloadFor(original, { enabled: false, expectedRevision: 1 }));
        yield* retireBinding(runtimeClient, scope, original);
        const replacement = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        yield* configureAuthorities(runtime, scope, replacement, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        yield* runEnablement(harness, scope, payloadFor(replacement, { expectedRevision: 2 }));
        expect(yield* port.listEnabledBindings({ customerConfigurationId: 'cc-gateway', scope })).toEqual([
          executionBindingOf(replacement),
        ]);
        expect(
          isEnabled(
            yield* port.verifySelectedBinding({ binding: exact, customerConfigurationId: 'cc-gateway', scope }),
          ),
        ).toBe(false);
        expect(yield* resolve(exact)).toEqual(Option.some(exact));
        // Never another environment, family, scope or an unknown ref; nothing is substituted.
        expect(yield* resolve({ ...exact, environment: 'LIVE' })).toEqual(Option.none());
        expect(yield* resolve({ ...exact, providerFamily: 'STRIPE' })).toEqual(Option.none());
        expect(yield* resolve(executionBindingOf(foreign))).toEqual(Option.none());
        expect(yield* resolve({ ...exact, environment: 'production' })).toEqual(Option.none());
        expect(yield* resolve({ ...exact, providerAccountRef: 'gopay-account-primary' })).toEqual(Option.none());
      }),
    ),
  );

  it.live('#1155 A port call for another scope than its transaction is unavailable, never empty', () =>
    Effect.scoped(
      Effect.gen(function* scopeMismatch() {
        const { runtime } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const other = yield* makeTestScope;
        const failure = yield* inTransaction(runtime, scope, (transaction) =>
          gatewayBindingServiceForTransaction(transaction).listEnabledBindings({
            customerConfigurationId: 'cc-gateway',
            scope: other,
          }),
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: 'payment_owner_evidence_unavailable', port: 'GATEWAY_BINDING' });
      }),
    ),
  );
});

describe('#1155 gateway-configuration Read', () => {
  it.live('#1155 Returns bindings and enablements of the Legal Entity without any secret', () =>
    Effect.scoped(
      Effect.gen(function* configurationRead() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const otherLegalEntity = { ...scope, legalEntityId: yield* randomUuid };
        const gopay = yield* insertBinding(runtimeClient, scope, 'GOPAY');
        yield* insertBinding(runtimeClient, otherLegalEntity, 'STRIPE');
        yield* configureAuthorities(runtime, scope, gopay, ['GATEWAY_OUTCOME', 'REFUND_EXECUTION']);
        const harness = yield* harnessFor(runtime, scope, 'allowed');
        yield* runEnablement(harness, scope, payloadFor(gopay));

        const read = (selected: PaymentTestScope, customerConfigurationId?: string) =>
          inTransaction(runtime, selected, (transaction) =>
            readGatewayConfiguration(
              customerConfigurationId === undefined ? {} : { customerConfigurationId },
              pspEnablementPersistenceForTransaction(transaction),
            ),
          );
        const result = yield* read(scope);
        expect(result.bindings.map(({ bindingId, status }) => ({ bindingId, status }))).toEqual([
          { bindingId: gopay.bindingId, status: 'CURRENT' },
        ]);
        expect(result.enablements).toMatchObject([
          { bindingId: gopay.bindingId, customerConfigurationId: 'cc-gateway', enabled: true, revision: 1 },
        ]);
        expect(result.truncated).toBe(false);
        expect((yield* read(scope, 'cc-other')).enablements).toEqual([]);
        // RLS and the owner filter: the other Legal Entity's binding is not visible.
        expect((yield* read(otherLegalEntity)).bindings.map(({ providerFamily }) => providerFamily)).toEqual([
          'STRIPE',
        ]);

        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(GatewayConfigurationResponseSchema))(result);
        expect(encoded).not.toContain('never-shown-secret-ref');
        expect(encoded.toLowerCase()).not.toContain('secret');
      }),
    ),
  );
});
