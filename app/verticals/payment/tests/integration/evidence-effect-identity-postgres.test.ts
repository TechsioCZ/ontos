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
import type { PaymentObservationFactKind } from '../../shared/domain/payment-vocabulary.ts';
import { failureCodeOf, makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

/**
 * Review 3 lens e1 (collect corrections, invariants 2, 5, 6), through the registered
 * `accept-payment-observation` Action on native PostgreSQL. Only failing finding tests are kept.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* effectIdentityNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('EffectIdentity.makeRuntimes')(function* makeRuntimes(
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

const scenario = Effect.fn('EffectIdentity.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' });

/** One GoPay statement; optional members are included only when the scenario names them. */
const statement = (fields: {
  readonly amount?: { readonly amountMinor: number; readonly currency: string };
  readonly correctsObservationId?: string;
  readonly economicEffectKey?: string;
  readonly factKind: PaymentObservationFactKind;
  readonly operationId: string;
  readonly paymentId: string;
}) => ({
  factFamily: 'GATEWAY_OUTCOME' as const,
  source: GOPAY_SOURCE,
  sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
  sourceRevision: 0,
  ...fields,
});

const configureGopay = (evidence: EvidenceScenario) =>
  evidence.configureSource({
    factFamily: 'GATEWAY_OUTCOME',
    reason: 'GoPay callbacks are the gateway outcome authority',
    refundRoute: false,
    source: GOPAY_SOURCE,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });

/** A 100000 CZK ONLINE_GATEWAY Payment whose COLLECT is proven by one accepted receipt. */
const provenCollection = Effect.fn('EffectIdentity.provenCollection')(function* provenCollection(
  evidence: EvidenceScenario,
  receiptIdentity: { readonly economicEffectKey?: string },
) {
  yield* configureGopay(evidence);
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  const receipt = yield* evidence.accept(
    statement({
      amount: czk(100_000),
      factKind: 'COLLECTION_CONFIRMED',
      operationId: collect.operationId,
      paymentId: payment.paymentId,
      ...receiptIdentity,
    }),
  );
  expect(receipt).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', interpretation: 'TRANSITION' });
  return { collect, payment, receipt };
});

const correct = (
  evidence: EvidenceScenario,
  setup: { readonly collectId: string; readonly paymentId: string; readonly receiptId: string },
  fields: { readonly amount?: ReturnType<typeof czk>; readonly economicEffectKey?: string },
) =>
  evidence.accept(
    statement({
      ...fields,
      correctsObservationId: setup.receiptId,
      factKind: 'SOURCE_CORRECTION',
      operationId: setup.collectId,
      paymentId: setup.paymentId,
    }),
  );

it.live(
  '#1151 partial correction re-issued under the same effect key at a full amount is contradicting, not a silent duplicate',
  () =>
    native(
      Effect.gen(function* sameKeyDifferentAmount() {
        const evidence = yield* scenario();
        const { collect, payment, receipt } = yield* provenCollection(evidence, {
          economicEffectKey: 'gopay:payment:1',
        });
        const setup = {
          collectId: collect.operationId,
          paymentId: payment.paymentId,
          receiptId: receipt.observationId,
        };
        const partial = yield* correct(evidence, setup, {
          amount: czk(40_000),
          economicEffectKey: 'gopay:correction:1',
        });
        expect(partial).toMatchObject({ interpretation: 'CORRECTION' });
        // The same source re-issues the correction under the same effect key but claims the whole receipt.
        const reissued = yield* correct(evidence, setup, {
          amount: czk(100_000),
          economicEffectKey: 'gopay:correction:1',
        });
        expect(reissued).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED', interpretation: 'HOLD' });
        expect(yield* evidence.coverage(payment.paymentId)).toBe('Held UNRESOLVED_EVIDENCE');
      }),
    ),
);

it.live(
  '#1151 keyless receipt then a second keyed charge on the same COLLECT is held, not folded as corroboration',
  () =>
    native(
      Effect.gen(function* keylessThenDistinctCharge() {
        const evidence = yield* scenario();
        const { collect, payment } = yield* provenCollection(evidence, {});
        const second = yield* evidence.accept(
          statement({
            amount: czk(100_000),
            economicEffectKey: 'gopay:payment:2',
            factKind: 'COLLECTION_CONFIRMED',
            operationId: collect.operationId,
            paymentId: payment.paymentId,
          }),
        );
        expect(second).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED', interpretation: 'HOLD' });
        expect(yield* evidence.coverage(payment.paymentId)).toBe('Held UNRESOLVED_EVIDENCE');
      }),
    ),
);

it.live('#1151 keyed receipt then a keyless confirmation of the same amount is not proven to be the same effect', () =>
  native(
    Effect.gen(function* distinctThenKeyless() {
      const evidence = yield* scenario();
      const { collect, payment } = yield* provenCollection(evidence, { economicEffectKey: 'gopay:payment:1' });
      const keyless = yield* evidence.accept(
        statement({
          amount: czk(100_000),
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      // A matching amount alone is insufficient deduplication (#1151).
      expect(keyless).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED', interpretation: 'HOLD' });
      expect(yield* evidence.coverage(payment.paymentId)).toBe('Held UNRESOLVED_EVIDENCE');
      // Governed attachment cannot erase the ambiguity either: the hold stays.
      expect(
        yield* failureCodeOf(
          evidence.decide({
            caseId: keyless.reconciliationCaseId ?? '',
            decision: { _tag: 'ATTACH_EVIDENCE', observationId: keyless.observationId },
            reason: 'Operator attaches the keyless confirmation to the keyed collection',
          }),
        ),
      ).toBe('payment_reconciliation_evidence_not_qualified');
      expect(yield* evidence.coverage(payment.paymentId)).toBe('Held UNRESOLVED_EVIDENCE');
    }),
  ),
);
