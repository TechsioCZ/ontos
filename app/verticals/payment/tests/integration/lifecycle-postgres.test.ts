import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { defineDatabaseIdentityEnrollment, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Crypto, Deferred, Effect, Fiber, Layer, Option, Result, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import type { ActionRuntimeOptions } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  accessScopeFences,
  accessScopes,
  applicationCompositionDurableWork,
  coreRelations,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { paymentProductionOwnerPortsLive } from '../../api/payment-production-layers.ts';
import { PaymentMethodNotApplicable } from '../../shared/domain/lifecycle-method-not-applicable.ts';
import {
  PaymentCoverageEstablishedSchema,
  PaymentCoverageNotCollectedSchema,
  PaymentCoverageZeroPayableSchema,
} from '../../shared/domain/lifecycle-views.ts';
import type { PaymentPurchasingContext } from '../../shared/domain/applicability-purchasing-context.ts';
import { PaymentConflict } from '../../shared/domain/payment-conflict.ts';
import type { PaymentMethod, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import { createPaymentAction } from '../../src/actions/create-payment.action.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import { currentPaymentRead } from '../../src/api/current-payment.read.ts';
import { PaymentTermOwnerTransport } from '../../src/integrations/payment-term-evidence.ts';
import {
  operationOutcomeTransitions,
  paymentOperations,
  payments,
  refundItemClaims,
} from '../../src/database/schema.ts';
import type { PaymentAggregatePersistence } from '../../src/persistence/payment-aggregate-persistence.ts';
import { PaymentTermEvidencePort } from '../../src/ports/payment-term-evidence-port.ts';
import type { PaymentTermPurchase } from '../../src/ports/payment-term-evidence-port.ts';
import { PaymentPurchaseEvidencePort } from '../../src/ports/purchase-evidence-port.ts';
import { paymentApplicabilityPersistenceForTransaction } from '../../src/persistence/payment-applicability-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { immediateSnapshot } from '../support/applicability-owner-evidence.fixture.ts';
import {
  LIFECYCLE_GATEWAY_BINDING,
  lifecycleTermSnapshot,
  makeLifecycleOwnerContractFixture,
} from '../support/lifecycle-owner-contract.fixture.ts';
import type { LifecycleOwnerContractState } from '../support/lifecycle-owner-contract.fixture.ts';
import {
  makePaymentTermOwnerComposition,
  paymentTermFixtureDeployment,
} from '../support/payment-term-owner-composition.fixture.ts';
import { configuredRefundExecutionRouteFor } from '../support/refund-execution-route.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import {
  failureCodeOf,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  provenanceFor,
  purchasingContextFor,
  withPersistence,
} from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';

/**
 * #1148 PAYMENT_IDENTITY_MONEY_AND_LIFECYCLE (+ #1149 COLLECT start) through the real Payment Actions
 * and Read on the Core Action/Read runtimes over the worktree PostgreSQL. Only access decisions are
 * scripted open (the access matrix is #1153's subject). C15/CCC and C17 appear only as the named
 * public-contract fixtures of the owner ports. Each test uses fresh random Tenant/LE/principal rows;
 * nothing is deleted.
 */

const COMPOSITION_R1 = '1'.repeat(64);
const COMPOSITION_R2 = '2'.repeat(64);

type TrackedComposition = Effect.Success<ReturnType<typeof installPaymentTestCompositionAuthority>>;

/**
 * Every case runs under the shared test authority of R1 with Payment's registered subscriptions: a
 * gateway COLLECT is completion-bound executor work of the admitting revision (#1158).
 */
const runTracked = <A, E>(
  body: (composition: TrackedComposition) => Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>,
) =>
  Effect.scoped(installPaymentTestCompositionAuthority(COMPOSITION_R1).pipe(Effect.flatMap(body))).pipe(
    Effect.provide(NodeCrypto.layer),
  );
const runNative = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) => runTracked(() => effect);

const PAYMENT_CREATED = 'payment.core.payment-created.v1';
const OPERATION_REQUESTED = 'payment.core.operation-requested.v1';

/**
 * Native lifecycle harness: the real Core Action and Read runtimes over the worktree PostgreSQL, with
 * Payment's real registration, service factories, persistence and RLS. Only access decisions are
 * scripted open (permissions are not the subject here; #1153 owns the access matrix). Every scope
 * uses fresh random Tenant/LE/principal identities; nothing is deleted afterwards.
 */
const authenticationNamespaceId = 'test.payment-lifecycle.v1';

const allowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };

const contextAccess: ContextAccessService = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  ownerPermissions: (input) =>
    Effect.succeed(input.targets.map((target) => ({ decision: 'allowed' as const, key: target.target.key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

const lifecycleNativeDatabase = Effect.gen(function* lifecycleNativeDatabase() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  return { adminClient, coreAdmin, database, runtimeClient };
});
type LifecycleNativeDatabase = Effect.Success<typeof lifecycleNativeDatabase>;

/** The Core runtimes as they run under one approved Composition revision. */
const makeLifecycleRuntimes = Effect.fn('LifecycleNative.makeRuntimes')(function* makeLifecycleRuntimes(
  native: LifecycleNativeDatabase,
  compositionRevision: string,
  composition: Pick<ActionRuntimeOptions, 'applicationComposition' | 'expectedDeployment'> = {},
) {
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const actions = makeActionRuntime(
    { executor: native.database },
    makeActionRepository(crypto),
    allowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(compositionRevision),
      ...composition,
    },
  );
  const reads = makeReadRuntime(
    { executor: native.database },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    contextAccess,
    {
      accessDecision,
      databaseIdentities: defineDatabaseIdentityEnrollment([]),
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

/** Trusted session principal of a scope, as the gateway would present it. */
const principalOf = (scope: PaymentTestScope) => ({
  authBindingId: scope.principalId,
  authContextRef: `better-auth-session:${scope.principalId}`,
  authenticationNamespaceId,
  authMethod: 'session' as const,
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
});

/** Seeds the Core identity rows the Action runner re-checks (tenant, access fence, principal binding). */
const seedCoreScope = Effect.fn('LifecycleNative.seedCoreScope')(function* seedCoreScope(
  native: LifecycleNativeDatabase,
  scope: PaymentTestScope,
) {
  const accessScopeId = randomUUID();
  yield* native.coreAdmin.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Payment lifecycle native test',
    slug: `payment-lifecycle-${scope.tenantId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(legalEntities).values({
    legalEntityId: scope.legalEntityId,
    legalName: 'Payment lifecycle selling entity',
    registrationCountry: 'CZ',
    registrationNumber: `payment-lifecycle-${scope.legalEntityId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  // A company Action pins the tenant context fence and then its company fence, both Ready as Core
  // bootstrap seeds them.
  const companyScopeId = randomUUID();
  yield* native.coreAdmin.insert(accessScopes).values([
    { scopeId: accessScopeId, tenantContextId: scope.tenantId, tenantId: scope.tenantId },
    { legalEntityId: scope.legalEntityId, scopeId: companyScopeId, tenantId: scope.tenantId },
  ]);
  yield* native.coreAdmin.insert(accessScopeFences).values([
    { revision: 1, scopeId: accessScopeId, state: 'Ready', tenantId: scope.tenantId },
    { revision: 1, scopeId: companyScopeId, state: 'Ready', tenantId: scope.tenantId },
  ]);
  yield* native.coreAdmin.insert(principals).values({
    displayName: 'Payment lifecycle operator',
    kind: 'human',
    principalId: scope.principalId,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(principalAuthBindings).values({
    authenticationNamespaceId,
    principalAuthBindingId: scope.principalId,
    principalId: scope.principalId,
    provider: 'better_auth',
    providerSubjectId: `payment-lifecycle-${scope.principalId}`,
    status: 'active',
    subjectType: 'user',
    tenantId: scope.tenantId,
  });
});

/**
 * Merchant method enablement precondition (#1147, lane L1's owner table), written through its own
 * persistence in one scoped transaction. The lifecycle lane only reads it at create time.
 */
const enableMethod = Effect.fn('LifecycleNative.enableMethod')(function* enableMethod(
  native: LifecycleNativeDatabase,
  scope: PaymentTestScope,
  customerConfigurationId: string,
  method: PaymentMethod,
) {
  yield* native.database.transaction((transaction) =>
    Effect.gen(function* configureEnablement() {
      const scoped = yield* installOperationalScope(
        transaction,
        operationalScopeOf(scope),
        defineDatabaseIdentityEnrollment([]),
      );
      yield* paymentApplicabilityPersistenceForTransaction(scoped).configureEnablement({
        customerConfigurationId,
        enabled: true,
        expectedRevision: Option.none(),
        method,
        provenance: {
          actionInvocationId: randomUUID(),
          actorPrincipalId: scope.principalId,
          compositionRevision: COMPOSITION_R1,
        },
        reason: 'Lifecycle test precondition: the merchant offers this method',
      });
    }),
  );
});

/** Outbox rows Payment committed for one tenant and topic, oldest first. */
const outboxPayloads = (native: LifecycleNativeDatabase, tenantId: string, topic: string) =>
  native.coreAdmin
    .select({ payloadJson: outboxMessages.payloadJson })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.tenantId, tenantId),
        eq(outboxMessages.producerModuleKey, 'payment.core'),
        eq(outboxMessages.topic, topic),
      ),
    )
    .orderBy(outboxMessages.createdAt)
    .pipe(Effect.map((rows) => rows.map((row) => row.payloadJson)));

const CUSTOMER_CONFIGURATION = 'customer-configuration-lifecycle';

type Runtimes = Effect.Success<ReturnType<typeof makeLifecycleRuntimes>>;

interface IntentOverrides {
  readonly intentKey?: string;
  readonly payableAmount?: { readonly amountMinor: number; readonly currency: string };
  readonly predecessorPaymentId?: string;
  readonly purchaseCorrelationId?: string;
  readonly purchasingContext?: PaymentPurchasingContext;
  readonly selection?: { readonly method: string; readonly selectedBinding?: typeof LIFECYCLE_GATEWAY_BINDING };
}

/**
 * One fresh Tenant + Selling Legal Entity with the real Core runtimes under Composition R1, the
 * ONLINE_GATEWAY method enabled, and public-contract owner fixtures for C15/CCC and C17.
 */
const lifecycleScenario = Effect.fn('LifecycleScenario.make')(function* lifecycleScenario(
  owner: Partial<LifecycleOwnerContractState> = {},
  existingScope?: PaymentTestScope,
  existingNative?: LifecycleNativeDatabase,
) {
  const native = existingNative ?? (yield* lifecycleNativeDatabase);
  const scope = existingScope ?? (yield* makeTestScope);
  if (existingScope === undefined) {
    yield* seedCoreScope(native, scope);
    yield* enableMethod(native, scope, CUSTOMER_CONFIGURATION, 'ONLINE_GATEWAY');
  }
  const owners = yield* makeLifecycleOwnerContractFixture({
    enabledBindings: [LIFECYCLE_GATEWAY_BINDING],
    gatewayAvailable: true,
    metadataRevision: 1,
    termUse: 'USABLE',
    ...owner,
  });
  const r1 = yield* makeLifecycleRuntimes(native, COMPOSITION_R1);
  const principal = principalOf(scope);
  const paymentTermRef = {
    moduleId: 'payment.term-catalog' as const,
    resourceId: randomUUID(),
    resourceType: 'payment.term-catalog.payment-term' as const,
    tenantId: scope.tenantId,
  };
  const intent = (overrides: IntentOverrides = {}) => {
    const purchaseCorrelationId = overrides.purchaseCorrelationId ?? `purchase-${randomUUID()}`;
    const base = {
      customerConfigurationId: CUSTOMER_CONFIGURATION,
      intentKey: overrides.intentKey ?? `intent-${randomUUID()}`,
      payableAmount: overrides.payableAmount ?? { amountMinor: 100_000, currency: 'CZK' },
      paymentTermRef,
      purchaseCorrelationId,
      purchasingContext: overrides.purchasingContext ?? purchasingContextFor(scope, purchaseCorrelationId),
      selection: overrides.selection ?? { method: 'ONLINE_GATEWAY', selectedBinding: LIFECYCLE_GATEWAY_BINDING },
    };
    const { predecessorPaymentId } = overrides;
    return predecessorPaymentId === undefined ? base : { ...base, predecessorPaymentId };
  };
  const create = (payload: ReturnType<typeof intent>, idempotencyKey = randomUUID(), runtimes: Runtimes = r1) =>
    runtimes.actions
      .runAction({
        payload,
        principal,
        registration: createPaymentAction,
        transport: { correlationId: 'payment-lifecycle-create', idempotencyKey },
      })
      .pipe(Effect.provide(owners.layer));
  const collect = (
    payload: {
      readonly amount: { readonly amountMinor: number; readonly currency: string };
      readonly method: string;
      readonly operationKey: string;
      readonly paymentId: string;
    },
    idempotencyKey = randomUUID(),
    runtimes: Runtimes = r1,
  ) =>
    runtimes.actions
      .runAction({
        payload,
        principal,
        registration: startPaymentCollectionAction,
        transport: { correlationId: 'payment-lifecycle-collect', idempotencyKey },
      })
      .pipe(Effect.provide(owners.layer));
  const read = (paymentId: string, runtimes: Runtimes = r1) =>
    runtimes.reads
      .runRead({
        input: { paymentId },
        principal,
        registration: currentPaymentRead,
        transport: { correlationId: 'payment-lifecycle-read' },
      })
      .pipe(Effect.provide(owners.layer));
  /** Owner-local evidence effects (L6/L4 own their Actions); recorded through the aggregate primitives. */
  const persist = <Value, Failure>(
    operation: (persistence: PaymentAggregatePersistence) => Effect.Effect<Value, Failure>,
  ) => withPersistence(native.database, scope, operation);
  const settle = (
    paymentId: string,
    operationId: string,
    expectedOutcomeRevision: number,
    to: PaymentOperationOutcome,
    compositionRevision?: string,
  ) =>
    Effect.gen(function* settleOutcome() {
      // Evidence is recorded by this scenario's R1 runtime unless a later compatible revision is named.
      const provenance = {
        ...(yield* provenanceFor(scope)),
        compositionRevision: compositionRevision ?? COMPOSITION_R1,
      };
      return yield* persist((persistence) =>
        persistence.transitionOperationOutcome({
          causedBy: { kind: 'OBSERVATION' },
          expectedOutcomeRevision,
          operationId,
          paymentId,
          provenance,
          to,
        }),
      );
    });
  return { collect, create, intent, native, owners, paymentTermRef, persist, principal, r1, read, scope, settle };
});
type Scenario = Effect.Success<ReturnType<typeof lifecycleScenario>>;

it.live(
  '#1148 Authoritative payable already includes the proper GROSS shipping treatment: 332.00 CZK stays 33200',
  () =>
    runNative(
      Effect.gen(function* exactPayable() {
        const scenario = yield* lifecycleScenario();
        const created = yield* scenario.create(
          scenario.intent({ payableAmount: { amountMinor: 33_200, currency: 'CZK' } }),
        );

        expect(created.replayed).toBe(false);
        expect(created.payment.amount).toStrictEqual({ amountMinor: 33_200, currency: 'CZK' });
        const current = yield* scenario.read(created.payment.paymentId);
        expect(current.payment.amount).toStrictEqual({ amountMinor: 33_200, currency: 'CZK' });
        expect(current.operations).toHaveLength(0);
        const [event] = yield* outboxPayloads(
          scenario.native,
          scenario.scope.tenantId,
          'payment.core.payment-created.v1',
        );
        expect(event).toMatchObject({ payableAmount: { amountMinor: 33_200, currency: 'CZK' } });
      }),
    ),
);

it.live('#1148 Same amount belongs to two purchases: two 1000 CZK purchases get distinct Payment identities', () =>
  runNative(
    Effect.gen(function* sameAmountTwoPurchases() {
      const scenario = yield* lifecycleScenario();
      const amount = { amountMinor: 100_000, currency: 'CZK' };
      const first = yield* scenario.create(scenario.intent({ payableAmount: amount }));
      const second = yield* scenario.create(scenario.intent({ payableAmount: amount }));

      expect(first.payment.paymentId).not.toBe(second.payment.paymentId);
      expect(first.payment.purchaseCorrelationId).not.toBe(second.payment.purchaseCorrelationId);
      expect(Option.isNone(first.payment.predecessorPaymentId)).toBe(true);
      const events = yield* outboxPayloads(scenario.native, scenario.scope.tenantId, 'payment.core.payment-created.v1');
      expect(events).toHaveLength(2);
      expect(yield* failureCodeOf(scenario.read(randomUUID()))).toBe('read_handler_not_found');
    }),
  ),
);

const paymentRows = (scenario: Scenario) =>
  scenario.native.coreAdmin
    .select({ amountMinor: payments.amountMinor, paymentId: payments.paymentId })
    .from(payments)
    .where(
      and(eq(payments.tenantId, scenario.scope.tenantId), eq(payments.legalEntityId, scenario.scope.legalEntityId)),
    );

it.live('#1148 the same intent key recovers the same Payment; a changed meaning under it is a conflict', () =>
  runNative(
    Effect.gen(function* intentReplay() {
      const scenario = yield* lifecycleScenario();
      const payload = scenario.intent();
      const coreKey = randomUUID();
      const created = yield* scenario.create(payload, coreKey);

      expect(yield* failureCodeOf(scenario.create(payload, coreKey))).toBe('action_already_committed');
      const recovered = yield* scenario.create(payload);
      expect(recovered.replayed).toBe(true);
      expect(recovered.payment.paymentId).toBe(created.payment.paymentId);
      expect(recovered.payment.provenance).toStrictEqual(created.payment.provenance);
      expect(
        yield* failureCodeOf(scenario.create({ ...payload, payableAmount: { amountMinor: 120_000, currency: 'CZK' } })),
      ).toBe('payment_intent_material_conflict');
      expect(
        yield* failureCodeOf(
          scenario.create({
            ...payload,
            selection: {
              method: 'ONLINE_GATEWAY',
              selectedBinding: { ...LIFECYCLE_GATEWAY_BINDING, environment: 'sandbox' },
            },
          }),
        ),
      ).toBe('payment_intent_material_conflict');
      expect(yield* paymentRows(scenario)).toHaveLength(1);
      expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, PAYMENT_CREATED)).toHaveLength(1);
    }),
  ),
);

it.live('#1148 creates bank transfer with exact Checkout facts and refuses a forged correlation or amount', () =>
  runTracked((tracked) =>
    Effect.gen(function* governedPurchaseCreation() {
      const scenario = yield* lifecycleScenario();
      yield* enableMethod(scenario.native, scenario.scope, CUSTOMER_CONFIGURATION, 'BANK_TRANSFER_ADVANCE');
      const composition = yield* makePaymentTermOwnerComposition();
      const { revision } = composition.composition;
      yield* tracked.activate(revision);
      const { actions } = yield* makeLifecycleRuntimes(scenario.native, revision, {
        applicationComposition: { load: Effect.succeed(composition) },
        expectedDeployment: paymentTermFixtureDeployment,
      });
      const storefrontId = 'storefront-intent-owner';
      const principal = trustVerifiedGatewayPrincipalContext(
        { ...scenario.principal, trustedStorefrontId: storefrontId },
        revision,
      );
      const purchasingContext: PaymentPurchasingContext = {
        ...purchasingContextFor(scenario.scope, 'exact-purchase'),
        subject: { guestEvidenceRef: 'checkout-guest-fact', guestSessionRef: 'checkout-guest-session', kind: 'GUEST' },
      };
      const payableAmount = { amountMinor: 100_000, currency: 'CZK' } as const;
      const payload = scenario.intent({
        payableAmount,
        purchasingContext,
        selection: { method: 'BANK_TRANSFER_ADVANCE' },
      });
      let resolvedTerms = 0;
      const transport = Layer.succeed(PaymentTermOwnerTransport, {
        acquire: () =>
          Effect.succeed({
            apiBaseUrl: 'https://gateway.test/commerce-customer-context/',
            authorization: 'Bearer fixture-ccc',
            compositionRevision: revision,
            expiresAt: 1_800_000_000,
          }),
        executeGuest: (request) => {
          resolvedTerms += 1;
          return Effect.succeed({
            _tag: 'EXPLICIT_CHOICE',
            customerPaymentTermsRevision: null,
            definition: immediateSnapshot(payload.paymentTermRef),
            policyRevision: 'policy-1',
            policySource: 'storefront',
            purchasingContextRevision: request.purchasingContext.contextRevision,
            resolvedAt: request.at,
          });
        },
        executeProfile: () => Effect.die('A Guest purchase cannot use the profile term route'),
      });
      const checkout = Layer.succeed(PaymentPurchaseEvidencePort, {
        readCurrent: () =>
          Effect.succeed({
            ...scenario.scope,
            customerConfigurationId: payload.customerConfigurationId,
            evidenceRef: 'fixture-checkout-purchase',
            payableAmount,
            paymentTermRef: payload.paymentTermRef,
            purchaseCorrelationId: payload.purchaseCorrelationId,
            purchasingContext,
            storefrontId,
          }),
      });
      const create = (input: typeof payload) =>
        actions.runAction({
          payload: input,
          principal,
          registration: createPaymentAction,
          transport: { correlationId: 'payment-governed-create', idempotencyKey: randomUUID() },
        });
      const owners = paymentProductionOwnerPortsLive.pipe(Layer.provide(Layer.mergeAll(checkout, transport)));
      const missing = yield* create(payload).pipe(Effect.provide(paymentProductionOwnerPortsLive), Effect.flip);
      expect(missing).toMatchObject({ outcome: 'UNAVAILABLE_TO_VERIFY' });
      const foreignCorrelation = { ...payload, purchaseCorrelationId: 'forged-purchase' };
      const wrongAmount = { ...payload, payableAmount: { ...payload.payableAmount, amountMinor: 1 } };
      for (const forged of [foreignCorrelation, wrongAmount]) {
        const failure = yield* create(forged).pipe(Effect.provide(owners), Effect.flip);
        expect(failure).toMatchObject({ outcome: 'UNAVAILABLE_TO_VERIFY' });
      }
      expect(resolvedTerms).toBe(0);
      expect(yield* paymentRows(scenario)).toHaveLength(0);
      const created = yield* create(payload).pipe(Effect.provide(owners));
      expect(created.payment.amount).toEqual(payload.payableAmount);
      expect(created.payment.purchaseCorrelationId).toBe(payload.purchaseCorrelationId);
      expect(resolvedTerms).toBe(1);
      expect(yield* paymentRows(scenario)).toHaveLength(1);
      expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, PAYMENT_CREATED)).toHaveLength(1);
    }),
  ),
);

it.live(
  '#1147 #1149 create-payment scopes the term question to the exact trusted purchasing context and keeps it immutably',
  () =>
    runNative(
      Effect.gen(function* purchaseScopedIntent() {
        const scenario = yield* lifecycleScenario();
        const asked: PaymentTermPurchase[] = [];
        const recordingTerms = Layer.succeed(PaymentTermEvidencePort, {
          verifyTermUse: ({ paymentTermRef, purchase }) =>
            Effect.sync(() => {
              asked.push(purchase);
              return {
                _tag: 'USABLE' as const,
                entitlementEvidenceRef: `ccc-entitlement-${paymentTermRef.resourceId}`,
                paymentTermRef,
                semanticSnapshot: lifecycleTermSnapshot(paymentTermRef, 1),
              };
            }),
        });
        const create = (payload: ReturnType<typeof scenario.intent>) =>
          scenario.r1.actions
            .runAction({
              payload,
              principal: scenario.principal,
              registration: createPaymentAction,
              transport: { correlationId: 'payment-lifecycle-purchase-scope', idempotencyKey: randomUUID() },
            })
            .pipe(Effect.provide(recordingTerms), Effect.provide(scenario.owners.layer));
        const purchaseCorrelationId = `purchase-${randomUUID()}`;
        const buyer = purchasingContextFor(scenario.scope, 'buyer-anna');
        const payload = scenario.intent({ purchaseCorrelationId, purchasingContext: buyer });
        const created = yield* create(payload);

        // The owner was asked about this buyer, Channel and Market, never about the merchant configuration.
        expect(asked).toStrictEqual([{ _tag: 'PURCHASING_CONTEXT', purchasingContext: buyer }]);
        const [stored] = yield* scenario.native.coreAdmin
          .select({ purchasingContext: payments.purchasingContext })
          .from(payments)
          .where(eq(payments.paymentId, created.payment.paymentId));
        expect(stored?.purchasingContext).toStrictEqual(buyer);

        // The same intent for another buyer is a different meaning, never a silent replay.
        const otherBuyer = purchasingContextFor(scenario.scope, 'buyer-bohdan');
        expect(yield* failureCodeOf(create({ ...payload, purchasingContext: otherBuyer }))).toBe(
          'payment_intent_material_conflict',
        );
        // A buyer profile of another Tenant never carries this Tenant's entitlement; the owner is not asked.
        const foreign = purchasingContextFor({ ...scenario.scope, tenantId: randomUUID() }, 'buyer-foreign');
        const refused = yield* Effect.flip(create(scenario.intent({ purchasingContext: foreign })));
        expect(refused).toMatchObject({ outcome: 'CONFLICTING_CONFIGURATION' });
        expect(asked).toHaveLength(1);
        expect(yield* paymentRows(scenario)).toHaveLength(1);
      }),
    ),
);

it.live('#1148 money is exact CZK integer minor units: fractions, negatives and other currencies are refused', () =>
  runNative(
    Effect.gen(function* exactMoney() {
      const scenario = yield* lifecycleScenario();
      const invalid = [
        { amountMinor: 332.5, currency: 'CZK' },
        { amountMinor: -1, currency: 'CZK' },
        { amountMinor: 33_200, currency: 'EUR' },
      ];
      for (const payableAmount of invalid) {
        expect(yield* failureCodeOf(scenario.create(scenario.intent({ payableAmount })))).toBe(
          'action_payload_invalid',
        );
      }
      expect(yield* paymentRows(scenario)).toHaveLength(0);
    }),
  ),
);

it.live('#1147/#1148 create-payment refuses every non-AVAILABLE applicability outcome with its typed outcome', () =>
  runNative(
    Effect.gen(function* applicabilityRefusals() {
      const enabled = yield* lifecycleScenario();
      // MISSING_REQUIRED_INPUT: a gateway branch without an explicit selected binding.
      const missing = yield* Effect.flip(enabled.create(enabled.intent({ selection: { method: 'ONLINE_GATEWAY' } })));
      expect(missing).toBeInstanceOf(PaymentMethodNotApplicable);
      expect(missing).toMatchObject({
        code: 'payment_method_input_required',
        outcome: 'MISSING_REQUIRED_INPUT',
      });
      // NOT_ENABLED: the merchant has not enabled BANK_TRANSFER_ADVANCE for this configuration.
      const notEnabled = yield* Effect.flip(
        enabled.create(enabled.intent({ selection: { method: 'BANK_TRANSFER_ADVANCE' } })),
      );
      expect(notEnabled).toMatchObject({ code: 'payment_method_not_enabled', outcome: 'NOT_ENABLED' });
      // NOT_ENABLED: C17 does not enable this explicit account; no other account is chosen.
      const foreignAccount = yield* Effect.flip(
        enabled.create(
          enabled.intent({
            selection: {
              method: 'ONLINE_GATEWAY',
              selectedBinding: { ...LIFECYCLE_GATEWAY_BINDING, providerAccountRef: 'gopay-account-foreign' },
            },
          }),
        ),
      );
      expect(foreignAccount).toMatchObject({ code: 'payment_method_not_enabled', outcome: 'NOT_ENABLED' });
      // INCOMPATIBLE_TERM: DEFERRED_INVOICE with an IMMEDIATE term.
      yield* enableMethod(enabled.native, enabled.scope, CUSTOMER_CONFIGURATION, 'DEFERRED_INVOICE');
      const incompatible = yield* Effect.flip(
        enabled.create(enabled.intent({ selection: { method: 'DEFERRED_INVOICE' } })),
      );
      expect(incompatible).toMatchObject({ code: 'payment_method_term_incompatible', outcome: 'INCOMPATIBLE_TERM' });
      // UNAVAILABLE_TO_VERIFY: required term evidence is down; never treated as absence.
      yield* enabled.owners.update((state) => ({ ...state, termUse: 'UNAVAILABLE' }));
      const unverifiable = yield* Effect.flip(enabled.create(enabled.intent()));
      expect(unverifiable).toMatchObject({
        code: 'payment_method_evidence_unavailable',
        outcome: 'UNAVAILABLE_TO_VERIFY',
      });
      expect(yield* paymentRows(enabled)).toHaveLength(0);
      expect(yield* outboxPayloads(enabled.native, enabled.scope.tenantId, PAYMENT_CREATED)).toHaveLength(0);
    }),
  ),
);

it.live(
  '#1148 Changing amount: the 1000 CZK Payment is never mutated and the 1200 CZK successor waits for its effects',
  () =>
    runNative(
      Effect.gen(function* changingAmount() {
        const scenario = yield* lifecycleScenario();
        const purchaseCorrelationId = `purchase-${randomUUID()}`;
        const original = yield* scenario.create(
          scenario.intent({ payableAmount: { amountMinor: 100_000, currency: 'CZK' }, purchaseCorrelationId }),
        );
        const predecessorPaymentId = original.payment.paymentId;
        const collection = yield* scenario.collect({
          amount: { amountMinor: 100_000, currency: 'CZK' },
          method: 'ONLINE_GATEWAY',
          operationKey: 'collect-1000',
          paymentId: predecessorPaymentId,
        });
        const successorIntent = scenario.intent({
          payableAmount: { amountMinor: 120_000, currency: 'CZK' },
          predecessorPaymentId,
          purchaseCorrelationId,
        });

        // Live (and then INDETERMINATE) predecessor collection blocks the successor.
        expect(yield* failureCodeOf(scenario.create(successorIntent))).toBe('payment_predecessor_unresolved_conflict');
        yield* scenario.settle(predecessorPaymentId, collection.operation.operationId, 1, 'INDETERMINATE');
        expect(yield* failureCodeOf(scenario.create(successorIntent))).toBe('payment_predecessor_unresolved_conflict');
        // Definitive non-execution releases the predecessor.
        yield* scenario.settle(predecessorPaymentId, collection.operation.operationId, 2, 'NOT_EFFECTED_CONFIRMED');
        const successor = yield* scenario.create(successorIntent);

        expect(successor.payment.amount).toStrictEqual({ amountMinor: 120_000, currency: 'CZK' });
        expect(successor.payment.predecessorPaymentId).toStrictEqual(Option.some(predecessorPaymentId));
        const predecessor = yield* scenario.read(predecessorPaymentId);
        expect(predecessor.payment.amount).toStrictEqual({ amountMinor: 100_000, currency: 'CZK' });
        expect(predecessor.payment.provenance).toStrictEqual(original.payment.provenance);
        expect(predecessor.successorPaymentId).toStrictEqual(Option.some(successor.payment.paymentId));
        // The superseded intent cannot start another collection; a second successor would compete.
        expect(
          yield* failureCodeOf(
            scenario.collect({
              amount: { amountMinor: 100_000, currency: 'CZK' },
              method: 'ONLINE_GATEWAY',
              operationKey: 'collect-1000-again',
              paymentId: predecessorPaymentId,
            }),
          ),
        ).toBe('payment_superseded_conflict');
        expect(
          yield* failureCodeOf(
            scenario.create(
              scenario.intent({
                payableAmount: { amountMinor: 130_000, currency: 'CZK' },
                predecessorPaymentId,
                purchaseCorrelationId,
              }),
            ),
          ),
        ).toBe('payment_predecessor_superseded_conflict');
        const [event] = (yield* outboxPayloads(scenario.native, scenario.scope.tenantId, PAYMENT_CREATED)).slice(-1);
        expect(event).toMatchObject({ paymentId: successor.payment.paymentId, predecessorPaymentId });
      }),
    ),
);

it.live('#1148 a proven unreturned predecessor collection blocks a successor; a fully refunded one does not', () =>
  runNative(
    Effect.gen(function* provenPredecessor() {
      const scenario = yield* lifecycleScenario();
      const original = yield* scenario.create(scenario.intent());
      const predecessorPaymentId = original.payment.paymentId;
      const collection = yield* scenario.collect({
        amount: { amountMinor: 100_000, currency: 'CZK' },
        method: 'ONLINE_GATEWAY',
        operationKey: 'collect-proven',
        paymentId: predecessorPaymentId,
      });
      yield* scenario.settle(predecessorPaymentId, collection.operation.operationId, 1, 'EFFECT_CONFIRMED');
      const successorIntent = scenario.intent({
        predecessorPaymentId,
        purchaseCorrelationId: original.payment.purchaseCorrelationId,
      });
      expect(yield* failureCodeOf(scenario.create(successorIntent))).toBe('payment_predecessor_unresolved_conflict');

      const [provenance, refundExecutionRoute] = yield* Effect.all(
        [
          provenanceFor(scenario.scope),
          configuredRefundExecutionRouteFor(scenario.native.database, scenario.scope, LIFECYCLE_GATEWAY_BINDING),
        ],
        { concurrency: 1 },
      );
      const compensation = yield* scenario.persist((persistence) =>
        persistence.insertOperation({
          amount: { amountMinor: 100_000, currency: 'CZK' },
          binding: LIFECYCLE_GATEWAY_BINDING,
          initialOutcome: 'PENDING',
          kind: 'REFUND',
          materialRequest: { kind: 'REFUND', operationKey: 'compensate-all' },
          operationKey: 'compensate-all',
          paymentId: predecessorPaymentId,
          provenance,
          refundBasis: {
            _tag: 'FAILED_COMMITMENT_COMPENSATION',
            attemptRef: 'attempt-1',
            closedAgainstLateCommit: true,
            terminalNonCommitEvidenceRef: 'commitment-non-commit-1',
          },
          refundExecutionRoute,
          targetOperationId: collection.operation.operationId,
        }),
      );
      // A pending return is still an unresolved effect.
      expect(yield* failureCodeOf(scenario.create(successorIntent))).toBe('payment_predecessor_unresolved_conflict');
      yield* scenario.settle(predecessorPaymentId, compensation.record.operationId, 1, 'EFFECT_CONFIRMED');
      const successor = yield* scenario.create(successorIntent);
      expect(successor.payment.predecessorPaymentId).toStrictEqual(Option.some(predecessorPaymentId));
    }),
  ),
);

/**
 * Polls until at least two sessions are (transitively) blocked behind the holder backend; the second
 * racer may queue behind the first rather than the holder itself.
 */
const awaitBlockedBehind = (adminClient: LifecycleNativeDatabase['adminClient'], holderPid: number) => {
  const waiters = adminClient
    .unsafe<{ readonly waiting: number }>(
      `with recursive blocked(pid) as (
         select activity.pid from pg_catalog.pg_stat_activity activity
         where $1 = any(pg_catalog.pg_blocking_pids(activity.pid))
         union
         select activity.pid from pg_catalog.pg_stat_activity activity
         join blocked on blocked.pid = any(pg_catalog.pg_blocking_pids(activity.pid))
       )
       select count(*)::integer as waiting from blocked`,
      [holderPid],
    )
    .pipe(Effect.map((rows) => rows[0]?.waiting ?? 0));
  const awaitBothBlocked = (remaining: number): Effect.Effect<number, Effect.Error<typeof waiters>> =>
    waiters.pipe(
      Effect.flatMap((waiting) =>
        waiting >= 2 || remaining === 0
          ? Effect.succeed(waiting)
          : Effect.suspend(() => awaitBothBlocked(remaining - 1)),
      ),
    );
  return awaitBothBlocked(2000);
};

/**
 * Races two Actions behind an external holder of the given Payment row locks: both queue behind it
 * (observed in pg_stat_activity), then the holder releases and both outcomes are returned. The holder is
 * always released, so a failed observation can never leave locks behind.
 */
const raceBehindPaymentLocks = Effect.fn('LifecycleConcurrencyTest.raceBehindPaymentLocks')(function* race<A, E>(
  scenario: Scenario,
  paymentIds: readonly string[],
  racers: readonly [Effect.Effect<A, E>, Effect.Effect<A, E>],
) {
  const { adminClient } = scenario.native;
  const locked = yield* Deferred.make<number>();
  const release = yield* Deferred.make<boolean>();
  const holder = yield* adminClient
    .withTransaction(
      Effect.gen(function* holdPaymentRows() {
        const [backend] = yield* adminClient.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
        yield* adminClient.unsafe(
          'select payment_id from payment.payments where payment_id = any($1::uuid[]) order by payment_id for update',
          [paymentIds],
        );
        yield* Deferred.succeed(locked, backend?.pid ?? 0);
        yield* Deferred.await(release);
      }),
    )
    .pipe(Effect.forkChild);
  const holderPid = yield* Deferred.await(locked);
  const first = yield* Effect.result(racers[0]).pipe(Effect.forkChild);
  const second = yield* Effect.result(racers[1]).pipe(Effect.forkChild);
  const blockedCount = yield* awaitBlockedBehind(adminClient, holderPid).pipe(
    Effect.ensuring(Deferred.succeed(release, true)),
  );
  yield* Fiber.join(holder);
  return { blockedCount, outcomes: [yield* Fiber.join(first), yield* Fiber.join(second)] };
});

/** The holder's uncommitted intent-key row is rolled back with this marker once both racers queue. */
class HolderRolledBack extends Schema.TaggedError<HolderRolledBack>()('HolderRolledBack', {}) {}

/**
 * Races two create-payment Actions for one brand-new intent key. Nothing exists yet, so no Payment row
 * lock serializes them: an external transaction holds an uncommitted Payment under the same intent key,
 * which both Actions pass (invisible to their absence checks) and then queue behind on the intent-key
 * unique index. The holder then rolls back, so the two Actions themselves decide the insert.
 */
const raceOnNewIntentKey = Effect.fn('LifecycleConcurrencyTest.raceOnNewIntentKey')(function* race<A, E>(
  scenario: Scenario,
  intentKey: string,
  racers: readonly [Effect.Effect<A, E>, Effect.Effect<A, E>],
) {
  const locked = yield* Deferred.make<number>();
  const release = yield* Deferred.make<boolean>();
  const holder = yield* scenario
    .persist((persistence) =>
      Effect.gen(function* holdIntentKey() {
        const input = yield* newPaymentInput(scenario.scope);
        yield* persistence.insertPayment({ ...input, intentKey });
        const [backend] = yield* scenario.native.runtimeClient.unsafe<{ readonly pid: number }>(
          'select pg_backend_pid() as pid',
        );
        yield* Deferred.succeed(locked, backend?.pid ?? 0);
        yield* Deferred.await(release);
        return yield* new HolderRolledBack();
      }),
    )
    .pipe(Effect.flip, Effect.forkChild);
  const holderPid = yield* Deferred.await(locked);
  const first = yield* Effect.result(racers[0]).pipe(Effect.forkChild);
  const second = yield* Effect.result(racers[1]).pipe(Effect.forkChild);
  const blockedCount = yield* awaitBlockedBehind(scenario.native.adminClient, holderPid).pipe(
    Effect.ensuring(Deferred.succeed(release, true)),
  );
  const holderFailure = yield* Fiber.join(holder);
  return { blockedCount, holderFailure, outcomes: [yield* Fiber.join(first), yield* Fiber.join(second)] };
});

/** Payments carrying one intent key in this scope. */
const intentKeyRows = (scenario: Scenario, intentKey: string) =>
  scenario.native.coreAdmin
    .select({ paymentId: payments.paymentId })
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, scenario.scope.tenantId),
        eq(payments.legalEntityId, scenario.scope.legalEntityId),
        eq(payments.intentKey, intentKey),
      ),
    );

it.live(
  '#1148 two concurrent create-payment invocations of one new identical intent race on PostgreSQL: one creates, one replays it',
  () =>
    runNative(
      Effect.gen(function* concurrentIdenticalIntents() {
        const scenario = yield* lifecycleScenario();
        const payload = scenario.intent();
        const { blockedCount, holderFailure, outcomes } = yield* raceOnNewIntentKey(scenario, payload.intentKey, [
          scenario.create(payload),
          scenario.create(payload),
        ]);
        expect(blockedCount).toBeGreaterThanOrEqual(2);
        expect(holderFailure).toStrictEqual(new HolderRolledBack());

        const results = outcomes.flatMap((outcome) => (Result.isSuccess(outcome) ? [outcome.success] : []));
        expect(results).toHaveLength(2);
        const created = results.find((result) => !result.replayed);
        const replayed = results.find((result) => result.replayed);
        expect(created).toBeDefined();
        expect(replayed?.payment).toStrictEqual(created?.payment);
        expect(yield* intentKeyRows(scenario, payload.intentKey)).toStrictEqual([
          { paymentId: created?.payment.paymentId },
        ]);
        expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, PAYMENT_CREATED)).toHaveLength(1);
      }),
    ),
);

it.live(
  '#1148 two concurrent create-payment invocations of one new intent key with different meaning: one creates, one conflicts',
  () =>
    runNative(
      Effect.gen(function* concurrentDivergentIntents() {
        const scenario = yield* lifecycleScenario();
        const payload = scenario.intent();
        const changed = { ...payload, payableAmount: { amountMinor: 120_000, currency: 'CZK' } };
        const { blockedCount, outcomes } = yield* raceOnNewIntentKey(scenario, payload.intentKey, [
          scenario.create(payload),
          scenario.create(changed),
        ]);
        expect(blockedCount).toBeGreaterThanOrEqual(2);

        const [created] = outcomes.flatMap((outcome) => (Result.isSuccess(outcome) ? [outcome.success] : []));
        const losers = outcomes.flatMap((outcome) => (Result.isFailure(outcome) ? [outcome.failure] : []));
        expect(created?.replayed).toBe(false);
        expect(losers).toHaveLength(1);
        expect(losers[0]).toMatchObject({ code: 'payment_intent_material_conflict' });
        expect(yield* intentKeyRows(scenario, payload.intentKey)).toStrictEqual([
          { paymentId: created?.payment.paymentId },
        ]);
        expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, PAYMENT_CREATED)).toHaveLength(1);
      }),
    ),
);

/** The exact collection request of a 1000 CZK ONLINE_GATEWAY Payment under one operation key. */
const exactCollectRequest = (paymentId: string, operationKey: string) => ({
  amount: { amountMinor: 100_000, currency: 'CZK' },
  method: 'ONLINE_GATEWAY',
  operationKey,
  paymentId,
});

/** COLLECT operations of every Payment that carries one purchase correlation, in this scope. */
const purchaseCollects = (scenario: Scenario, purchaseCorrelationId: string) =>
  scenario.native.coreAdmin
    .select({ outcome: paymentOperations.outcome, paymentId: paymentOperations.paymentId })
    .from(paymentOperations)
    .innerJoin(
      payments,
      and(eq(payments.paymentId, paymentOperations.paymentId), eq(payments.tenantId, paymentOperations.tenantId)),
    )
    .where(
      and(
        eq(payments.tenantId, scenario.scope.tenantId),
        eq(payments.purchaseCorrelationId, purchaseCorrelationId),
        eq(paymentOperations.kind, 'COLLECT'),
      ),
    );

it.live(
  '#1148 reconcile first: a new intent or method for the same purchase cannot bypass a live or INDETERMINATE COLLECT by omitting its predecessor',
  () =>
    runNative(
      Effect.gen(function* samePurchaseUnresolved() {
        const scenario = yield* lifecycleScenario();
        yield* enableMethod(scenario.native, scenario.scope, CUSTOMER_CONFIGURATION, 'BANK_TRANSFER_ADVANCE');
        const purchaseCorrelationId = `purchase-${randomUUID()}`;
        const original = yield* scenario.create(scenario.intent({ purchaseCorrelationId }));
        const collection = yield* scenario.collect({
          amount: { amountMinor: 100_000, currency: 'CZK' },
          method: 'ONLINE_GATEWAY',
          operationKey: 'collect-1000',
          paymentId: original.payment.paymentId,
        });
        const changedAmount = scenario.intent({
          payableAmount: { amountMinor: 120_000, currency: 'CZK' },
          purchaseCorrelationId,
        });
        const otherMethod = scenario.intent({ purchaseCorrelationId, selection: { method: 'BANK_TRANSFER_ADVANCE' } });

        // Live (PENDING) and then INDETERMINATE: neither a changed amount nor another method opens a new intent.
        expect(yield* failureCodeOf(scenario.create(changedAmount))).toBe('payment_predecessor_unresolved_conflict');
        expect(yield* failureCodeOf(scenario.create(otherMethod))).toBe('payment_predecessor_unresolved_conflict');
        yield* scenario.settle(original.payment.paymentId, collection.operation.operationId, 1, 'INDETERMINATE');
        expect(yield* failureCodeOf(scenario.create(changedAmount))).toBe('payment_predecessor_unresolved_conflict');
        expect(yield* failureCodeOf(scenario.create(otherMethod))).toBe('payment_predecessor_unresolved_conflict');
        expect(yield* purchaseCollects(scenario, purchaseCorrelationId)).toStrictEqual([
          { outcome: 'INDETERMINATE', paymentId: original.payment.paymentId },
        ]);

        // Definitive non-execution releases the purchase: a new intent may now be created for it.
        yield* scenario.settle(
          original.payment.paymentId,
          collection.operation.operationId,
          2,
          'NOT_EFFECTED_CONFIRMED',
        );
        const replacement = yield* scenario.create(changedAmount);
        expect(replacement.payment.purchaseCorrelationId).toBe(purchaseCorrelationId);
        expect(replacement.payment.predecessorPaymentId).toStrictEqual(Option.none());
      }),
    ),
);

it.live('#1148 a proven unreturned collection blocks any new intent for the same purchase, named or not', () =>
  runNative(
    Effect.gen(function* samePurchaseProven() {
      const scenario = yield* lifecycleScenario();
      const purchaseCorrelationId = `purchase-${randomUUID()}`;
      const original = yield* scenario.create(scenario.intent({ purchaseCorrelationId }));
      const collection = yield* scenario.collect({
        amount: { amountMinor: 100_000, currency: 'CZK' },
        method: 'ONLINE_GATEWAY',
        operationKey: 'collect-proven',
        paymentId: original.payment.paymentId,
      });
      yield* scenario.settle(original.payment.paymentId, collection.operation.operationId, 1, 'EFFECT_CONFIRMED');

      expect(yield* failureCodeOf(scenario.create(scenario.intent({ purchaseCorrelationId })))).toBe(
        'payment_predecessor_unresolved_conflict',
      );
      expect(yield* purchaseCollects(scenario, purchaseCorrelationId)).toHaveLength(1);
    }),
  ),
);

it.live('#1145 one purchase never has two collection lineages: a sibling intent cannot start a second COLLECT', () =>
  runNative(
    Effect.gen(function* siblingCollect() {
      const scenario = yield* lifecycleScenario();
      const purchaseCorrelationId = `purchase-${randomUUID()}`;
      // Two intents for one purchase exist before any money moves (neither has an effect yet).
      const first = yield* scenario.create(scenario.intent({ purchaseCorrelationId }));
      const second = yield* scenario.create(scenario.intent({ purchaseCorrelationId }));
      const collection = yield* scenario.collect(exactCollectRequest(first.payment.paymentId, 'collect-first'));

      expect(
        yield* failureCodeOf(scenario.collect(exactCollectRequest(second.payment.paymentId, 'collect-second'))),
      ).toBe('payment_predecessor_unresolved_conflict');
      yield* scenario.settle(first.payment.paymentId, collection.operation.operationId, 1, 'EFFECT_CONFIRMED');
      expect(
        yield* failureCodeOf(scenario.collect(exactCollectRequest(second.payment.paymentId, 'collect-second'))),
      ).toBe('payment_predecessor_unresolved_conflict');
      expect(yield* purchaseCollects(scenario, purchaseCorrelationId)).toStrictEqual([
        { outcome: 'EFFECT_CONFIRMED', paymentId: first.payment.paymentId },
      ]);
      // The replay of the admitted COLLECT is still recovered unchanged.
      const replay = yield* scenario.collect(exactCollectRequest(first.payment.paymentId, 'collect-first'));
      expect(replay.replayed).toBe(true);
    }),
  ),
);

it.live('#1145 concurrent COLLECTs on two intents of one purchase race on PostgreSQL: one wins, one conflicts', () =>
  runNative(
    Effect.gen(function* concurrentSiblingCollects() {
      const scenario = yield* lifecycleScenario();
      const purchaseCorrelationId = `purchase-${randomUUID()}`;
      const first = yield* scenario.create(scenario.intent({ purchaseCorrelationId }));
      const second = yield* scenario.create(scenario.intent({ purchaseCorrelationId }));
      const { blockedCount, outcomes } = yield* raceBehindPaymentLocks(
        scenario,
        [first.payment.paymentId, second.payment.paymentId],
        [
          scenario.collect(exactCollectRequest(first.payment.paymentId, 'collect-first')),
          scenario.collect(exactCollectRequest(second.payment.paymentId, 'collect-second')),
        ],
      );
      expect(blockedCount).toBeGreaterThanOrEqual(2);

      const losers = outcomes.flatMap((outcome) => (Result.isFailure(outcome) ? [outcome.failure] : []));
      expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ code: 'payment_predecessor_unresolved_conflict' });
      expect(yield* purchaseCollects(scenario, purchaseCorrelationId)).toHaveLength(1);
    }),
  ),
);

it.live('#1148 Failed commitment compensation has no refundable items: its sole basis is visible, no items exist', () =>
  runNative(
    Effect.gen(function* compensationWithoutItems() {
      const scenario = yield* lifecycleScenario();
      const created = yield* scenario.create(scenario.intent());
      const { paymentId } = created.payment;
      const collection = yield* scenario.collect({
        amount: { amountMinor: 100_000, currency: 'CZK' },
        method: 'ONLINE_GATEWAY',
        operationKey: 'collect-compensated',
        paymentId,
      });
      yield* scenario.settle(paymentId, collection.operation.operationId, 1, 'EFFECT_CONFIRMED');
      const [provenance, refundExecutionRoute] = yield* Effect.all(
        [
          provenanceFor(scenario.scope),
          configuredRefundExecutionRouteFor(scenario.native.database, scenario.scope, LIFECYCLE_GATEWAY_BINDING),
        ],
        { concurrency: 1 },
      );
      const compensation = yield* scenario.persist((persistence) =>
        persistence.insertOperation({
          amount: { amountMinor: 100_000, currency: 'CZK' },
          binding: LIFECYCLE_GATEWAY_BINDING,
          initialOutcome: 'PENDING',
          kind: 'REFUND',
          materialRequest: { kind: 'REFUND', operationKey: 'compensate' },
          operationKey: 'compensate',
          paymentId,
          provenance,
          refundBasis: {
            _tag: 'FAILED_COMMITMENT_COMPENSATION',
            attemptRef: 'attempt-1',
            closedAgainstLateCommit: true,
            terminalNonCommitEvidenceRef: 'commitment-non-commit-1',
          },
          refundExecutionRoute,
          targetOperationId: collection.operation.operationId,
        }),
      );

      const current = yield* scenario.read(paymentId);
      const refund = current.operations.find((operation) => operation.operationId === compensation.record.operationId);
      expect(refund).toMatchObject({
        kind: 'REFUND',
        refundBasisKind: Option.some('FAILED_COMMITMENT_COMPENSATION'),
        targetOperationId: Option.some(collection.operation.operationId),
      });
      expect(Schema.is(PaymentCoverageEstablishedSchema)(current.coverage)).toBe(true);
      expect(current.coverage).toMatchObject({ reserved: { amountMinor: 100_000 } });
      expect(current.unresolved.unresolvedOperationIds).toStrictEqual([compensation.record.operationId]);
      const claims = yield* scenario.native.coreAdmin
        .select({ claimId: refundItemClaims.claimId })
        .from(refundItemClaims)
        .where(and(eq(refundItemClaims.tenantId, scenario.scope.tenantId), eq(refundItemClaims.paymentId, paymentId)));
      expect(claims).toHaveLength(0);
    }),
  ),
);

it.live('#1148 foreign Tenant or Legal Entity predecessor is not found and never blocks or mutates', () =>
  runNative(
    Effect.gen(function* foreignPredecessor() {
      const owner = yield* lifecycleScenario();
      const original = yield* owner.create(owner.intent());
      const foreign = yield* lifecycleScenario({}, undefined, owner.native);
      expect(
        yield* failureCodeOf(foreign.create(foreign.intent({ predecessorPaymentId: original.payment.paymentId }))),
      ).toBe('payment_not_found');
      const current = yield* owner.read(original.payment.paymentId);
      expect(current.successorPaymentId).toStrictEqual(Option.none());
      expect(current.payment.aggregateVersion).toBe(original.payment.aggregateVersion);
    }),
  ),
);

it.live('#1148 history is unchanged after term metadata/lifecycle and gateway configuration changes', () =>
  runNative(
    Effect.gen(function* historyAfterConfigurationChange() {
      const scenario = yield* lifecycleScenario();
      const payload = scenario.intent();
      const created = yield* scenario.create(payload);
      const { paymentId } = created.payment;
      const collection = yield* scenario.collect({
        amount: { amountMinor: 100_000, currency: 'CZK' },
        method: 'ONLINE_GATEWAY',
        operationKey: 'collect-before-change',
        paymentId,
      });
      expect(created.payment.termSemanticEvidence).toStrictEqual(lifecycleTermSnapshot(scenario.paymentTermRef, 1));

      // C15 publishes a metadata revision, CCC stops entitlement, C17 disables the account.
      yield* scenario.owners.update((state) => ({
        ...state,
        enabledBindings: [],
        metadataRevision: 2,
        termUse: 'NOT_USABLE',
      }));

      const current = yield* scenario.read(paymentId);
      expect(current.payment.termSemanticEvidence).toStrictEqual(lifecycleTermSnapshot(scenario.paymentTermRef, 1));
      expect(current.payment.executionBinding).toStrictEqual(LIFECYCLE_GATEWAY_BINDING);
      expect(current.payment.provenance).toStrictEqual(created.payment.provenance);
      expect(current.operations[0]).toMatchObject({
        binding: LIFECYCLE_GATEWAY_BINDING,
        operationId: collection.operation.operationId,
        outcome: 'PENDING',
      });
      // Replays recover the persisted intent and operation; nothing is re-derived or rebound.
      const replayedIntent = yield* scenario.create(payload);
      expect(replayedIntent.replayed).toBe(true);
      expect(replayedIntent.payment.termSemanticEvidence.metadataRevision).toBe(1);
      const replayedCollection = yield* scenario.collect({
        amount: { amountMinor: 100_000, currency: 'CZK' },
        method: 'ONLINE_GATEWAY',
        operationKey: 'collect-before-change',
        paymentId,
      });
      expect(replayedCollection.operation.operationId).toBe(collection.operation.operationId);
      // A new intent under the changed owner configuration is decided on Current evidence.
      const refused = yield* Effect.flip(scenario.create(scenario.intent()));
      expect(refused).toMatchObject({ code: 'payment_method_not_enabled', outcome: 'NOT_ENABLED' });
      expect(refused).toHaveProperty('findings', [
        { check: 'PAYMENT_TERM', outcome: 'INCOMPATIBLE_TERM', reason: 'ENTITLEMENT_NOT_CURRENT' },
        { check: 'GATEWAY_BINDING', outcome: 'NOT_ENABLED', reason: 'BINDING_NOT_ENABLED' },
      ]);
    }),
  ),
);

/** A created 1000 CZK ONLINE_GATEWAY Payment and its exact collection request. */
const paymentWithCollection = Effect.fn('LifecycleCollectionTest.paymentWithCollection')(function* setup(
  scenario: Scenario,
  amountMinor = 100_000,
) {
  const created = yield* scenario.create(scenario.intent({ payableAmount: { amountMinor, currency: 'CZK' } }));
  const { paymentId } = created.payment;
  const request = (
    operationKey: string,
    overrides: { readonly amountMinor?: number; readonly method?: string } = {},
  ) => ({
    amount: { amountMinor: overrides.amountMinor ?? amountMinor, currency: 'CZK' },
    method: overrides.method ?? 'ONLINE_GATEWAY',
    operationKey,
    paymentId,
  });
  return { created, paymentId, request };
});

const collectRows = (scenario: Scenario, paymentId: string) =>
  scenario.native.coreAdmin
    .select({ operationId: paymentOperations.operationId, outcome: paymentOperations.outcome })
    .from(paymentOperations)
    .where(
      and(
        eq(paymentOperations.tenantId, scenario.scope.tenantId),
        eq(paymentOperations.paymentId, paymentId),
        eq(paymentOperations.kind, 'COLLECT'),
      ),
    );

it.live(
  '#1149 #1158 Gateway collection dispatch is tracked durable work: operation-requested keeps the original binding and true provenance',
  () =>
    runNative(
      Effect.gen(function* collectionRequested() {
        const scenario = yield* lifecycleScenario();
        const { paymentId, request } = yield* paymentWithCollection(scenario);
        const started = yield* scenario.collect(request('collect-1'));

        expect(started.replayed).toBe(false);
        expect(started.operation).toMatchObject({
          binding: LIFECYCLE_GATEWAY_BINDING,
          kind: 'COLLECT',
          outcome: 'PENDING',
          provenance: { actorPrincipalId: scenario.scope.principalId, compositionRevision: COMPOSITION_R1 },
        });
        const [event] = yield* outboxPayloads(scenario.native, scenario.scope.tenantId, OPERATION_REQUESTED);
        // #1158 Gateway collection dispatch is tracked durable work of the admitting revision R1.
        const [dispatch, ...others] = yield* scenario.native.coreAdmin
          .select({
            completionConsumer: outboxMessages.completionConsumerModuleKey,
            completionRevision: outboxMessages.completionOriginalRevision,
            outboxMessageId: outboxMessages.outboxMessageId,
          })
          .from(outboxMessages)
          .where(
            and(eq(outboxMessages.tenantId, scenario.scope.tenantId), eq(outboxMessages.topic, OPERATION_REQUESTED)),
          );
        expect(others).toHaveLength(0);
        expect(dispatch).toMatchObject({ completionConsumer: 'payment.core', completionRevision: COMPOSITION_R1 });
        const dispatchWork = yield* scenario.native.coreAdmin
          .select({ originalRevision: applicationCompositionDurableWork.originalRevision })
          .from(applicationCompositionDurableWork)
          .where(
            and(
              eq(applicationCompositionDurableWork.ownerModuleKey, 'payment.core'),
              eq(applicationCompositionDurableWork.workId, `outbox:${dispatch?.outboxMessageId}:payment.core`),
            ),
          );
        expect(dispatchWork).toStrictEqual([{ originalRevision: COMPOSITION_R1 }]);
        expect(event).toMatchObject({
          amount: { amountMinor: 100_000, currency: 'CZK' },
          binding: LIFECYCLE_GATEWAY_BINDING,
          kind: 'COLLECT',
          method: 'ONLINE_GATEWAY',
          operationId: started.operation.operationId,
          paymentId,
          provenance: {
            actionInvocationId: started.operation.provenance.actionInvocationId,
            compositionRevision: COMPOSITION_R1,
          },
        });
        const current = yield* scenario.read(paymentId);
        expect(current.unresolved.unresolvedOperationIds).toStrictEqual([started.operation.operationId]);
        expect(current.coverage).toStrictEqual(
          PaymentCoverageNotCollectedSchema.make({
            liveCollectOperationId: Option.some(started.operation.operationId),
          }),
        );
      }),
    ),
);

it.live('#1148 Retrying a collection: an INDETERMINATE COLLECT replayed by a new invocation keeps its identity', () =>
  runNative(
    Effect.gen(function* retryIndeterminate() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario);
      const original = yield* scenario.collect(request('collect-retry'));
      yield* scenario.settle(paymentId, original.operation.operationId, 1, 'INDETERMINATE');

      const recovered = yield* scenario.collect(request('collect-retry'));

      expect(recovered.replayed).toBe(true);
      expect(recovered.operation.operationId).toBe(original.operation.operationId);
      expect(recovered.operation.outcome).toBe('INDETERMINATE');
      expect(recovered.operation.provenance).toStrictEqual(original.operation.provenance);
      expect(yield* collectRows(scenario, paymentId)).toHaveLength(1);
      expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, OPERATION_REQUESTED)).toHaveLength(1);
    }),
  ),
);

it.live(
  '#1148 A new Core invocation recovers the same business operation; the same Core key is an already-committed replay',
  () =>
    runNative(
      Effect.gen(function* coreKeyVersusNewInvocation() {
        const scenario = yield* lifecycleScenario();
        const { paymentId, request } = yield* paymentWithCollection(scenario);
        const coreKey = randomUUID();
        const original = yield* scenario.collect(request('collect-e'), coreKey);

        // Same Core idempotency key + same request: Core answers from the committed invocation.
        const sameKey = yield* Effect.flip(scenario.collect(request('collect-e'), coreKey));
        expect(sameKey).toMatchObject({
          code: 'action_already_committed',
          invocationId: original.operation.provenance.actionInvocationId,
        });
        // Same Core key + different request: a request-hash conflict, never a second execution.
        expect(yield* failureCodeOf(scenario.collect(request('collect-other'), coreKey))).toBe(
          'action_request_hash_conflict',
        );
        // A new authorized invocation (new Core key, later time) recovers E with its original provenance.
        const recovered = yield* scenario.collect(request('collect-e'));
        expect(recovered.replayed).toBe(true);
        expect(recovered.operation.operationId).toBe(original.operation.operationId);
        expect(recovered.operation.provenance.actionInvocationId).toBe(
          original.operation.provenance.actionInvocationId,
        );
        // A material amount or method mismatch under E's key remains a conflict.
        expect(yield* failureCodeOf(scenario.collect(request('collect-e', { amountMinor: 99_999 })))).toBe(
          'payment_operation_material_conflict',
        );
        expect(yield* failureCodeOf(scenario.collect(request('collect-e', { method: 'BANK_TRANSFER_ADVANCE' })))).toBe(
          'payment_operation_material_conflict',
        );
        expect(yield* collectRows(scenario, paymentId)).toHaveLength(1);
        expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, OPERATION_REQUESTED)).toHaveLength(1);
      }),
    ),
);

it.live('#1148 two concurrent distinct COLLECT identities race on PostgreSQL: one wins, one conflicts', () =>
  runNative(
    Effect.gen(function* concurrentCollects() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario);
      const { blockedCount, outcomes } = yield* raceBehindPaymentLocks(
        scenario,
        [paymentId],
        [scenario.collect(request('collect-a')), scenario.collect(request('collect-b'))],
      );
      expect(blockedCount).toBeGreaterThanOrEqual(2);

      const winners = outcomes.filter(Result.isSuccess);
      const losers = outcomes.flatMap((outcome) => (Result.isFailure(outcome) ? [outcome.failure] : []));
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toBeInstanceOf(PaymentConflict);
      expect(losers[0]).toMatchObject({ code: 'payment_collect_lineage_conflict' });
      expect(yield* collectRows(scenario, paymentId)).toHaveLength(1);
      expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, OPERATION_REQUESTED)).toHaveLength(1);
    }),
  ),
);

it.live('#1148 a second distinct live COLLECT and a COLLECT after EFFECT_CONFIRMED are lineage conflicts', () =>
  runNative(
    Effect.gen(function* lineageConflicts() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario);
      const live = yield* scenario.collect(request('collect-live'));
      expect(yield* failureCodeOf(scenario.collect(request('collect-competing')))).toBe(
        'payment_collect_lineage_conflict',
      );
      yield* scenario.settle(paymentId, live.operation.operationId, 1, 'EFFECT_CONFIRMED');
      expect(yield* failureCodeOf(scenario.collect(request('collect-after-confirmed')))).toBe(
        'payment_collect_lineage_conflict',
      );
      expect(yield* collectRows(scenario, paymentId)).toStrictEqual([
        { operationId: live.operation.operationId, outcome: 'EFFECT_CONFIRMED' },
      ]);
    }),
  ),
);

it.live('#1148 Refund does not erase collection, and a later refund never reopens the Payment for recollection', () =>
  runNative(
    Effect.gen(function* refundKeepsCollection() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario);
      const collected = yield* scenario.collect(request('collect-refunded'));
      yield* scenario.settle(paymentId, collected.operation.operationId, 1, 'EFFECT_CONFIRMED');
      // The REFUND (lane L4 Action) is recorded through the shared aggregate primitive on the same lock.
      const [provenance, refundExecutionRoute] = yield* Effect.all(
        [
          provenanceFor(scenario.scope),
          configuredRefundExecutionRouteFor(scenario.native.database, scenario.scope, LIFECYCLE_GATEWAY_BINDING),
        ],
        { concurrency: 1 },
      );
      const refund = yield* scenario.persist((persistence) =>
        persistence.insertOperation({
          amount: { amountMinor: 100_000, currency: 'CZK' },
          binding: LIFECYCLE_GATEWAY_BINDING,
          initialOutcome: 'PENDING',
          kind: 'REFUND',
          materialRequest: { amountMinor: 100_000, kind: 'REFUND', operationKey: 'refund-all' },
          operationKey: 'refund-all',
          paymentId,
          provenance,
          refundBasis: {
            _tag: 'REFUNDABLE_ITEMS',
            items: [{ amountMinor: 100_000, currency: 'CZK', itemRef: 'item-1', sourceEvidenceRef: 'order-item-1' }],
          },
          refundExecutionRoute,
          targetOperationId: collected.operation.operationId,
        }),
      );
      yield* scenario.settle(paymentId, refund.record.operationId, 1, 'EFFECT_CONFIRMED');

      const current = yield* scenario.read(paymentId);
      const collect = current.operations.find((operation) => operation.kind === 'COLLECT');
      expect(collect).toMatchObject({ operationId: collected.operation.operationId, outcome: 'EFFECT_CONFIRMED' });
      expect(Schema.is(PaymentCoverageEstablishedSchema)(current.coverage)).toBe(true);
      expect(current.coverage).toMatchObject({
        collected: { amountMinor: 100_000, currency: 'CZK' },
        confirmedReturned: { amountMinor: 100_000, currency: 'CZK' },
        remaining: { amountMinor: 0, currency: 'CZK' },
      });
      expect(yield* failureCodeOf(scenario.collect(request('collect-again-after-refund')))).toBe(
        'payment_collect_lineage_conflict',
      );
    }),
  ),
);

it.live('#1148 genuine NOT_EFFECTED_CONFIRMED allows a new COLLECT under the unchanged meaning and binding', () =>
  runNative(
    Effect.gen(function* notEffectedRecovery() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario);
      const declined = yield* scenario.collect(request('collect-declined'));
      yield* scenario.settle(paymentId, declined.operation.operationId, 1, 'NOT_EFFECTED_CONFIRMED');
      // Definitive non-execution does not permit a changed meaning.
      expect(yield* failureCodeOf(scenario.collect(request('collect-changed', { amountMinor: 50_000 })))).toBe(
        'payment_collection_meaning_conflict',
      );

      const next = yield* scenario.collect(request('collect-second'));

      expect(next.replayed).toBe(false);
      expect(next.operation.operationId).not.toBe(declined.operation.operationId);
      expect(next.operation.binding).toStrictEqual(LIFECYCLE_GATEWAY_BINDING);
      const events = yield* outboxPayloads(scenario.native, scenario.scope.tenantId, OPERATION_REQUESTED);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ binding: LIFECYCLE_GATEWAY_BINDING, operationId: next.operation.operationId });
    }),
  ),
);

it.live('#1148 partial or over-payment requests are explicit conflicts, never promoted to the exact COLLECT', () =>
  runNative(
    Effect.gen(function* partialAndOverPayment() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario);
      expect(yield* failureCodeOf(scenario.collect(request('collect-partial', { amountMinor: 40_000 })))).toBe(
        'payment_collection_meaning_conflict',
      );
      expect(yield* failureCodeOf(scenario.collect(request('collect-over', { amountMinor: 150_000 })))).toBe(
        'payment_collection_meaning_conflict',
      );
      expect(
        yield* failureCodeOf(scenario.collect(request('collect-other-method', { method: 'CASH_ON_DELIVERY' }))),
      ).toBe('payment_collection_meaning_conflict');
      expect(yield* collectRows(scenario, paymentId)).toHaveLength(0);
    }),
  ),
);

it.live('#1148 zero payable creates the Payment but never a fictitious COLLECT', () =>
  runNative(
    Effect.gen(function* zeroPayable() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario, 0);
      expect(yield* failureCodeOf(scenario.collect(request('collect-zero')))).toBe(
        'payment_zero_payable_no_collection',
      );
      const current = yield* scenario.read(paymentId);
      expect(current.coverage).toStrictEqual(PaymentCoverageZeroPayableSchema.make({}));
      expect(current.operations).toHaveLength(0);
      expect(yield* outboxPayloads(scenario.native, scenario.scope.tenantId, OPERATION_REQUESTED)).toHaveLength(0);
    }),
  ),
);

it.live("#1148 foreign Tenant or Selling Legal Entity cannot collect, read or replay another scope's Payment", () =>
  runNative(
    Effect.gen(function* foreignScope() {
      const owner = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(owner);
      const started = yield* owner.collect(request('collect-owner'));
      const foreign = yield* lifecycleScenario({}, undefined, owner.native);

      expect(yield* failureCodeOf(foreign.collect(request('collect-owner')))).toBe('payment_not_found');
      expect(yield* failureCodeOf(foreign.collect(request('collect-foreign')))).toBe('payment_not_found');
      expect(yield* failureCodeOf(foreign.read(paymentId))).toBe('read_handler_not_found');
      const current = yield* owner.read(paymentId);
      expect(current.operations.map((operation) => operation.operationId)).toStrictEqual([
        started.operation.operationId,
      ]);
    }),
  ),
);

it.live('#1148 #1155 a COLLECT after gateway disablement or account replacement keeps the original binding', () =>
  runNative(
    Effect.gen(function* noFailover() {
      const scenario = yield* lifecycleScenario();
      const { paymentId, request } = yield* paymentWithCollection(scenario);
      // A C17 outage fails closed; nothing is started.
      yield* scenario.owners.update((state) => ({ ...state, gatewayAvailable: false }));
      expect(yield* failureCodeOf(scenario.collect(request('collect-during-outage')))).toBe(
        'payment_owner_evidence_unavailable',
      );
      expect(yield* collectRows(scenario, paymentId)).toHaveLength(0);
      // C17 now offers only a different account/environment to new intents; this existing Payment keeps its own.
      yield* scenario.owners.update((state) => ({
        ...state,
        enabledBindings: [
          { ...LIFECYCLE_GATEWAY_BINDING, environment: 'sandbox', providerAccountRef: 'gopay-account-other' },
        ],
        gatewayAvailable: true,
      }));
      const started = yield* scenario.collect(request('collect-after-replacement'));
      expect(started.operation.binding).toStrictEqual(LIFECYCLE_GATEWAY_BINDING);
      expect(yield* collectRows(scenario, paymentId)).toHaveLength(1);
      const current = yield* scenario.read(paymentId);
      expect(current.payment.executionBinding).toStrictEqual(LIFECYCLE_GATEWAY_BINDING);
    }),
  ),
);

it.live(
  '#1148 A pending business Payment receives evidence under a compatible new runtime: same E, both provenances true',
  () =>
    runNative(
      Effect.gen(function* compositionR2() {
        const scenario = yield* lifecycleScenario();
        const { paymentId, request } = yield* paymentWithCollection(scenario);
        const original = yield* scenario.collect(request('collect-r1'));
        const r2 = yield* makeLifecycleRuntimes(scenario.native, COMPOSITION_R2);

        // A new R2-admitted invocation targets the same original operation and binding.
        const recovered = yield* scenario.collect(request('collect-r1'), randomUUID(), r2);
        expect(recovered.replayed).toBe(true);
        expect(recovered.operation.operationId).toBe(original.operation.operationId);
        expect(recovered.operation.provenance.compositionRevision).toBe(COMPOSITION_R1);
        // Qualified evidence accepted under R2 (lane L6 Action) moves the same E once.
        const applied = yield* scenario.settle(
          paymentId,
          original.operation.operationId,
          1,
          'EFFECT_CONFIRMED',
          COMPOSITION_R2,
        );
        const duplicate = yield* scenario.settle(
          paymentId,
          original.operation.operationId,
          2,
          'EFFECT_CONFIRMED',
          COMPOSITION_R2,
        );
        expect(applied.written).toBe(true);
        expect(duplicate.written).toBe(false);

        const current = yield* scenario.read(paymentId, r2);
        expect(current.operations).toHaveLength(1);
        expect(current.operations[0]?.provenance.compositionRevision).toBe(COMPOSITION_R1);
        expect(Schema.is(PaymentCoverageEstablishedSchema)(current.coverage)).toBe(true);
        expect(current.coverage).toMatchObject({ collected: { amountMinor: 100_000 } });
        const transitions = yield* scenario.native.coreAdmin
          .select({
            compositionRevision: operationOutcomeTransitions.compositionRevision,
            toOutcome: operationOutcomeTransitions.toOutcome,
          })
          .from(operationOutcomeTransitions)
          .where(
            and(
              eq(operationOutcomeTransitions.tenantId, scenario.scope.tenantId),
              eq(operationOutcomeTransitions.operationId, original.operation.operationId),
            ),
          )
          .orderBy(operationOutcomeTransitions.outcomeRevision);
        expect(transitions).toStrictEqual([
          { compositionRevision: COMPOSITION_R1, toOutcome: 'PENDING' },
          { compositionRevision: COMPOSITION_R2, toOutcome: 'EFFECT_CONFIRMED' },
        ]);
      }),
    ),
);
