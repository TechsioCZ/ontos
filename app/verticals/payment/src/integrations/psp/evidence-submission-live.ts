import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Context, Crypto, DateTime, Effect, Layer, Option, Predicate, Redacted, Schema } from 'effect';

import { AcceptPaymentObservationPayloadSchema } from '../../../shared/actions/accept-payment-observation.ts';
import type { AcceptPaymentObservationPayload } from '../../../shared/actions/accept-payment-observation.ts';
import type { PaymentSourceStatementResult } from '../../../shared/domain/source-statement.ts';
import { executeAcceptPaymentObservationWithAuthorization } from '../../api/accept-payment-observation-action-client.ts';
import type { ProviderEvidenceSubmissionOutcome, StoredProviderEvidence } from './evidence-store.ts';
import { ProviderEvidenceSubmitter } from './evidence-submission.ts';
import type {
  ProviderEvidenceSubmission,
  ProviderEvidenceSubmissionResult,
  ProviderEvidenceSubmitterContract,
} from './evidence-submission.ts';
import { GatewayProviderUnavailable } from './psp-errors.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';

/**
 * The one governed apply path of C17 provider evidence (plan D8, #1157, #1159): a fresh RegisteredWorkload
 * assertion from the Shell gateway for this exact delivery, then the public A8 `accept-payment-observation`
 * Action of Payment itself. There is no owner-local bypass; Payment's own A8 admission (module state, source
 * workload binding, source authority by fact family) decides like for any other source.
 *
 * Failures are typed `GatewayProviderUnavailable`. Reasons in `PERMANENT_SUBMISSION_REFUSALS` mean the governed
 * path refused this delivery itself (no workload-admitted origin, no worker lease, no deployment credential,
 * a parked proposal): retrying the same delivery cannot change that, so the evidence stays PENDING_SUBMISSION
 * as visible reconciliation debt. Every other reason is transient and the delivery retries.
 */

const A8_AUDIENCE = 'payment';
const A8_DECLARATION_KEY = 'payment.core.observation.accept';

/** The conditional operation requirement each submitting worker declares in the manifest. */
const requirementOf = (workerKey: string): Option.Option<string> => {
  if (workerKey === 'payment.core.process-provider-notification') {
    return Option.some('payment.core.requirement.gateway-evidence-notification');
  }
  return workerKey === 'payment.core.recover-gateway-operation'
    ? Option.some('payment.core.requirement.gateway-evidence-recovery')
    : Option.none();
};

/** The governed path refused this delivery; the evidence stays pending debt and the delivery is not retried. */
const PERMANENT_SUBMISSION_REFUSALS = [
  'submission_worker_not_registered',
  'submission_statement_invalid',
  'submission_delegation_refused',
  'submission_delegation_forbidden',
  'submission_executor_unattested',
  'submission_parked_as_proposal',
] as const;
type PermanentSubmissionRefusal = (typeof PERMANENT_SUBMISSION_REFUSALS)[number];

/** True for a refusal of the governed path itself; every other failure is transient and retried. */
export const isPermanentSubmissionRefusal = (failure: GatewayProviderUnavailableError): boolean =>
  PERMANENT_SUBMISSION_REFUSALS.some((reason) => failure.reason === reason || failure.reason.startsWith(`${reason}:`));

const unavailable = (
  submission: ProviderEvidenceSubmission,
  reason: PermanentSubmissionRefusal | `submission_${string}`,
): GatewayProviderUnavailableError =>
  new GatewayProviderUnavailable({
    code: 'gateway_provider_unavailable',
    family: submission.binding.providerFamily,
    reason: reason.slice(0, 500),
  });

/** One stable A8 idempotency key per stored evidence row: the persisted effect identity (OUTBOX_WORKERS.md). */
const idempotencyKeyOf = (evidence: StoredProviderEvidence) => `payment-psp-evidence-${evidence.evidenceId}`;

/**
 * The A8 statement of one stored evidence row. Source = the immutable C16 operation binding (system = family,
 * account = providerAccountRef, environment); `receivedAt` is the stored receipt instant, never the
 * submission time; the amount is the authentic provider amount in its own currency.
 */
const statementOf = (submission: ProviderEvidenceSubmission) => {
  const { binding, evidence: stored } = submission;
  const { evidence } = stored;
  const encoded = {
    factFamily: evidence.factFamily,
    factKind: evidence.factKind,
    operationId: stored.operationId,
    paymentId: stored.paymentId,
    receivedAt: DateTime.formatIso(stored.receivedAt),
    source: {
      accountRef: binding.providerAccountRef,
      environment: binding.environment,
      sourceKind: 'PAYMENT_GATEWAY',
      sourceSystem: binding.providerFamily,
    },
    sourceOccurrenceId: evidence.sourceOccurrenceId,
    sourceRevision: evidence.sourceRevision,
    ...Option.match(evidence.observedAmount, {
      onNone: () => ({}),
      onSome: (amount) => ({ amount: { amountMinor: amount.amountMinor, currency: amount.currency } }),
    }),
    ...Option.match(evidence.economicEffectKey, {
      onNone: () => ({}),
      onSome: (economicEffectKey) => ({ economicEffectKey }),
    }),
    ...Option.match(evidence.providerOccurredAt, {
      onNone: () => ({}),
      onSome: (occurredAt) => ({ sourceOccurredAt: DateTime.formatIso(occurredAt) }),
    }),
  };
  return Schema.decodeUnknownEffect(AcceptPaymentObservationPayloadSchema)(encoded).pipe(
    Effect.mapError((failure) => unavailable(submission, `submission_statement_invalid:${failure._tag}`)),
  );
};

const OUTCOME_BY_ACCEPTANCE = {
  ACCEPTED_OBSERVATION: 'ACCEPTED',
  CONFLICT: 'CONFLICT',
  DUPLICATE: 'DUPLICATE',
  HELD_UNRESOLVED: 'HELD',
} as const satisfies Record<PaymentSourceStatementResult['acceptanceOutcome'], ProviderEvidenceSubmissionOutcome>;

const decided = (
  outcome: ProviderEvidenceSubmissionOutcome,
  observationId: ProviderEvidenceSubmissionResult['observationId'] = Option.none(),
): ProviderEvidenceSubmissionResult => ({ observationId, outcome });

/** A refusal for a permission, approval, context or source authority is A8's decision; module state is not. */
const DENYING_FORBIDDEN_CODES = [
  'action_approval_required',
  'action_permission_denied',
  'operation_context_denied',
  'operation_context_invalid',
  'payment_source_authority_forbidden',
] as const;

const forbiddenDecision = (submission: ProviderEvidenceSubmission, code: string) =>
  DENYING_FORBIDDEN_CODES.some((denying) => denying === code)
    ? Effect.succeed(decided('DENIED'))
    : Effect.fail(unavailable(submission, `submission_a8_${code}`));

const conflictDecision = (submission: ProviderEvidenceSubmission, code: string) => {
  if (code === 'payment_source_occurrence_conflict') {
    return Effect.succeed(decided('CONFLICT'));
  }
  return code === 'payment_held_for_reconciliation'
    ? Effect.succeed(decided('HELD'))
    : Effect.fail(unavailable(submission, `submission_a8_${code}`));
};

interface AuthorizedA8Call {
  readonly authorization: Redacted.Redacted;
  readonly baseUrl: string;
  readonly compositionRevision: string;
  readonly idempotencyKey: string;
  readonly requestCorrelation: string;
}

const a8Transport = Object.freeze({
  acquire: acquireDelegatedGatewayContext,
  execute: (payload: AcceptPaymentObservationPayload, call: AuthorizedA8Call) =>
    executeAcceptPaymentObservationWithAuthorization(
      payload,
      Redacted.value(call.authorization),
      call.requestCorrelation,
      {
        baseUrl: call.baseUrl,
        compositionRevision: call.compositionRevision,
        idempotencyKey: call.idempotencyKey,
      },
    ),
});

/** Transport boundary of the Shell gateway and the A8 client. Tests replace only these two remote calls. */
export const ProviderEvidenceSubmissionTransport = Context.Reference<typeof a8Transport>(
  '@app/payment/integrations/psp/evidence-submission-live/ProviderEvidenceSubmissionTransport',
  { defaultValue: () => a8Transport },
);

const requestCorrelationOf = (context: OutboxWorkerHandlerContext) => context.correlationId ?? context.deliveryId;

const submitWith = (crypto: Crypto.Crypto) =>
  Effect.fn('ProviderEvidenceSubmitter.submit')(function* submit(submission: ProviderEvidenceSubmission) {
    const { scope, workerContext } = submission;
    const transport = yield* ProviderEvidenceSubmissionTransport;
    const operationRequirementKey = requirementOf(workerContext.workerKey);
    if (Option.isNone(operationRequirementKey)) {
      return yield* Effect.fail(unavailable(submission, 'submission_worker_not_registered'));
    }
    const payload = yield* statementOf(submission);
    const requestCorrelation = requestCorrelationOf(workerContext);
    // Shell chooses the receiving system principal from the tenant's single `payment.source-ingress`
    // enrollment. It is not yet pinned with `expectedPrincipalId`: pinning needs the evidence row's executor pin
    // committed before A8, so until then a retry relies on the stable idempotency key and A8's source-occurrence
    // identity.
    const issued = yield* transport
      .acquire(
        {
          audience: A8_AUDIENCE,
          legalEntityScope: 'subject',
          requestCorrelation,
          subject: {
            _tag: 'RegisteredWorkload',
            context: workerContext,
            declarationKey: A8_DECLARATION_KEY,
            legalEntityId: scope.legalEntityId,
            operationRequirementKey: operationRequirementKey.value,
          },
        },
        crypto,
      )
      .pipe(
        Effect.catchTags({
          GatewayDelegationSourceError: (refusal) =>
            Effect.fail(unavailable(submission, `submission_delegation_refused:${refusal.reason}`)),
          GatewayForbiddenProblem: () => Effect.fail(unavailable(submission, 'submission_delegation_forbidden')),
        }),
        Effect.mapError((failure) =>
          Predicate.isTagged(failure, 'GatewayProviderUnavailable')
            ? failure
            : unavailable(submission, `submission_delegation_unavailable:${failure._tag}`),
        ),
      );
    if (issued.machineContext === undefined) {
      return yield* Effect.fail(unavailable(submission, 'submission_executor_unattested'));
    }
    return yield* transport
      .execute(payload, {
        authorization: Redacted.make(issued.authorization),
        baseUrl: issued.apiBaseUrl,
        compositionRevision: issued.compositionRevision,
        idempotencyKey: idempotencyKeyOf(submission.evidence),
        requestCorrelation,
      })
      .pipe(
        Effect.flatMap((answer) =>
          Schema.is(ActionProposalAcceptedSchema)(answer)
            ? Effect.fail(unavailable(submission, 'submission_parked_as_proposal'))
            : Effect.succeed(
                decided(OUTCOME_BY_ACCEPTANCE[answer.acceptanceOutcome], Option.some(answer.observationId)),
              ),
        ),
        Effect.catchTags({
          // Our own key already committed this statement on an earlier, uncertain attempt: it is recorded.
          AcceptPaymentObservationActionAlreadyCommittedProblem: () => Effect.succeed(decided('DUPLICATE')),
          AcceptPaymentObservationActionConflictProblem: ({ code }) => conflictDecision(submission, code),
          AcceptPaymentObservationActionForbiddenProblem: ({ code }) => forbiddenDecision(submission, code),
          // A refused statement commits nothing (#1152): an invalid, unknown or ineligible statement is DENIED.
          AcceptPaymentObservationActionIneligibleProblem: () => Effect.succeed(decided('DENIED')),
          AcceptPaymentObservationActionInvalidProblem: () => Effect.succeed(decided('DENIED')),
          AcceptPaymentObservationActionNotFoundProblem: () => Effect.succeed(decided('DENIED')),
        }),
        Effect.mapError((failure) =>
          Predicate.isTagged(failure, 'GatewayProviderUnavailable')
            ? failure
            : unavailable(submission, `submission_a8_unavailable:${failure._tag}`),
        ),
      );
  });

const makeProviderEvidenceSubmitter = Effect.fn('ProviderEvidenceSubmitter.make')(function* makeSubmitter() {
  const crypto = yield* Crypto.Crypto;
  return { submit: submitWith(crypto) } satisfies ProviderEvidenceSubmitterContract;
});

export const ProviderEvidenceSubmitterLive = Layer.effect(ProviderEvidenceSubmitter, makeProviderEvidenceSubmitter());
