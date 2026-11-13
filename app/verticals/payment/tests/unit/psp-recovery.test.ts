import { readFileSync } from 'node:fs';

import type { ScopedRoutineInvoker } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { DateTime, Effect, Exit, Layer, Option, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import type {
  PaymentGatewayProviderFamilySchema,
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentRecoveryMode,
} from '../../shared/domain/payment-vocabulary.ts';
import type { OutboxPayload as RecoveryRequested } from '../../shared/outbox/payment-core-operation-recovery-requested-v1.ts';
import { GatewayBindingResolver } from '../../src/integrations/psp/binding-resolver.ts';
import type { GatewayExecutionTargetQuery } from '../../src/integrations/psp/binding-resolver.ts';
import { GATEWAY_LAUNCH_CAPABILITIES } from '../../src/integrations/psp/capability-matrix.ts';
import {
  idempotencyKeyHashOf,
  ProviderDispatchLedger,
  ProviderDispatchRecordSchema,
  replayRequestOf,
} from '../../src/integrations/psp/dispatch-ledger.ts';
import type { ProviderDispatchRecord } from '../../src/integrations/psp/dispatch-ledger.ts';
import { ProviderEvidenceStore, StoredProviderEvidenceSchema } from '../../src/integrations/psp/evidence-store.ts';
import type {
  AppendProviderEvidenceInput,
  ProviderEvidenceSubmissionOutcome,
  StoredProviderEvidence,
} from '../../src/integrations/psp/evidence-store.ts';
import { ProviderEvidenceSubmitter } from '../../src/integrations/psp/evidence-submission.ts';
import {
  recoverGatewayOperationInScope,
  retainedReplayGuaranteeOf,
} from '../../src/integrations/psp/gateway-operation-recovery.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import {
  GatewayEvidenceConflict,
  GatewayProviderOutcomeUnknown,
  GatewayProviderResponseInvalid,
  GatewayProviderUnavailable,
  GatewayProviderUnsupported,
} from '../../src/integrations/psp/psp-errors.ts';
import type {
  GatewayEvidenceConflictError,
  GatewayLedgerUnavailableError,
  GatewayProviderOutcomeUnknownError,
  GatewayProviderResponseInvalidError,
  GatewayProviderUnavailableError,
  GatewayProviderUnsupportedError,
} from '../../src/integrations/psp/psp-errors.ts';
import { GatewayExecutionTargetSchema } from '../../src/integrations/psp/psp-request.ts';
import type { GatewayExpectedEffect, GatewayLookupRequest } from '../../src/integrations/psp/psp-request.ts';
import { ProviderFindingResultSchema } from '../../src/integrations/psp/psp-result.ts';
import type {
  ProviderDispatchResponse,
  ProviderFindingResult,
  ProviderReplayRequest,
} from '../../src/integrations/psp/psp-result.ts';
import { credentialConfig, recordedGatewayAdapters, respond } from '../support/psp-conformance-provider.fixture.ts';

/**
 * #1157 #1158 recovery of one gateway operation over scripted ports: mode at dispatch, exact Stripe replay,
 * lookup through the original binding, evidence append and the governed A8 submission. The live routines are
 * proven in `psp-recovery-postgres.test.ts`.
 */

type Family = typeof PaymentGatewayProviderFamilySchema.Type;
type Kind = PaymentOperationKind;
type LookupFailure =
  | GatewayProviderResponseInvalidError
  | GatewayProviderUnavailableError
  | GatewayProviderUnsupportedError;
type ReplayFailure =
  | GatewayProviderOutcomeUnknownError
  | GatewayProviderUnavailableError
  | GatewayProviderUnsupportedError;

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const otherBindingId = '44444444-4444-4444-8444-444444444444';
const paymentId = '55555555-5555-4555-8555-555555555555';
const operationId = '66666666-6666-4666-8666-666666666666';
const cancelId = '77777777-7777-4777-8777-777777777777';
const invocationId = '88888888-8888-4888-8888-888888888888';
const accountRef = `pab_${'a'.repeat(32)}`;
const materialHash = 'a'.repeat(64);
const revision = 'c'.repeat(64);
const PREPARED_AT = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
const preparedMs = DateTime.toEpochMillis(PREPARED_AT);
const HOUR_MS = 3_600_000;
const WINDOW_MS = 24 * HOUR_MS;
const AMOUNT = { amountMinor: 100_000, currency: 'CZK' } as const;

const bindingOf = (family: Family, environment: 'LIVE' | 'SANDBOX' = 'SANDBOX') =>
  ({
    _tag: 'GATEWAY_ACCOUNT',
    environment,
    providerAccountRef: accountRef,
    providerFamily: family,
  }) as const;

const scope: OutboxWorkerLegalEntityScope = {
  completionPublisher: { publish: () => Effect.die('recovery publishes no completion') },
  legalEntityId,
  routineInvoker: { invoke: () => Effect.die('replaced per test') },
  tenantId,
};

const workerContext: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: invocationId,
  compositionRevision: revision,
  deliveryId: invocationId,
  domainEventId: invocationId,
  messageId: invocationId,
  originatorInvocationId: invocationId,
  producerModuleKey: 'payment.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'payment.core.operation-recovery-requested.v1',
  workerKey: 'payment.core.recover-gateway-operation',
};

interface OperationOverrides {
  readonly family?: Family;
  readonly kind?: Kind;
  readonly operationId?: string;
  readonly outcome?: PaymentOperationOutcome;
  readonly targetOperationId?: string;
}

/** The encoded `psp_read_operation_for_execution` document of one C16 operation. */
const operationRow = (overrides: OperationOverrides = {}) => {
  const row = {
    amountMinor: overrides.kind === 'CANCEL_OR_VOID' ? 0 : AMOUNT.amountMinor,
    binding: bindingOf(overrides.family ?? 'STRIPE'),
    cancelDispatchExists: false,
    cancelOperationExists: false,
    createdAt: '2020-01-01T00:00:00.000Z',
    currency: 'CZK',
    customerConfigurationId: 'customer-configuration-1',
    kind: overrides.kind ?? 'COLLECT',
    materialHash,
    operationId: overrides.operationId ?? operationId,
    outcome: overrides.outcome ?? 'INDETERMINATE',
    paymentId,
    provenance: { actionInvocationId: invocationId, actorPrincipalId: invocationId, compositionRevision: revision },
  };
  return overrides.targetOperationId === undefined
    ? row
    : Object.assign(row, { targetOperationId: overrides.targetOperationId });
};
type OperationRow = ReturnType<typeof operationRow>;

interface RecordOverrides {
  readonly family?: Family;
  readonly kind?: Kind;
  readonly operationId?: string;
  readonly paymentRef?: Option.Option<unknown>;
  readonly preparedAt?: Option.Option<DateTime.Utc>;
  readonly refundBaseline?: Option.Option<unknown>;
  readonly state?: ProviderDispatchRecord['state'];
}

/** A dispatch row; Stripe rows carry their exact replayable request and window. */
const dispatchRecord = (overrides: RecordOverrides = {}): ProviderDispatchRecord => {
  const family = overrides.family ?? 'STRIPE';
  const id = overrides.operationId ?? operationId;
  const { idempotencyKey, orderReference } = deriveProviderCorrelation(
    Schema.decodeUnknownSync(ProviderDispatchRecordSchema.fields.operationId)(id),
  );
  const stripe = family === 'STRIPE';
  const replayable = <Value>(value: Value) => (stripe ? Option.some(value) : Option.none());
  return Schema.decodeUnknownSync(ProviderDispatchRecordSchema)({
    bindingId,
    credentialRevision: 1,
    customerRedirectUrl: Option.none(),
    endpointRef: Option.some(stripe ? 'stripe:POST:/v1/checkout/sessions' : `${family.toLowerCase()}:payment-create`),
    environment: 'SANDBOX',
    idempotencyKeyHash: replayable(idempotencyKeyHashOf(idempotencyKey)),
    materialHash,
    notSentReason: Option.none(),
    operationId: id,
    operationKind: overrides.kind ?? 'COLLECT',
    orderReference,
    paymentId,
    preparedAt: overrides.preparedAt ?? Option.some(PREPARED_AT),
    providerAccountRef: accountRef,
    providerFamily: family,
    providerPaymentRef: overrides.paymentRef ?? Option.none(),
    providerRefundRef: Option.none(),
    refundBaseline: overrides.refundBaseline ?? Option.none(),
    replayExpiresAt: replayable(DateTime.add(PREPARED_AT, { milliseconds: WINDOW_MS })),
    replayStartsAt: replayable(PREPARED_AT),
    requestBody: replayable(new TextEncoder().encode(`operation=${id}`)),
    requestHash: Option.some('b'.repeat(64)),
    requestHeaders: replayable([{ name: 'idempotency-key', value: idempotencyKey }]),
    respondedAt: Option.none(),
    returnToken: Option.none(),
    state: overrides.state ?? 'OUTCOME_UNKNOWN',
    targetOperationId: Option.none(),
  });
};

const recoveryMessage = (
  mode: PaymentRecoveryMode,
  overrides: { readonly family?: Family; readonly record?: ProviderDispatchRecord } = {},
): RecoveryRequested => {
  const guarantee =
    overrides.record === undefined
      ? undefined
      : Option.getOrUndefined(retainedReplayGuaranteeOf(overrides.record, { legalEntityId, tenantId }));
  const message: RecoveryRequested = {
    amount: AMOUNT,
    binding: bindingOf(overrides.family ?? 'STRIPE'),
    materialHash,
    mode,
    operationId,
    operationKey: 'collect-1',
    operationKind: 'COLLECT',
    operationOutcome: 'INDETERMINATE',
    originalActionInvocationId: invocationId,
    originalCompositionRevision: revision,
    paymentId,
    provenance: { actionInvocationId: invocationId, actorPrincipalId: invocationId, compositionRevision: revision },
    recoveryId: invocationId,
  };
  return guarantee === undefined ? message : { ...message, providerReplayGuarantee: guarantee };
};

const executionTarget = (family: Family, id = bindingId) =>
  Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
    binding: bindingOf(family),
    bindingId: id,
    credentialRevision: 2,
    credentialSecretRef: 'sandbox-credential-2',
    legalEntityId,
    merchantIdentity:
      family === 'STRIPE' ? { _tag: 'STRIPE', accountId: 'acct_1TestAccount' } : { _tag: 'GOPAY', goid: '8123456789' },
    notificationUrl: 'https://hooks.example.test/psp',
    returnUrl: Option.none(),
    tenantId,
  });

interface FindingInput {
  readonly factKind?: string;
  readonly finding: ProviderFindingResult['finding'];
  readonly kind?: Kind;
  readonly operationId?: string;
  readonly refs?: readonly unknown[];
  readonly withOrderReference?: boolean;
}

const findingOf = (input: FindingInput): ProviderFindingResult => {
  const target = input.operationId ?? operationId;
  const refs = input.refs ?? [{ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_recovered' }];
  const factKind = input.factKind ?? 'COLLECTION_CONFIRMED';
  return Schema.decodeUnknownSync(ProviderFindingResultSchema)({
    customerAction: Option.none(),
    evidence:
      input.finding === 'INDETERMINATE'
        ? Option.none()
        : Option.some({
            discrepancy: Option.none(),
            economicEffectKey: Option.some('pi_test_recovered'),
            factFamily: 'GATEWAY_OUTCOME',
            factKind,
            observedAmount: Option.some(AMOUNT),
            observedAt: DateTime.add(PREPARED_AT, { hours: 25 }),
            providerOccurredAt: Option.none(),
            providerRefs: refs,
            reason: Option.none(),
            sourceOccurrenceId: `stripe:RECOVERY_LOOKUP:pi_test_recovered:${target}:${factKind}:100000`,
            sourceRevision: 0,
          }),
    finding: input.finding,
    orderReference:
      input.withOrderReference === true
        ? Option.some(
            deriveProviderCorrelation(Schema.decodeUnknownSync(ProviderDispatchRecordSchema.fields.operationId)(target))
              .orderReference,
          )
        : Option.none(),
    providerRefs: refs,
    target: { operationId: target, operationKind: input.kind ?? 'COLLECT' },
  });
};

const storedPending = (id: string, occurrence: string, forOperation = operationId): StoredProviderEvidence =>
  Schema.decodeUnknownSync(StoredProviderEvidenceSchema)({
    bindingId,
    evidence: {
      ...findingOf({ finding: 'EFFECT_CONFIRMED', operationId: forOperation }).evidence.pipe(Option.getOrThrow),
      sourceOccurrenceId: occurrence,
    },
    evidenceId: id,
    notificationId: Option.none(),
    operationId: forOperation,
    origin: 'DISPATCH_RESPONSE',
    paymentId,
    receivedAt: PREPARED_AT,
    recordedAt: PREPARED_AT,
    submissionState: 'PENDING_SUBMISSION',
    verifiedAt: PREPARED_AT,
  });

interface Script {
  /** The production adapters over a recorded provider (`recordedGatewayAdapters`) instead of the scripted lookup. */
  readonly adapters?: typeof GatewayProviderAdapters.Service;
  readonly appendConflicts?: ReadonlySet<string>;
  readonly lookup?: (request: GatewayLookupRequest) => Effect.Effect<readonly ProviderFindingResult[], LookupFailure>;
  readonly operations: readonly OperationRow[];
  readonly pending?: readonly StoredProviderEvidence[];
  readonly record: Option.Option<ProviderDispatchRecord>;
  readonly replay?: (
    request: ProviderReplayRequest,
    expected: GatewayExpectedEffect,
  ) => Effect.Effect<ProviderDispatchResponse, ReplayFailure>;
  readonly resolve?: (
    query: GatewayExecutionTargetQuery,
  ) => Effect.Effect<ReturnType<typeof executionTarget>, GatewayProviderUnavailableError>;
  readonly submit?: (
    evidence: StoredProviderEvidence,
  ) => ProviderEvidenceSubmissionOutcome | GatewayProviderUnavailableError;
}

interface Calls {
  readonly appended: AppendProviderEvidenceInput[];
  readonly expected: GatewayExpectedEffect[];
  readonly ledger: string[];
  readonly lookups: GatewayLookupRequest[];
  readonly marked: { readonly evidenceId: string; readonly outcome: string }[];
  readonly replays: ProviderReplayRequest[];
  readonly resolved: GatewayExecutionTargetQuery[];
  readonly submitted: string[];
}

const unused = () => Effect.die('not used by recovery');

const unavailable = (family: Family, reason: string) =>
  new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason });

/** Scripted ports around `recoverGatewayOperationInScope`; every interaction is recorded. */
const recoverWith = (script: Script, message: RecoveryRequested) => {
  const calls: Calls = {
    appended: [],
    expected: [],
    ledger: [],
    lookups: [],
    marked: [],
    replays: [],
    resolved: [],
    submitted: [],
  };
  const rows: StoredProviderEvidence[] = [...(script.pending ?? [])];
  let sequence = 0;
  const routineInvoker: ScopedRoutineInvoker = {
    invoke: (routine, args) =>
      Effect.sync(() =>
        Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(
          script.operations.filter((row) => row.operationId === args[0]).map((row) => ({ result: row })),
        ),
      ),
  };
  const recordOf = () => Option.getOrThrow(script.record);
  const ledger = Layer.succeed(ProviderDispatchLedger, {
    correlateUnknown: (input) =>
      Effect.sync(() => {
        calls.ledger.push(`correlateUnknown:${input.providerRef._tag}`);
        return Option.some({ ...recordOf(), state: 'ACKNOWLEDGED' as const });
      }),
    hasUnresolvedRefund: unused,
    prepare: unused,
    readByOperation: () => Effect.succeed(script.record),
    readByOrderReference: unused,
    readByProviderRef: unused,
    recordAcknowledged: (input) =>
      Effect.sync(() => {
        calls.ledger.push(
          `recordAcknowledged:${Option.getOrElse(
            input.providerPaymentRef.pipe(Option.map((ref) => ref._tag)),
            () => 'none',
          )}`,
        );
        return { ...recordOf(), state: 'ACKNOWLEDGED' as const };
      }),
    recordNotSent: unused,
    recordOutcomeUnknown: () =>
      Effect.sync(() => {
        calls.ledger.push('recordOutcomeUnknown');
        return { ...recordOf(), state: 'OUTCOME_UNKNOWN' as const };
      }),
    recordRejected: () =>
      Effect.sync(() => {
        calls.ledger.push('recordRejected');
        return { ...recordOf(), state: 'REJECTED_BEFORE_EFFECT' as const };
      }),
    recordTargetUnresolved: unused,
    recordUnsupported: unused,
    registerCancel: unused,
  });
  const store = Layer.succeed(ProviderEvidenceStore, {
    append: (input) =>
      Effect.suspend(
        (): Effect.Effect<StoredProviderEvidence, GatewayEvidenceConflictError | GatewayLedgerUnavailableError> => {
          calls.appended.push(input);
          if (script.appendConflicts?.has(input.evidence.sourceOccurrenceId) === true) {
            return Effect.fail(
              new GatewayEvidenceConflict({ code: 'gateway_evidence_conflict', reason: 'occurrence_mismatch' }),
            );
          }
          sequence += 1;
          const stored = Schema.decodeUnknownSync(StoredProviderEvidenceSchema)({
            bindingId: input.bindingId,
            evidence: input.evidence,
            evidenceId: `99999999-9999-4999-8999-${String(sequence).padStart(12, '0')}`,
            notificationId: input.notificationId,
            operationId: input.operationId,
            origin: input.origin,
            paymentId: input.paymentId,
            receivedAt: input.evidence.observedAt,
            recordedAt: input.evidence.observedAt,
            submissionState: 'PENDING_SUBMISSION',
            verifiedAt: input.evidence.observedAt,
          });
          rows.push(stored);
          return Effect.succeed(stored);
        },
      ),
    listPending: (input) =>
      Effect.sync(() =>
        rows.filter((row) => row.operationId === input.operationId && row.submissionState === 'PENDING_SUBMISSION'),
      ),
    markSubmission: (input) =>
      Effect.sync(() => {
        calls.marked.push({ evidenceId: input.evidenceId, outcome: input.outcome });
        const index = rows.findIndex((row) => row.evidenceId === input.evidenceId);
        const updated = { ...Option.getOrThrow(Option.fromUndefinedOr(rows[index])), submissionState: input.outcome };
        rows[index] = updated;
        return updated;
      }),
    pinSubmissionExecutor: () => Effect.die('The recovery fixture submits through a scripted submitter'),
  });
  const submitter = Layer.succeed(ProviderEvidenceSubmitter, {
    submit: (submission) =>
      Effect.suspend(() => {
        calls.submitted.push(submission.evidence.evidenceId);
        const answer = script.submit?.(submission.evidence) ?? 'ACCEPTED';
        return Predicate.isTagged(answer, 'GatewayProviderUnavailable')
          ? Effect.fail(answer)
          : Effect.succeed({ observationId: Option.none(), outcome: answer });
      }),
  });
  const resolver = Layer.succeed(GatewayBindingResolver, {
    resolveExecutionTarget: (query) =>
      Effect.suspend(() => {
        calls.resolved.push(query);
        return script.resolve?.(query) ?? Effect.succeed(executionTarget(query.providerFamily));
      }),
    resolveForNotification: unused,
  });
  const adapters = Layer.succeed(
    GatewayProviderAdapters,
    script.adapters ?? {
      forFamily: (family) =>
        Effect.succeed({
          capabilities: GATEWAY_LAUNCH_CAPABILITIES[family],
          family,
          lookup: (_target, request) =>
            Effect.suspend(() => {
              calls.lookups.push(request);
              calls.expected.push(request.expected);
              return script.lookup?.(request) ?? Effect.succeed([]);
            }),
          prepareCancel: unused,
          prepareCollect: unused,
          prepareRefund: unused,
          readOrderReference: unused,
          replay: (_target, request, expected) =>
            Effect.suspend(() => {
              calls.replays.push(request);
              calls.expected.push(expected);
              return script.replay?.(request, expected) ?? Effect.die('no replay scripted');
            }),
          send: unused,
          verifyNotification: unused,
        }),
    },
  );
  return recoverGatewayOperationInScope(message, { ...scope, routineInvoker }, workerContext).pipe(
    Effect.provide(Layer.mergeAll(ledger, store, submitter, resolver, adapters)),
    Effect.exit,
    Effect.map((exit) => ({ calls, exit, rows })),
  );
};

const reportOf = <Value, Failure>(exit: Exit.Exit<Option.Option<Value>, Failure>) =>
  Option.getOrThrow(Exit.isSuccess(exit) ? exit.value : Option.none());

/** `<tag>:<reason>` of a typed failure, so a retryable outage and its reason are asserted together. */
const failureOf = <Value>(
  exit: Exit.Exit<Value, { readonly _tag: string; readonly reason?: string | undefined }>,
): string | undefined =>
  Option.getOrUndefined(
    Exit.findErrorOption(exit).pipe(Option.map((failure) => `${failure._tag}:${failure.reason ?? ''}`)),
  );

const at = (offsetMs: number) => TestClock.setTime(preparedMs + offsetMs);

const COMGATE_RECOVERY_SECRET_REF = 'comgate.recovery';
const COMGATE_MERCHANT_ID = '123456';
const COMGATE_STATEMENT_API = 'https://payments.comgate.cz/v2.0';
/** The official monthly sample's refund row (fixtures/comgate/README.md) for `orderReference`, 1 000,00 CZK debited. */
const comgateStatementRow = (orderReference: string) => ({
  ...Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    readFileSync(new URL('../fixtures/comgate/statement-refund-row.json', import.meta.url), 'utf-8'),
  ),
  'ID od klienta': orderReference,
  Merchant: COMGATE_MERCHANT_ID,
  'Potvrzená částka': '-1000,00',
});

describe('#1158 gateway operation recovery', () => {
  it.effect('#1158 A lost Stripe response is looked up by order reference after the window and submitted', () =>
    Effect.gen(function* lostStripeResponse() {
      yield* at(25 * HOUR_MS);
      const record = dispatchRecord();
      const { calls, exit, rows } = yield* recoverWith(
        {
          lookup: () => Effect.succeed([findingOf({ finding: 'EFFECT_CONFIRMED', withOrderReference: true })]),
          operations: [operationRow()],
          record: Option.some(record),
        },
        recoveryMessage('AUTHORITATIVE_LOOKUP'),
      );
      const report = reportOf(exit);
      expect([report.mode, report.providerCall, Option.getOrNull(report.indeterminate)]).toEqual([
        'AUTHORITATIVE_LOOKUP',
        'LOOKUP_ORDER_REFERENCE',
        null,
      ]);
      expect(calls.lookups.map(({ dispatchedAt, target }) => [target, Option.getOrNull(dispatchedAt)])).toEqual([
        [{ _tag: 'ORDER_REFERENCE', orderReference: record.orderReference }, PREPARED_AT],
      ]);
      // The provider ref found by the search is correlated before the evidence is appended.
      expect(calls.ledger).toEqual(['correlateUnknown:STRIPE_PAYMENT_INTENT']);
      expect(calls.appended.map(({ bindingId: id, notificationId, origin }) => [id, origin, notificationId])).toEqual([
        [bindingId, 'RECOVERY_LOOKUP', Option.none()],
      ]);
      expect(calls.marked).toEqual([{ evidenceId: rows[0]?.evidenceId, outcome: 'ACCEPTED' }]);
      // The original binding is resolved with its current credential; tenant and LE come from the scope.
      expect(
        calls.resolved.map(({ customerConfigurationId, environment, providerAccountRef, providerFamily }) => [
          Option.isNone(customerConfigurationId),
          environment,
          providerAccountRef,
          providerFamily,
        ]),
      ).toEqual([[true, 'SANDBOX', accountRef, 'STRIPE']]);
    }),
  );

  it.effect('#1158 Inside the window the exact retained Stripe request is replayed and recorded', () =>
    Effect.gen(function* exactReplay() {
      yield* at(HOUR_MS);
      const record = dispatchRecord();
      const { calls, exit } = yield* recoverWith(
        {
          operations: [operationRow()],
          record: Option.some(record),
          replay: () =>
            Effect.succeed({
              _tag: 'ACKNOWLEDGED' as const,
              finding: findingOf({ finding: 'EFFECT_CONFIRMED' }),
              targetFinding: Option.none(),
            }),
        },
        recoveryMessage('PROVIDER_IDEMPOTENT_REPLAY', { record }),
      );
      const report = reportOf(exit);
      expect([report.mode, report.providerCall]).toEqual(['PROVIDER_IDEMPOTENT_REPLAY', 'REPLAY']);
      expect(calls.replays).toEqual([Option.getOrThrow(replayRequestOf(record))]);
      expect(calls.lookups).toEqual([]);
      expect(calls.ledger).toEqual(['recordAcknowledged:STRIPE_PAYMENT_INTENT']);
      expect(calls.appended.map(({ origin }) => origin)).toEqual(['RECOVERY_REPLAY']);
    }),
  );

  it.effect('#1158 A lost replay response records OUTCOME_UNKNOWN and fails retryably', () =>
    Effect.gen(function* lostReplay() {
      yield* at(HOUR_MS);
      const record = dispatchRecord({ state: 'PREPARED' });
      const { calls, exit } = yield* recoverWith(
        {
          operations: [operationRow()],
          record: Option.some(record),
          replay: () =>
            Effect.fail(
              new GatewayProviderOutcomeUnknown({
                code: 'gateway_provider_outcome_unknown',
                family: 'STRIPE',
                operationId: record.operationId,
                reason: 'timeout',
              }),
            ),
        },
        recoveryMessage('PROVIDER_IDEMPOTENT_REPLAY', { record }),
      );
      expect(failureOf(exit)).toBe('GatewayProviderOutcomeUnknown:timeout');
      expect(calls.ledger).toEqual(['recordOutcomeUnknown']);
      expect(calls.submitted).toEqual([]);
    }),
  );

  it.effect('#1158 GoPay without a provider ref stays INDETERMINATE and the provider is not asked', () =>
    Effect.gen(function* gopayWithoutRef() {
      yield* at(25 * HOUR_MS);
      const { calls, exit } = yield* recoverWith(
        {
          operations: [operationRow({ family: 'GOPAY' })],
          record: Option.some(dispatchRecord({ family: 'GOPAY' })),
        },
        recoveryMessage('AUTHORITATIVE_LOOKUP', { family: 'GOPAY' }),
      );
      const report = reportOf(exit);
      expect([report.providerCall, Option.getOrNull(report.indeterminate)]).toEqual([
        'NONE',
        'lookup_not_possible_without_provider_ref',
      ]);
      expect([calls.lookups, calls.appended, calls.ledger]).toEqual([[], [], []]);
    }),
  );

  it.effect('#1158 A lost GoPay refund is resolved only by a lookup through its payment, never resent', () =>
    Effect.gen(function* gopayRefundLookup() {
      yield* at(25 * HOUR_MS);
      const paymentRef = { _tag: 'GOPAY_PAYMENT', id: '3000006529' } as const;
      const refundBaseline = Option.some({ rowIds: ['4493293835'] });
      const recover = (state: ProviderDispatchRecord['state']) =>
        recoverWith(
          {
            lookup: () => Effect.succeed([findingOf({ finding: 'INDETERMINATE', kind: 'REFUND' })]),
            operations: [operationRow({ family: 'GOPAY', kind: 'REFUND' })],
            record: Option.some(
              dispatchRecord({
                family: 'GOPAY',
                kind: 'REFUND',
                paymentRef: Option.some(paymentRef),
                refundBaseline,
                state,
              }),
            ),
          },
          { ...recoveryMessage('AUTHORITATIVE_LOOKUP', { family: 'GOPAY' }), operationKind: 'REFUND' },
        );
      // GoPay refunds have no id of their own: the payment's refund history is read through the payment. A lost
      // response gets no baseline, so the history can never confirm it (#1158: no proof for this operation).
      const lost = yield* recover('OUTCOME_UNKNOWN');
      expect(
        lost.calls.lookups.map(({ acknowledgedRefundBaseline, target }) => [target, acknowledgedRefundBaseline]),
      ).toEqual([[{ _tag: 'PROVIDER_OBJECT', ref: paymentRef }, Option.none()]]);
      expect(reportOf(lost.exit).providerCall).toBe('LOOKUP_PROVIDER_OBJECT');
      expect(lost.calls.replays).toEqual([]);
      expect(lost.calls.resolved.map(({ providerFamily }) => providerFamily)).toEqual(['GOPAY']);
      // A refund GoPay acknowledged is attributed against the baseline committed before its send.
      const acknowledged = yield* recover('ACKNOWLEDGED');
      expect(acknowledged.calls.lookups.map(({ acknowledgedRefundBaseline }) => acknowledgedRefundBaseline)).toEqual([
        refundBaseline,
      ]);
      expect(acknowledged.calls.replays).toEqual([]);
    }),
  );

  it.effect(
    '#1158 A lost GoPay or Comgate refund proven to exist is correlated; an unproven one stays OUTCOME_UNKNOWN',
    () =>
      Effect.gen(function* lostRefundCorrelation() {
        yield* at(25 * HOUR_MS);
        const gopayPayment = { _tag: 'GOPAY_PAYMENT', id: '3000006529' } as const;
        const comgateTransaction = { _tag: 'COMGATE_TRANSACTION', transId: 'AB12-CD34-EF56' } as const;
        const recovered = (
          family: 'COMGATE' | 'GOPAY',
          finding: ProviderFindingResult['finding'],
          refs: readonly unknown[],
        ) =>
          recoverWith(
            {
              lookup: () =>
                Effect.succeed([findingOf({ factKind: 'REFUND_CONFIRMED', finding, kind: 'REFUND', refs })]),
              operations: [operationRow({ family, kind: 'REFUND' })],
              record: Option.some(
                dispatchRecord({
                  family,
                  kind: 'REFUND',
                  paymentRef: Option.some(family === 'GOPAY' ? gopayPayment : comgateTransaction),
                }),
              ),
            },
            { ...recoveryMessage('AUTHORITATIVE_LOOKUP', { family }), operationKind: 'REFUND' },
          ).pipe(Effect.map(({ calls }) => calls.ledger));
        // A family lookup that proves existence (Comgate statement; the real GoPay adapter never does for a lost
        // refund, it gets no baseline): the refund has no object of its own; the payment object is the recorded ref.
        expect(yield* recovered('GOPAY', 'EFFECT_CONFIRMED', [gopayPayment])).toEqual([
          'correlateUnknown:GOPAY_PAYMENT',
        ]);
        expect(yield* recovered('GOPAY', 'ACCEPTED_PENDING', [gopayPayment])).toEqual([
          'correlateUnknown:GOPAY_PAYMENT',
        ]);
        expect(yield* recovered('COMGATE', 'EFFECT_CONFIRMED', [comgateTransaction])).toEqual([
          'correlateUnknown:COMGATE_TRANSACTION',
        ]);
        // No proof that the refund exists: the dispatch stays OUTCOME_UNKNOWN and keeps later refunds serialized.
        expect(yield* recovered('COMGATE', 'INDETERMINATE', [comgateTransaction])).toEqual([]);
        expect(yield* recovered('COMGATE', 'VERIFICATION_CONFLICT', [comgateTransaction])).toEqual([]);
        expect(yield* recovered('GOPAY', 'NOT_EFFECTED', [gopayPayment])).toEqual([]);
      }),
  );

  it.effect('#1157 #1158 A Stripe refund without its refund ref is not looked up through the PaymentIntent', () =>
    Effect.gen(function* stripeRefundWithoutRefundRef() {
      yield* at(25 * HOUR_MS);
      const { calls, exit } = yield* recoverWith(
        {
          operations: [operationRow({ kind: 'REFUND' })],
          record: Option.some(
            dispatchRecord({
              kind: 'REFUND',
              paymentRef: Option.some({ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_recovered' }),
            }),
          ),
        },
        { ...recoveryMessage('AUTHORITATIVE_LOOKUP'), operationKind: 'REFUND' },
      );
      const report = reportOf(exit);
      // The refund notification records the refund ref; a PaymentIntent read with a refund expectation proves nothing.
      expect([report.providerCall, Option.getOrNull(report.indeterminate)]).toEqual([
        'NONE',
        'lookup_not_possible_without_provider_ref',
      ]);
      expect([calls.lookups, calls.appended, calls.ledger]).toEqual([[], [], []]);
    }),
  );

  it.effect('#1158 A lookup miss, an unsupported lookup and an undecodable answer stay INDETERMINATE', () =>
    Effect.gen(function* lookupMiss() {
      yield* at(25 * HOUR_MS);
      const record = dispatchRecord({
        family: 'GOPAY',
        paymentRef: Option.some({ _tag: 'GOPAY_PAYMENT', id: '3000006529' }),
        state: 'ACKNOWLEDGED',
      });
      const run = (lookup: Script['lookup']) =>
        recoverWith(
          { lookup, operations: [operationRow({ family: 'GOPAY' })], record: Option.some(record) },
          recoveryMessage('AUTHORITATIVE_LOOKUP', { family: 'GOPAY' }),
        );
      const miss = yield* run(() => Effect.succeed([findingOf({ finding: 'INDETERMINATE' })]));
      expect(Option.getOrNull(reportOf(miss.exit).indeterminate)).toBe('provider_indeterminate');
      expect(miss.calls.lookups.map(({ target }) => target)).toEqual([
        { _tag: 'PROVIDER_OBJECT', ref: { _tag: 'GOPAY_PAYMENT', id: '3000006529' } },
      ]);
      expect([miss.calls.appended, miss.calls.ledger, miss.calls.submitted]).toEqual([[], [], []]);
      const unsupported = yield* run(() =>
        Effect.fail(
          new GatewayProviderUnsupported({
            capability: 'RETRIEVE',
            code: 'gateway_provider_unsupported',
            family: 'GOPAY',
            reason: 'no order-reference lookup',
          }),
        ),
      );
      expect(Option.getOrNull(reportOf(unsupported.exit).indeterminate)).toBe('lookup_unsupported');
      const invalid = yield* run(() =>
        Effect.fail(
          new GatewayProviderResponseInvalid({
            code: 'gateway_provider_response_invalid',
            family: 'GOPAY',
            reason: 'gopay_state_unknown',
          }),
        ),
      );
      expect(Option.getOrNull(reportOf(invalid.exit).indeterminate)).toBe('lookup_response_invalid');
      // An outage is retryable, never a finding.
      const outage = yield* run(() => Effect.fail(unavailable('GOPAY', 'provider_timeout')));
      expect(failureOf(outage.exit)).toBe('GatewayProviderUnavailable:provider_timeout');
    }),
  );

  it.effect('#1157 A denied submission keeps every pending row pending and is not retried', () =>
    Effect.gen(function* deniedSubmission() {
      yield* at(25 * HOUR_MS);
      const earlier = storedPending('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stripe:local:earlier');
      const { calls, exit, rows } = yield* recoverWith(
        {
          lookup: () => Effect.succeed([findingOf({ finding: 'EFFECT_CONFIRMED', withOrderReference: true })]),
          operations: [operationRow()],
          pending: [earlier],
          record: Option.some(dispatchRecord()),
          submit: () => 'DENIED',
        },
        recoveryMessage('AUTHORITATIVE_LOOKUP'),
      );
      const report = reportOf(exit);
      expect([report.submissionDenied, report.submissions, report.appended.length]).toEqual([true, [], 1]);
      expect(calls.submitted).toEqual([earlier.evidenceId]);
      expect(calls.marked).toEqual([]);
      expect(rows.map(({ submissionState }) => submissionState)).toEqual(['PENDING_SUBMISSION', 'PENDING_SUBMISSION']);
    }),
  );

  it.effect('#1158 A refused governed submission keeps the evidence pending; an outage is retried', () =>
    Effect.gen(function* refusedSubmission() {
      yield* at(25 * HOUR_MS);
      const earlier = storedPending('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'stripe:local:refused');
      const later = storedPending('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'stripe:local:refused-later');
      const attempt = (reason: string) =>
        recoverWith(
          {
            lookup: () => Effect.succeed([]),
            operations: [operationRow()],
            pending: [earlier, later],
            record: Option.some(dispatchRecord()),
            submit: () => unavailable('STRIPE', reason),
          },
          recoveryMessage('AUTHORITATIVE_LOOKUP'),
        );
      // Shell refuses the delegation of a human-admitted recovery: the live submitter fails permanently.
      const refused = yield* attempt('submission_delegation_forbidden');
      const report = reportOf(refused.exit);
      expect([report.submissionDenied, report.submissions]).toEqual([true, []]);
      expect([refused.calls.submitted, refused.calls.marked]).toEqual([[earlier.evidenceId], []]);
      expect(refused.rows.map(({ submissionState }) => submissionState)).toEqual([
        'PENDING_SUBMISSION',
        'PENDING_SUBMISSION',
      ]);
      // A transient submission outage still fails the delivery so it is retried.
      const outage = yield* attempt('submission_delegation_unavailable:GatewayDelegationTransportError');
      expect(failureOf(outage.exit)).toBe(
        'GatewayProviderUnavailable:submission_delegation_unavailable:GatewayDelegationTransportError',
      );
    }),
  );

  it.effect('#1158 A definitive operation is not asked again, but its pending evidence is submitted', () =>
    Effect.gen(function* alreadyResolved() {
      yield* at(25 * HOUR_MS);
      const earlier = storedPending('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'stripe:local:resolved');
      const { calls, exit } = yield* recoverWith(
        {
          operations: [operationRow({ outcome: 'EFFECT_CONFIRMED' })],
          pending: [earlier],
          record: Option.some(dispatchRecord({ state: 'ACKNOWLEDGED' })),
          submit: () => 'DUPLICATE',
        },
        recoveryMessage('AUTHORITATIVE_LOOKUP'),
      );
      expect(Option.getOrNull(reportOf(exit).indeterminate)).toBe('already_resolved');
      expect([calls.resolved, calls.lookups]).toEqual([[], []]);
      expect(calls.marked).toEqual([{ evidenceId: earlier.evidenceId, outcome: 'DUPLICATE' }]);
    }),
  );

  it.effect('#1158 A never-prepared operation asks nothing; an operation of another scope is skipped', () =>
    Effect.gen(function* notDispatched() {
      const unsent = yield* recoverWith(
        {
          operations: [operationRow()],
          record: Option.some(dispatchRecord({ preparedAt: Option.none(), state: 'NOT_SENT' })),
        },
        recoveryMessage('AUTHORITATIVE_LOOKUP'),
      );
      expect(Option.getOrNull(reportOf(unsent.exit).indeterminate)).toBe('not_dispatched');
      expect(unsent.calls.resolved).toEqual([]);
      const foreign = yield* recoverWith(
        { operations: [], record: Option.none() },
        recoveryMessage('AUTHORITATIVE_LOOKUP'),
      );
      expect(Exit.isSuccess(foreign.exit) && Option.isNone(foreign.exit.value)).toBe(true);
    }),
  );

  it.effect('#1156 Recovery resolves the original binding and never asks another binding', () =>
    Effect.gen(function* originalBindingOnly() {
      yield* at(25 * HOUR_MS);
      const { calls, exit } = yield* recoverWith(
        {
          operations: [operationRow()],
          record: Option.some(dispatchRecord()),
          resolve: () => Effect.succeed(executionTarget('STRIPE', otherBindingId)),
        },
        recoveryMessage('AUTHORITATIVE_LOOKUP'),
      );
      expect(failureOf(exit)).toBe('GatewayProviderUnavailable:binding_mismatch');
      expect([calls.lookups, calls.submitted]).toEqual([[], []]);
      const outage = yield* recoverWith(
        {
          operations: [operationRow()],
          record: Option.some(dispatchRecord()),
          resolve: () => Effect.fail(unavailable('STRIPE', 'credential_not_active')),
        },
        recoveryMessage('AUTHORITATIVE_LOOKUP'),
      );
      expect(failureOf(outage.exit)).toBe('GatewayProviderUnavailable:credential_not_active');
    }),
  );

  it.effect('#1156 A cancel lookup expects its collection target and reports only on the two operations', () =>
    Effect.gen(function* cancelLookup() {
      yield* at(25 * HOUR_MS);
      const record = dispatchRecord({
        kind: 'CANCEL_OR_VOID',
        operationId: cancelId,
        paymentRef: Option.some({ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_recovered' }),
        state: 'OUTCOME_UNKNOWN',
      });
      const foreign = '12121212-1212-4212-8212-121212121212';
      const { calls, exit } = yield* recoverWith(
        {
          appendConflicts: new Set([
            `stripe:RECOVERY_LOOKUP:pi_test_recovered:${operationId}:COLLECTION_CONFIRMED:100000`,
          ]),
          lookup: () =>
            Effect.succeed([
              findingOf({
                factKind: 'CANCEL_NOT_EFFECTED',
                finding: 'NOT_EFFECTED',
                kind: 'CANCEL_OR_VOID',
                operationId: cancelId,
              }),
              findingOf({ finding: 'EFFECT_CONFIRMED' }),
              findingOf({ finding: 'EFFECT_CONFIRMED', operationId: foreign }),
            ]),
          operations: [
            operationRow({ kind: 'CANCEL_OR_VOID', operationId: cancelId, targetOperationId: operationId }),
            operationRow(),
          ],
          record: Option.some(record),
        },
        { ...recoveryMessage('AUTHORITATIVE_LOOKUP'), operationId: cancelId, operationKind: 'CANCEL_OR_VOID' },
      );
      expect(calls.expected).toEqual([
        { _tag: 'CANCEL_OR_VOID', operationId: cancelId, target: { amount: AMOUNT, operationId } },
      ]);
      // The foreign finding is never appended; the conflicting statement is skipped, not retried.
      expect(calls.appended.map((input) => input.operationId)).toEqual([cancelId, operationId]);
      const report = reportOf(exit);
      expect([report.appended.length, Option.getOrNull(report.indeterminate)]).toEqual([1, 'evidence_conflict']);
      expect(calls.submitted.length).toBe(1);
    }),
  );

  it.effect(
    '#1156 #1158 A Comgate refund recovery reaches the statement: LIVE confirms from a debit row or stays INDETERMINATE, SANDBOX asks nothing',
    () =>
      Effect.gen(function* comgateRefundStatementRecovery() {
        // Prepared 2026-11-12 11:00 Prague, recovered 2026-11-13 12:00 Prague: only the dispatch day's statement is
        // readable (dispatch date .. yesterday).
        yield* at(25 * HOUR_MS);
        const credentials = {
          [COMGATE_RECOVERY_SECRET_REF]: { family: 'COMGATE', secret: 'comgate-recovery-not-a-secret' },
        };
        const transactionRef = { _tag: 'COMGATE_TRANSACTION', transId: 'AB12-CD34-EF56' } as const;
        const refundReference = deriveProviderCorrelation(
          Schema.decodeUnknownSync(ProviderDispatchRecordSchema.fields.operationId)(operationId),
        ).orderReference;
        const statementReads = (orderReference: string) => ({
          [`GET ${COMGATE_STATEMENT_API}/singleTransfer/transferId/7654321.json`]: [
            respond(
              200,
              Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))([
                comgateStatementRow(orderReference),
              ]),
            ),
          ],
          [`GET ${COMGATE_STATEMENT_API}/transferList/date/2026-11-12.json`]: [
            respond(
              200,
              '[{"transferId":7654321,"transferDate":"2026-11-12","accountCounterparty":"0/0000","accountOutgoing":"123456789/0000","variableSymbol":"12345678"}]',
            ),
          ],
        });
        const recovered = (environment: 'LIVE' | 'SANDBOX', routes: Parameters<typeof recordedGatewayAdapters>[0]) =>
          Effect.gen(function* recoverComgateRefund() {
            const provider = yield* recordedGatewayAdapters(routes);
            const binding = bindingOf('COMGATE', environment);
            const run = yield* recoverWith(
              {
                adapters: provider.adapters,
                operations: [{ ...operationRow({ family: 'COMGATE', kind: 'REFUND' }), binding }],
                record: Option.some(
                  Schema.decodeUnknownSync(ProviderDispatchRecordSchema)({
                    ...Schema.encodeSync(ProviderDispatchRecordSchema)(
                      dispatchRecord({
                        family: 'COMGATE',
                        kind: 'REFUND',
                        paymentRef: Option.some(transactionRef),
                        state: 'ACKNOWLEDGED',
                      }),
                    ),
                    environment,
                  }),
                ),
                resolve: () =>
                  Effect.succeed(
                    Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
                      ...Schema.encodeSync(GatewayExecutionTargetSchema)(executionTarget('COMGATE')),
                      binding,
                      credentialSecretRef: COMGATE_RECOVERY_SECRET_REF,
                      merchantIdentity: { _tag: 'COMGATE', merchantId: COMGATE_MERCHANT_ID },
                    }),
                  ),
              },
              {
                ...recoveryMessage('AUTHORITATIVE_LOOKUP', { family: 'COMGATE' }),
                binding,
                operationKind: 'REFUND',
              },
            );
            return { ...run, sent: provider.sent.map(({ route }) => route) };
          }).pipe(Effect.provide(credentialConfig(credentials)));

        // LIVE: the debit row with the refund's own refId, merchant, currency and amount is the completion proof.
        const confirmed = yield* recovered('LIVE', statementReads(refundReference));
        expect(confirmed.sent).toEqual([
          `GET ${COMGATE_STATEMENT_API}/transferList/date/2026-11-12.json`,
          `GET ${COMGATE_STATEMENT_API}/singleTransfer/transferId/7654321.json`,
        ]);
        expect([
          reportOf(confirmed.exit).providerCall,
          Option.getOrNull(reportOf(confirmed.exit).indeterminate),
        ]).toEqual(['LOOKUP_PROVIDER_OBJECT', null]);
        expect(
          confirmed.calls.appended.map(({ evidence, operationId: target, origin }) => [
            target,
            origin,
            evidence.factKind,
            evidence.sourceOccurrenceId,
          ]),
        ).toEqual([
          [
            operationId,
            'RECOVERY_LOOKUP',
            'REFUND_CONFIRMED',
            `comgate:statement:7654321:${operationId}:REFUND_CONFIRMED:100000`,
          ],
        ]);
        expect(confirmed.calls.replays).toEqual([]);

        // LIVE without the refund's row (another refId only): INDETERMINATE, never NOT_EFFECTED, nothing appended.
        const absent = yield* recovered('LIVE', statementReads('f'.repeat(32)));
        expect(absent.sent).toHaveLength(2);
        expect(Option.getOrNull(reportOf(absent.exit).indeterminate)).toBe('provider_indeterminate');
        expect(absent.calls.appended).toEqual([]);

        // SANDBOX: statements exist only for production payments, so nothing is asked and the refund stays open.
        const sandbox = yield* recovered('SANDBOX', {});
        expect(sandbox.sent).toEqual([]);
        expect(Option.getOrNull(reportOf(sandbox.exit).indeterminate)).toBe('provider_indeterminate');
        expect(sandbox.calls.appended).toEqual([]);
      }),
  );
});
