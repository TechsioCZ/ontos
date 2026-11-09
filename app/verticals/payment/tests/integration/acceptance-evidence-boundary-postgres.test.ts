import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Option, Schema } from 'effect';
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
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import { IssuePaymentAuthorizationPayloadSchema } from '../../shared/actions/issue-payment-authorization.ts';
import { PaymentAuthorizationValidationRequestSchema } from '../../shared/apis/payment-authorization-validation.ts';
import type { PaymentAuthorizationBinding } from '../../shared/domain/authorization-proof.ts';
import { OutboxPayloadSchema as OutcomeChangedSchema } from '../../shared/outbox/payment-core-operation-outcome-changed-v1.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { issuePaymentAuthorizationAction } from '../../src/actions/issue-payment-authorization.action.ts';
import { paymentAuthorizationValidationRead } from '../../src/api/payment-authorization-validation.read.ts';
import type { PaymentRecord } from '../../src/persistence/payment-aggregate-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeAuthorizationOwnerEvidenceFixture } from '../support/authorization-owner-evidence.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { failureCodeOf, makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  OUTCOME_CHANGED,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1151 evidence scenarios through the actual Payment boundary (#1151 Definition of done: "a direct
 * helper test or alternative test-only receiving factory alone is insufficient"). Every observation
 * enters through the registered `accept-payment-observation` Action and the real Core Action runtime
 * (invocation ledger, Composition revision, owner transaction, RLS, Outbox), after its gateway source
 * authority was configured through the registered `configure-payment-source-authority` Action. Prepaid
 * proofs are issued by `issue-payment-authorization` and judged by the `payment-authorization-validation`
 * Read, never by the pure calculators. The Payment and its operations are the Given state, written with
 * the foundation aggregate primitives (their creating Actions are other lanes' acceptance).
 * Permission and context access are opened: their matrix is the #1153 acceptance suites' subject.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

/** The exact GoPay account binding of `GATEWAY_BINDING` as the provider presents itself. */
const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;
type Statement = typeof AcceptPaymentObservationPayloadSchema.Encoded;

const makeRuntimes = Effect.fn('AcceptanceEvidenceBoundary.makeRuntimes')(function* makeRuntimes(
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
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

/** The exact Order Commitment Attempt binding a prepaid proof is issued and validated for. */
const bindingFor = (payment: PaymentRecord, orderCommitmentTime: DateTime.Utc): PaymentAuthorizationBinding => ({
  amount: payment.amount,
  executionBinding: payment.executionBinding,
  method: payment.method,
  orderCommitmentAttemptId: `attempt-${randomUUID()}`,
  orderCommitmentTime,
  paymentId: payment.paymentId,
  paymentTermRef: payment.paymentTermRef,
  purchaseCorrelationId: payment.purchaseCorrelationId,
});

const boundaryScenario = Effect.fn('AcceptanceEvidenceBoundary.scenario')(function* boundaryScenario() {
  const { admin, runtime } = yield* testDatabaseClients;
  const database: EvidenceNativeDatabase = {
    coreAdmin: yield* makeTestDatabaseFromClient(admin, coreRelations),
    database: yield* makeTestDatabaseFromClient(runtime, coreRelations),
    runtimeClient: runtime,
  };
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  const evidence = evidenceScenarioOf({ native: database, r1, r2, scope });
  const owners = yield* makeAuthorizationOwnerEvidenceFixture;
  const principal = principalOf(scope);

  const configureGatewayAuthority = r1.actions.runAction({
    payload: {
      factFamily: 'GATEWAY_OUTCOME',
      method: 'ONLINE_GATEWAY',
      reason: 'GoPay is the provider System of Record for this account',
      refundRoute: false,
      source: GOPAY_SOURCE,
      status: 'ACTIVE',
      submitterPrincipalIds: [scope.principalId],
    },
    principal,
    registration: configurePaymentSourceAuthorityAction,
    transport: { correlationId: 'payment-boundary-configure', idempotencyKey: randomUUID() },
  });

  const accept = (statement: Statement, runtimes = r1) =>
    runtimes.actions.runAction({
      payload: statement,
      principal,
      registration: acceptPaymentObservationAction,
      transport: { correlationId: 'payment-boundary-accept', idempotencyKey: randomUUID() },
    });

  /** A whole-second frozen business T one second before the actual database time. */
  const frozenT = database.runtimeClient
    .unsafe<{ readonly t: Date }>("select date_trunc('second', clock_timestamp() - interval '1 second') as t")
    .pipe(Effect.map(([row]) => DateTime.fromDateUnsafe(row?.t ?? new Date(0))));

  const issueProof = (binding: PaymentAuthorizationBinding) =>
    Schema.encodeEffect(IssuePaymentAuthorizationPayloadSchema)({
      binding,
      issuanceKey: `issuance-${randomUUID()}`,
      validitySeconds: 300,
    }).pipe(
      Effect.flatMap((payload) =>
        r1.actions.runAction({
          payload,
          principal,
          registration: issuePaymentAuthorizationAction,
          transport: { correlationId: 'payment-boundary-issue', idempotencyKey: randomUUID() },
        }),
      ),
      Effect.provide(owners.layer),
    );

  const validateProof = (authorizationId: string, binding: PaymentAuthorizationBinding) =>
    Schema.encodeEffect(PaymentAuthorizationValidationRequestSchema)({ authorizationId, binding }).pipe(
      Effect.flatMap((input) =>
        r1.reads.runRead({
          input,
          principal,
          registration: paymentAuthorizationValidationRead,
          transport: { correlationId: 'payment-boundary-validate' },
        }),
      ),
      Effect.provide(owners.layer),
    );

  const outcomeChanges = evidence
    .outbox(OUTCOME_CHANGED)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OutcomeChangedSchema))));

  return {
    accept,
    configureGatewayAuthority,
    evidence,
    frozenT,
    issueProof,
    outcomeChanges,
    validateProof,
  };
});
type BoundaryScenario = Effect.Success<ReturnType<typeof boundaryScenario>>;

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' });

/** A 1000 CZK gateway COLLECT confirmed by one provider callback accepted through the Action. */
const confirmedCollection = Effect.fn('AcceptanceEvidenceBoundary.confirmedCollection')(function* confirmed(
  scenario: BoundaryScenario,
) {
  const { evidence } = scenario;
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  const authority = yield* scenario.configureGatewayAuthority;
  const callback = {
    amount: czk(100_000),
    economicEffectKey: `gopay:payment:${collect.operationId}`,
    factFamily: 'GATEWAY_OUTCOME',
    factKind: 'COLLECTION_CONFIRMED',
    operationId: collect.operationId,
    paymentId: payment.paymentId,
    source: GOPAY_SOURCE,
    sourceOccurrenceId: `callback-${randomUUID()}`,
    sourceRevision: 0,
  } satisfies Statement;
  const receipt = yield* scenario.accept(callback);
  expect(receipt).toMatchObject({
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    interpretation: 'TRANSITION',
    outcomeChange: { from: 'PENDING', operationId: collect.operationId, to: 'EFFECT_CONFIRMED' },
    sourceAuthorityId: authority.sourceAuthorityId,
  });
  return { callback, collect, payment, receipt };
});

/** Confirmed collection plus a prepaid proof the validation Read reports as VALID. */
const provenCollection = Effect.fn('AcceptanceEvidenceBoundary.provenCollection')(function* proven(
  scenario: BoundaryScenario,
) {
  const confirmed = yield* confirmedCollection(scenario);
  const binding = bindingFor(confirmed.payment, yield* scenario.frozenT);
  const issued = yield* scenario.issueProof(binding);
  const validation = yield* scenario.validateProof(issued.proof.authorizationId, binding);
  expect(validation.outcome).toBe('VALID');
  return { ...confirmed, authorizationId: issued.proof.authorizationId, binding };
});

it.live(
  '#1151 the accept Action refuses a gateway statement whose exact source binding has no configured authority',
  () =>
    native(
      Effect.gen(function* unconfiguredBindingRefused() {
        const scenario = yield* boundaryScenario();
        const payment = yield* scenario.evidence.createPayment();
        const collect = yield* scenario.evidence.startOperation({
          amountMinor: 100_000,
          operationKey: 'collect-1',
          paymentId: payment.paymentId,
        });
        yield* scenario.configureGatewayAuthority;
        // Same provider account, but a source system the authority was not configured for.
        const refused = yield* failureCodeOf(
          scenario.accept({
            amount: czk(100_000),
            factFamily: 'GATEWAY_OUTCOME',
            factKind: 'COLLECTION_CONFIRMED',
            operationId: collect.operationId,
            paymentId: payment.paymentId,
            source: { ...GOPAY_SOURCE, sourceSystem: 'gopay' },
            sourceOccurrenceId: `callback-${randomUUID()}`,
            sourceRevision: 0,
          }),
        );
        expect(refused).toBe('payment_source_authority_forbidden');
        expect((yield* scenario.evidence.rows.operations(payment.paymentId)).map((row) => row.outcome)).toEqual([
          'PENDING',
        ]);
        expect(yield* scenario.outcomeChanges).toEqual([]);
      }),
    ),
);

it.live(
  '#1151 Duplicate and corroborating observations through the accept Action describe one effect and count once',
  () =>
    native(
      Effect.gen(function* duplicateAndCorroborating() {
        const scenario = yield* boundaryScenario();
        const { callback, collect, payment, receipt } = yield* confirmedCollection(scenario);
        // The exact redelivery of the same occurrence is a DUPLICATE of the recorded decision.
        const redelivered = yield* scenario.accept(callback);
        expect(redelivered).toMatchObject({
          acceptanceOutcome: 'DUPLICATE',
          duplicateOfOutcome: 'ACCEPTED_OBSERVATION',
          interpretation: 'NOT_INTERPRETED',
          observationId: receipt.observationId,
        });
        // Another occurrence of the same economic effect corroborates the outcome and adds no money.
        const corroboration = yield* scenario.accept({
          ...callback,
          sourceOccurrenceId: `lookup-${randomUUID()}`,
        });
        expect(corroboration).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', interpretation: 'NO_CHANGE' });
        expect(corroboration.outcomeChange).toBeUndefined();
        expect((yield* scenario.evidence.rows.transitions(collect.operationId)).map((row) => row.toOutcome)).toEqual([
          'PENDING',
          'EFFECT_CONFIRMED',
        ]);
        expect(yield* scenario.outcomeChanges).toHaveLength(1);
        const history = yield* scenario.evidence.history(payment.paymentId);
        expect(history.observations.map((observation) => observation.observationId)).toEqual([
          receipt.observationId,
          corroboration.observationId,
        ]);
      }),
    ),
);

it.live(
  '#1151 Late refund through the accept Action keeps the collection and the validation Read refuses the stale proof',
  () =>
    native(
      Effect.gen(function* lateRefund() {
        const scenario = yield* boundaryScenario();
        const { authorizationId, binding, collect, payment } = yield* provenCollection(scenario);
        const refund = yield* scenario.evidence.startOperation({
          amountMinor: 40_000,
          kind: 'REFUND',
          operationKey: 'refund-items-1',
          paymentId: payment.paymentId,
          refundBasis: {
            _tag: 'REFUNDABLE_ITEMS',
            items: [{ amountMinor: 40_000, currency: 'CZK', itemRef: 'line-1', sourceEvidenceRef: 'order-line-1' }],
          },
          targetOperationId: collect.operationId,
        });
        const confirmedRefund = yield* scenario.accept({
          amount: czk(40_000),
          economicEffectKey: `gopay:refund:${refund.operationId}`,
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'REFUND_CONFIRMED',
          operationId: refund.operationId,
          paymentId: payment.paymentId,
          source: GOPAY_SOURCE,
          sourceOccurrenceId: `refund-callback-${randomUUID()}`,
          sourceRevision: 0,
        });
        expect(confirmedRefund).toMatchObject({
          acceptanceOutcome: 'ACCEPTED_OBSERVATION',
          interpretation: 'TRANSITION',
          outcomeChange: { from: 'PENDING', operationId: refund.operationId, to: 'EFFECT_CONFIRMED' },
        });
        // The refund is its own effect; the proven collection and its history stay intact.
        expect(
          (yield* scenario.evidence.rows.operations(payment.paymentId)).map((row) => [row.kind, row.outcome]),
        ).toEqual([
          ['COLLECT', 'EFFECT_CONFIRMED'],
          ['REFUND', 'EFFECT_CONFIRMED'],
        ]);
        expect((yield* scenario.evidence.rows.transitions(collect.operationId)).map((row) => row.toOutcome)).toEqual([
          'PENDING',
          'EFFECT_CONFIRMED',
        ]);
        // The proof issued against the full coverage is no longer Current.
        const validation = yield* scenario.validateProof(authorizationId, binding);
        expect(validation.outcome).toBe('NOT_VALID');
        expect(validation.reasons).toContain('COVERAGE_REVISION_CHANGED');
      }),
    ),
);

it.live(
  '#1151 A source corrects a statement through the accept Action: the collection reopens to CONFLICT, history keeps the original, the proof dies',
  () =>
    native(
      Effect.gen(function* sourceCorrection() {
        const scenario = yield* boundaryScenario();
        const { authorizationId, binding, collect, payment, receipt } = yield* provenCollection(scenario);
        const [receiptBefore] = yield* scenario.evidence.rows.observation(receipt.observationId);
        const correction = yield* scenario.accept({
          correctsObservationId: receipt.observationId,
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'SOURCE_CORRECTION',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
          source: GOPAY_SOURCE,
          sourceOccurrenceId: `correction-${randomUUID()}`,
          sourceRevision: 0,
        });
        expect(correction).toMatchObject({
          acceptanceOutcome: 'ACCEPTED_OBSERVATION',
          interpretation: 'CORRECTION',
          outcomeChange: { from: 'EFFECT_CONFIRMED', operationId: collect.operationId, to: 'CONFLICT' },
        });
        expect(correction.reconciliationCaseId).toBeDefined();
        // The original statement and its acceptance audit are immutable; no reversal money was invented.
        const [receiptAfter] = yield* scenario.evidence.rows.observation(receipt.observationId);
        expect(receiptAfter).toEqual(receiptBefore);
        expect(
          (yield* scenario.evidence.rows.operations(payment.paymentId)).map((row) => [row.kind, row.outcome]),
        ).toEqual([['COLLECT', 'CONFLICT']]);
        const validation = yield* scenario.validateProof(authorizationId, binding);
        expect(validation.outcome).toBe('NOT_VALID');
        // The explicit historical projection keeps the statement and its correction lineage.
        const history = yield* scenario.evidence.history(payment.paymentId);
        expect(
          history.observations.map((observation) => [
            observation.observationId,
            observation.factKind,
            Option.getOrUndefined(observation.correctsObservationId),
          ]),
        ).toEqual([
          [receipt.observationId, 'COLLECTION_CONFIRMED', undefined],
          [correction.observationId, 'SOURCE_CORRECTION', receipt.observationId],
        ]);
        expect(history.transitions.map((transition) => transition.toOutcome)).toEqual([
          'PENDING',
          'EFFECT_CONFIRMED',
          'CONFLICT',
        ]);
        const debt = yield* scenario.evidence.debt({ paymentId: payment.paymentId });
        expect(debt.openCases.map((open) => open.caseId)).toEqual([correction.reconciliationCaseId]);
      }),
    ),
);

it.live(
  '#1151 a partial source correction through the accept Action reduces Current coverage without a refund operation',
  () =>
    native(
      Effect.gen(function* partialCorrection() {
        const scenario = yield* boundaryScenario();
        const { authorizationId, binding, collect, payment, receipt } = yield* provenCollection(scenario);
        const correction = yield* scenario.accept({
          amount: czk(30_000),
          correctsObservationId: receipt.observationId,
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'SOURCE_CORRECTION',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
          source: GOPAY_SOURCE,
          sourceOccurrenceId: `partial-correction-${randomUUID()}`,
          sourceRevision: 0,
        });
        expect(correction).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', interpretation: 'CORRECTION' });
        expect(correction.outcomeChange).toBeUndefined();
        const [recorded] = yield* scenario.evidence.rows.observation(correction.observationId);
        expect(recorded).toMatchObject({ amountMinor: 30_000, correctionEffect: 'REDUCE_ESTABLISHED_COLLECTION' });
        // The collection stays proven, no refund is fabricated, and the full-coverage proof is not Current.
        expect(
          (yield* scenario.evidence.rows.operations(payment.paymentId)).map((row) => [row.kind, row.outcome]),
        ).toEqual([['COLLECT', 'EFFECT_CONFIRMED']]);
        const validation = yield* scenario.validateProof(authorizationId, binding);
        expect(validation.outcome).toBe('NOT_VALID');
        expect(validation.reasons).toContain('COVERAGE_REVISION_CHANGED');
      }),
    ),
);

it.live(
  '#1151 Late gateway callback through the accept Action under R2 resolves the original R1 operation and records R2 separately',
  () =>
    native(
      Effect.gen(function* lateCallbackUnderR2() {
        // The unknown effect arises under the compatible R2, so R2 is the release that tracks it.
        yield* installPaymentTestCompositionAuthority(COMPOSITION_R2);
        const scenario = yield* boundaryScenario();
        const { evidence } = scenario;
        const payment = yield* evidence.createPayment();
        const collect = yield* evidence.startOperation({
          amountMinor: 100_000,
          operationKey: 'collect-r1',
          paymentId: payment.paymentId,
        });
        expect(collect.provenance.compositionRevision).toBe(COMPOSITION_R1);
        // The create response was lost under R1; R2 records the recovery of the same operation.
        const recovered = yield* evidence.recover(
          {
            operationId: collect.operationId,
            paymentId: payment.paymentId,
            reason: 'The provider create response was lost in transport',
            trigger: 'EXECUTION_OUTCOME_UNKNOWN',
          },
          { runtimes: evidence.r2 },
        );
        expect(recovered).toMatchObject({
          operationOutcome: 'INDETERMINATE',
          originalCompositionRevision: COMPOSITION_R1,
        });
        yield* scenario.configureGatewayAuthority;
        // The provider's late callback is a new, normally authorized invocation under R2.
        const callback = yield* scenario.accept(
          {
            amount: czk(100_000),
            economicEffectKey: `gopay:payment:${collect.operationId}`,
            factFamily: 'GATEWAY_OUTCOME',
            factKind: 'COLLECTION_CONFIRMED',
            operationId: collect.operationId,
            paymentId: payment.paymentId,
            source: GOPAY_SOURCE,
            sourceOccurrenceId: `late-callback-${randomUUID()}`,
            sourceRevision: 0,
          },
          evidence.r2,
        );
        expect(callback).toMatchObject({
          acceptanceOutcome: 'ACCEPTED_OBSERVATION',
          interpretation: 'TRANSITION',
          operationId: collect.operationId,
          outcomeChange: { from: 'INDETERMINATE', operationId: collect.operationId, to: 'EFFECT_CONFIRMED' },
        });
        // O and its lineage stay R1; each later invocation records its own R2 authority.
        const operations = yield* evidence.rows.operations(payment.paymentId);
        expect(operations.map((row) => [row.operationId, row.compositionRevision, row.outcome])).toEqual([
          [collect.operationId, COMPOSITION_R1, 'EFFECT_CONFIRMED'],
        ]);
        expect(
          (yield* evidence.rows.transitions(collect.operationId)).map((row) => [
            row.toOutcome,
            row.causeKind,
            row.compositionRevision,
          ]),
        ).toEqual([
          ['PENDING', 'CREATION', COMPOSITION_R1],
          ['INDETERMINATE', 'RECOVERY', COMPOSITION_R2],
          ['EFFECT_CONFIRMED', 'OBSERVATION', COMPOSITION_R2],
        ]);
        const [observation] = yield* evidence.rows.observation(callback.observationId);
        expect(observation).toMatchObject({ compositionRevision: COMPOSITION_R2, operationId: collect.operationId });
        const [changed] = yield* scenario.outcomeChanges;
        expect(changed).toMatchObject({
          cause: { _tag: 'OBSERVATION', observationId: callback.observationId },
          fromOutcome: 'INDETERMINATE',
          operationId: collect.operationId,
          originalCompositionRevision: COMPOSITION_R1,
          provenance: { compositionRevision: COMPOSITION_R2 },
          toOutcome: 'EFFECT_CONFIRMED',
        });
      }),
    ),
);
