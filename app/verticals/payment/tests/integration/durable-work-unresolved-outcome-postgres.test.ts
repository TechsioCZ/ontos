import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Option } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { applicationCompositionDurableWork, coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1151/#1153 TECH-01: an unknown monetary effect stays Core durable work of payment.core under the
 * revision that made it unknown until the operation reaches a proven definitive outcome. Leaving
 * INDETERMINATE for another unresolved outcome (a governed CONFLICT classification without outcome
 * evidence, or a weak PENDING observation) is neither completion nor a safe checkpoint, so the drain
 * fence must keep holding the release.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

/** The real Core Action and Read runtimes as they run under one approved Composition revision. */
const makeRuntimes = Effect.fn('DurableWorkUnresolvedOutcome.makeRuntimes')(function* makeRuntimes(
  database: EvidenceNativeDatabase,
  compositionRevision: string,
) {
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const actions = makeActionRuntime(
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
      resolveCompositionRevision: () => Effect.succeed(compositionRevision),
    },
  );
  const reads = makeReadRuntime(
    { executor: database.database },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    evidenceContextAccess,
    {
      accessDecision,
      databaseIdentities: defineDatabaseIdentityEnrollment([]),
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

/** A gateway COLLECT under R1 whose provider response was lost: INDETERMINATE with an open case. */
const unknownCollect = Effect.fn('DurableWorkUnresolvedOutcome.unknownCollect')(function* unknownCollect() {
  yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
  const { admin, runtime } = yield* testDatabaseClients;
  const database: EvidenceNativeDatabase = {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  };
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const evidence = evidenceScenarioOf({
    native: database,
    r1: yield* makeRuntimes(database, COMPOSITION_R1),
    r2: yield* makeRuntimes(database, COMPOSITION_R2),
    scope,
  });
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-unknown',
    paymentId: payment.paymentId,
  });
  yield* evidence.configureSource({
    factFamily: 'GATEWAY_OUTCOME',
    reason: 'GoPay callbacks are the gateway outcome authority',
    refundRoute: false,
    source: GOPAY_SOURCE,
    status: 'ACTIVE',
    submitterPrincipalIds: [scope.principalId],
  });
  const recover = (trigger: 'EXECUTION_OUTCOME_UNKNOWN' | 'LOOKUP_AUTHORITY_UNAVAILABLE') =>
    evidence.recover({
      operationId: collect.operationId,
      paymentId: payment.paymentId,
      reason: 'The provider create response was lost',
      trigger,
    });
  const unknown = yield* recover('EXECUTION_OUTCOME_UNKNOWN');
  expect(unknown.operationOutcome).toBe('INDETERMINATE');
  /** The revisions under which Core tracks this operation's unknown effect. */
  const trackedWork = database.coreAdmin
    .select({ originalRevision: applicationCompositionDurableWork.originalRevision })
    .from(applicationCompositionDurableWork)
    .where(
      and(
        eq(applicationCompositionDurableWork.ownerModuleKey, 'payment.core'),
        eq(applicationCompositionDurableWork.workId, `payment-operation:${scope.tenantId}:${collect.operationId}`),
      ),
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.originalRevision)));
  expect(yield* trackedWork).toEqual([COMPOSITION_R1]);
  const outcome = evidence.rows.operations(payment.paymentId).pipe(Effect.map(([row]) => row?.outcome));
  /** One GoPay callback about the original collection. */
  const gopayReport = (factKind: 'COLLECTION_CONFIRMED' | 'COLLECTION_PENDING') =>
    evidence.accept({
      amount: { amountMinor: 100_000, currency: 'CZK' },
      factFamily: 'GATEWAY_OUTCOME',
      factKind,
      operationId: collect.operationId,
      paymentId: payment.paymentId,
      source: GOPAY_SOURCE,
      sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
      sourceRevision: 0,
    });
  return { collect, evidence, gopayReport, outcome, payment, recover, trackedWork };
});

it.live(
  '#1151 A CONFLICT classification of an unknown effect keeps its durable work until proven evidence resolves it',
  () =>
    native(
      Effect.gen(function* conflictKeepsDurableWork() {
        const { evidence, gopayReport, outcome, payment, recover, trackedWork } = yield* unknownCollect();
        yield* recover('LOOKUP_AUTHORITY_UNAVAILABLE');
        const [operationCase] = yield* evidence.rows.cases(payment.paymentId);
        const caseId = operationCase?.caseId ?? '';
        const classified = yield* evidence.decide({
          caseId,
          decision: { _tag: 'CLASSIFY_CONFLICT' },
          reason: 'Contradictory signals, no outcome evidence',
        });
        expect(Option.getOrUndefined(classified.outcomeChange)).toMatchObject({
          fromOutcome: 'INDETERMINATE',
          toOutcome: 'CONFLICT',
        });
        // A classification without outcome evidence is no completion: R1 still holds the unknown effect.
        expect(yield* trackedWork).toEqual([COMPOSITION_R1]);

        // Proven evidence later resolves the CONFLICT, and only then the work is released.
        const statement = yield* gopayReport('COLLECTION_CONFIRMED');
        expect(statement.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        const attached = yield* evidence.decide({
          caseId,
          decision: { _tag: 'ATTACH_EVIDENCE', observationId: statement.observationId },
          reason: 'The callback proves the collection',
        });
        expect(Option.getOrUndefined(attached.outcomeChange)).toMatchObject({ toOutcome: 'EFFECT_CONFIRMED' });
        expect(yield* outcome).toBe('EFFECT_CONFIRMED');
        expect(yield* trackedWork).toEqual([]);
      }),
    ),
);

it.live('#1151 A weak PENDING observation of an unknown effect keeps its durable work until a definitive outcome', () =>
  native(
    Effect.gen(function* pendingKeepsDurableWork() {
      const { gopayReport, outcome, trackedWork } = yield* unknownCollect();
      yield* gopayReport('COLLECTION_PENDING');
      expect(yield* outcome).toBe('PENDING');
      // Business waiting reported by the provider is no proof of the original effect: R1 still holds it.
      expect(yield* trackedWork).toEqual([COMPOSITION_R1]);

      yield* gopayReport('COLLECTION_CONFIRMED');
      expect(yield* outcome).toBe('EFFECT_CONFIRMED');
      expect(yield* trackedWork).toEqual([]);
    }),
  ),
);
