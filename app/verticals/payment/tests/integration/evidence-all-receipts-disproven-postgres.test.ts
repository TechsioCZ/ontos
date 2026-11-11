import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
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
import { makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* allReceiptsDisproven() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('AllReceiptsDisproven.makeRuntimes')(function* makeRuntimes(
  database: EvidenceNativeDatabase,
  compositionRevision: string,
) {
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const actions = makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
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

const scenario = Effect.fn('AllReceiptsDisproven.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const configureGopay = (evidence: EvidenceScenario) =>
  evidence.configureSource({
    factFamily: 'GATEWAY_OUTCOME',
    reason: 'GoPay callbacks are the gateway outcome authority',
    refundRoute: false,
    source: GOPAY_SOURCE,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });

const gopayStatement = (fields: {
  readonly amount?: { readonly amountMinor: number; readonly currency: 'CZK' | 'EUR' };
  readonly correctsObservationId?: string;
  readonly economicEffectKey?: string;
  readonly factKind: 'COLLECTION_CONFIRMED' | 'REFUND_CONFIRMED' | 'SOURCE_CORRECTION';
  readonly operationId?: string;
  readonly paymentId?: string;
}) => ({
  factFamily: 'GATEWAY_OUTCOME' as const,
  source: GOPAY_SOURCE,
  sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
  sourceRevision: 0,
  ...fields,
});

/** A 100k CZK GoPay COLLECT confirmed by one accepted keyed callback through the registered Action. */
const confirmedCollect = Effect.fn('AllReceiptsDisproven.confirmedCollect')(function* confirmedCollect(
  evidence: EvidenceScenario,
  key: string,
) {
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: `collect-${randomUUID()}`,
    paymentId: payment.paymentId,
  });
  yield* configureGopay(evidence);
  const first = yield* evidence.accept(
    gopayStatement({
      amount: czk(100_000),
      economicEffectKey: key,
      factKind: 'COLLECTION_CONFIRMED',
      operationId: collect.operationId,
      paymentId: payment.paymentId,
    }),
  );
  expect(first).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', interpretation: 'TRANSITION' });
  return { collect, first, payment };
});

// the scenario (finding): a partial correction is accepted, then the full retraction of the same receipt is HELD
// (overlap). A distinct second 100k charge arriving afterwards must be held as its own OPEN debt, but it is
// accepted as NO_CHANGE / ACCEPTED_OBSERVATION because the held full retraction empties the standing
// confirmations, so the empty-standing rule in restatesEstablishedEffect treats it as corroboration.
it.live('#1151 a distinct charge after a held full overlap of a partial correction is held, not corroborating', () =>
  native(
    Effect.gen(function* s11HeldOverlapThenDistinct() {
      const evidence = yield* scenario();
      const { collect, first, payment } = yield* confirmedCollect(evidence, `gopay:charge:s11-first-${randomUUID()}`);
      yield* evidence.accept(
        gopayStatement({
          amount: czk(60_000),
          correctsObservationId: first.observationId,
          economicEffectKey: `gopay:corr:partial-${randomUUID()}`,
          factKind: 'SOURCE_CORRECTION',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      const heldFull = yield* evidence.accept(
        gopayStatement({
          correctsObservationId: first.observationId,
          economicEffectKey: `gopay:corr:full-${randomUUID()}`,
          factKind: 'SOURCE_CORRECTION',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(heldFull).toMatchObject({ interpretation: 'HOLD' });
      const second = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: `gopay:charge:s11-second-${randomUUID()}`,
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(second.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      expect(second.reconciliationCaseId).toBeDefined();
    }),
  ),
);
