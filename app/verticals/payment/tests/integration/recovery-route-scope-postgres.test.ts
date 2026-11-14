import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import { AccessScopeIdSchema, LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Layer, Option, Predicate, Schema } from 'effect';
import type { Scope } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { bindAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type {
  AccessEnforcementPorts,
  BoundAccessGate,
} from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { GatewayMerchantIdentitySchema } from '../../shared/domain/psp-configuration.ts';
import type { GatewayProviderAccountBindingView } from '../../shared/domain/psp-configuration.ts';
import { requestPaymentOperationRecoveryAction } from '../../src/actions/request-payment-operation-recovery.action.ts';
import { recoveryRequests } from '../../src/database/schema.ts';
import { providerReplayEvidenceForTransaction } from '../../src/integrations/psp/replay-guarantee-live.ts';
import { pspBindingPersistenceForTransaction } from '../../src/persistence/psp-binding-persistence.ts';
import { PaymentProviderReplayEvidencePort } from '../../src/ports/provider-replay-evidence-port.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  RECOVERY_ROUTE_OPERATION,
  routeScopedPrincipalOf,
  testNotificationRouteOf,
} from '../support/route-scope.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import {
  collectInput,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  provenanceFor,
  withPersistence,
} from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  evidenceAllowedPermission,
  evidenceContextAccess,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1153 / #1157 native evidence for operation recovery (A10) under a provider binding route scope, on the
 * worktree PostgreSQL through the real Core Action runtime: a route-scoped request must come from the admitted
 * reconciliation workload and may recover only an operation dispatched through the signed route's binding. A
 * person's request carries no route scope and is unchanged.
 */

const RECONCILIATION_WORKLOAD = 'payment.provider-reconciliation';

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* nativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  return {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  } satisfies EvidenceNativeDatabase;
});

/** An intent source that resolves every request to its Tenant scope and holds no grant cells. */
const authorityFor: AccessEnforcementPorts['intent']['authorityFor'] = () => ({
  readCells: () => Effect.succeed([]),
  // Every company these fixtures name is the fixture Tenant's own.
  readCompanyOwnership: () => Effect.succeed(true),
  readConnection: () => Effect.succeed(Option.none()),
  readScope: (query) =>
    Effect.succeed(
      Option.some({
        deadlines: [],
        holderDeadlines: [],
        scope: { _tag: 'TenantContext', tenantId: query.tenantId },
        scopeId: AccessScopeIdSchema.make('77777777-7777-4777-8777-777777777777'),
        tenantId: query.tenantId,
      }),
    ),
  readTeamIds: () => Effect.succeed([]),
});

/** The real Core access decision: an integration principal bound to exactly `boundKeys` (O73). */
const workloadGate = (boundKeys: readonly string[]): BoundAccessGate => {
  const ports: AccessEnforcementPorts = {
    ...inertAccessEnforcementPorts(),
    intent: { authorityFor },
    principalKinds: { readKind: () => Effect.succeed(Option.some('integration')) },
    workloadBindings: {
      // The workload is registered for the company the call runs in (D6).
      readWorkloadAuthority: (query) =>
        Effect.succeed({
          activeCompanyIds: new Set(
            query.scope.legalEntityId === undefined ? [] : [LegalEntityIdSchema.make(query.scope.legalEntityId)],
          ),
          workloadKeys: new Set(boundKeys),
        }),
    },
  };
  return bindAccessGate(
    makeAccessDecisionService({
      authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
      workloadBindings: ports.workloadBindings,
    }),
    ports,
  );
};

const makeActions = Effect.fn('RecoveryRouteScope.makeActions')(function* makeActions(
  database: EvidenceNativeDatabase,
  accessDecision: BoundAccessGate,
) {
  return makeActionRuntime(
    { executor: database.database },
    makeActionRepository(yield* Crypto.Crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess: evidenceContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(COMPOSITION_R1),
    },
  );
});

/** A SANDBOX binding of the scope for `merchantIdentityDocument`, with its Payment-issued route. */
const createBinding = Effect.fn('RecoveryRouteScope.createBinding')(function* createBinding(
  database: EvidenceNativeDatabase,
  scope: PaymentTestScope,
  merchantIdentityDocument: Schema.Json,
) {
  const provenance = yield* provenanceFor(scope);
  const merchantIdentity = yield* Schema.decodeUnknownEffect(GatewayMerchantIdentitySchema)(merchantIdentityDocument);
  const created = yield* database.database.transaction((transaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope), defineDatabaseIdentityEnrollment([])).pipe(
      Effect.flatMap((scoped) =>
        pspBindingPersistenceForTransaction(scoped).createBinding({
          environment: 'SANDBOX',
          merchantIdentity,
          provenance,
          reason: 'Configure the sandbox gateway account',
          replaces: Option.none(),
          route: testNotificationRouteOf(scope.tenantId, merchantIdentity._tag),
          secretRef: `${merchantIdentity._tag.toLowerCase()}-sandbox-1`,
        }),
      ),
    ),
  );
  return created.binding.view;
});

/** A Payment with one PENDING COLLECT dispatched through `binding`. */
const collectThrough = Effect.fn('RecoveryRouteScope.collectThrough')(function* collectThrough(
  database: EvidenceNativeDatabase,
  scope: PaymentTestScope,
  binding: GatewayProviderAccountBindingView,
) {
  const executionBinding = {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: binding.providerAccountRef,
    providerFamily: 'GOPAY',
  } as const;
  const paymentInput = yield* newPaymentInput(scope);
  const created = yield* withPersistence(database.database, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding }),
  );
  const collect = yield* collectInput(scope, { amountMinor: 100_000, paymentId: created.record.paymentId }, 'c-1');
  const collected = yield* withPersistence(database.database, scope, (persistence) =>
    persistence.insertOperation({ ...collect, binding: executionBinding }),
  );
  return { operationId: collected.record.operationId, paymentId: created.record.paymentId };
});

const scenario = Effect.fn('RecoveryRouteScope.scenario')(function* scenario() {
  yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const routed = yield* createBinding(database, scope, { _tag: 'GOPAY', goid: '8100000001' });
  // Another merchant account of the same Selling Legal Entity, with its own route.
  const otherMerchant = yield* createBinding(database, scope, { _tag: 'COMGATE', merchantId: '654321' });
  const operation = yield* collectThrough(database, scope, routed);
  return { database, operation, otherMerchant, routed, scope };
});

const recover = (
  actions: Effect.Success<ReturnType<typeof makeActions>>,
  principal: TrustedPrincipalContext | ReturnType<typeof principalOf>,
  operation: { readonly operationId: string; readonly paymentId: string },
  idempotencyKey: string,
) =>
  actions
    .runAction({
      payload: {
        operationId: operation.operationId,
        paymentId: operation.paymentId,
        reason: 'Gateway reconciliation round 0',
        trigger: 'OPERATOR_REQUEST',
      },
      principal,
      registration: requestPaymentOperationRecoveryAction,
      transport: { correlationId: 'payment-recovery-route-scope', idempotencyKey },
    })
    .pipe(Effect.provide(Layer.succeed(PaymentProviderReplayEvidencePort, providerReplayEvidenceForTransaction)));

const recoveryRows = (database: EvidenceNativeDatabase, scope: PaymentTestScope, operationId: string) =>
  database.coreAdmin
    .select({ recoveryId: recoveryRequests.recoveryId })
    .from(recoveryRequests)
    .where(and(eq(recoveryRequests.tenantId, scope.tenantId), eq(recoveryRequests.operationId, operationId)));

const routedPrincipal = (scope: PaymentTestScope, bindingId: string) =>
  routeScopedPrincipalOf(scope, {
    bindingId,
    compositionRevision: COMPOSITION_R1,
    operation: RECOVERY_ROUTE_OPERATION,
  });

describe('#1153 recovery (A10) under a provider binding route scope', () => {
  it.live('#1153 A10 with a route of another binding is refused; nothing is written', () =>
    native(
      Effect.gen(function* otherBindingRefused() {
        const { database, operation, otherMerchant, scope } = yield* scenario();
        const actions = yield* makeActions(database, workloadGate([RECONCILIATION_WORKLOAD]));
        const refused = yield* recover(
          actions,
          routedPrincipal(scope, otherMerchant.bindingId),
          operation,
          'recovery-other-binding',
        ).pipe(Effect.flip);
        expect(Predicate.isTagged(refused, 'PaymentRouteScopeRefused')).toBe(true);
        expect(yield* recoveryRows(database, scope, operation.operationId)).toEqual([]);
      }),
    ),
  );

  it.live('#1153 a routed request must be admitted as the reconciliation workload', () =>
    native(
      Effect.gen(function* workloadRequired() {
        const { database, operation, routed, scope } = yield* scenario();
        // Admitted by a scripted allow, not through the reconciliation workload carrier.
        const scripted = yield* makeActions(database, makeScriptedBoundAccessGate('allowed').bound);
        const refused = yield* recover(
          scripted,
          routedPrincipal(scope, routed.bindingId),
          operation,
          'recovery-not-workload',
        ).pipe(Effect.flip);
        expect(Predicate.isTagged(refused, 'PaymentRouteScopeRefused')).toBe(true);
        expect(yield* recoveryRows(database, scope, operation.operationId)).toEqual([]);
      }),
    ),
  );

  it.live('#1153 the reconciliation workload recovers an operation of its own route; a person is unchanged', () =>
    native(
      Effect.gen(function* routedAndHumanAdmitted() {
        const { database, operation, routed, scope } = yield* scenario();
        const actions = yield* makeActions(database, workloadGate([RECONCILIATION_WORKLOAD]));
        const accepted = yield* recover(
          actions,
          routedPrincipal(scope, routed.bindingId),
          operation,
          'recovery-routed',
        );
        expect([accepted.operationId, accepted.paymentId]).toEqual([operation.operationId, operation.paymentId]);

        // A person's request carries no route scope: decided exactly as before.
        const human = yield* makeActions(database, makeScriptedBoundAccessGate('allowed').bound);
        const manual = yield* recover(human, principalOf(scope), operation, 'recovery-human');
        expect(manual.operationId).toBe(operation.operationId);
        expect(yield* recoveryRows(database, scope, operation.operationId)).toHaveLength(2);
      }),
    ),
  );
});
