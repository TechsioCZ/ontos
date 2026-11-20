import { DateTime, Effect, Exit, identity, Option } from 'effect';

import type { CommunicationDecisionRequest, RecipientFact } from '../catalog/decision-request.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import type { PrivacyEvidence } from '../catalog/vocabulary.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import { safeCauseSummaryOf } from '../intake/safe-cause.ts';
import { bindOriginalRecipients } from './bind-original-recipients.ts';
import type { BoundRecipient } from './bind-original-recipients.ts';
import { RecipientCurrentGate, RecipientGateVerdict } from './current-gate.ts';
import type { RecipientGateQuery } from './current-gate.ts';
import { endpointMaskIsSafe } from './original-binding.ts';
import type {
  OriginalContactBinding,
  OriginalContactEvidence,
  OriginalRecipientBinding,
  ProtectedEndpoint,
  RecipientScope,
} from './original-binding.ts';
import { RecipientAssessment } from './recipient-assessment.ts';
import type { RecipientAssessmentCase } from './recipient-assessment.ts';
import { recipientEvidenceOf } from './recipient-evidence.ts';
import type { RecipientEvidence } from './recipient-evidence.ts';

/**
 * Per-recipient evaluation (#1395, PO 2A): every distinct original recipient of every audience slot is assessed on
 * its own, so a partial result is normal (2 of 3 allowed, 1 explained) and one recipient's failure never changes
 * another's. The binding stage is pure; the Current gate then re-checks the ORIGINAL recipient and endpoint only.
 * Nothing here ever reads, offers or falls back to a Current contact, CC/BCC or another channel.
 */

export interface RecipientEvaluationInput {
  readonly bindings: readonly OriginalRecipientBinding[];
  readonly request: CommunicationDecisionRequest;
  /** The trusted scope of the committed source request; every binding must have been evidenced in exactly it. */
  readonly scope: RecipientScope;
  readonly type: TransactionalMessageType;
}

export interface EvaluatedRecipient {
  readonly assessment: RecipientAssessmentCase;
  readonly evidence: RecipientEvidence;
}

/** Bounds parallel owner calls only; it never limits how many recipients a request may have. */
export const GATE_CONCURRENCY = 8;

/**
 * The owner echoed the revision or snapshot reference the original evidence names, and the same one: an answer that
 * omits it or names another cannot be told apart from an answer for another version of the contact, so it fails closed.
 * An authoritative reference names neither a revision nor a snapshot, so the contact reference is its whole identity.
 */
const echoesEvidence = (endpoint: ProtectedEndpoint, evidence: OriginalContactEvidence) => {
  if (evidence.kind === 'VERSIONED_SNAPSHOT') {
    return endpoint.contactRevision === evidence.contactRevision;
  }
  if (evidence.kind === 'HISTORICAL_SNAPSHOT') {
    return (
      endpoint.snapshotRef !== undefined &&
      resourceRefKey(endpoint.snapshotRef) === resourceRefKey(evidence.snapshotRef)
    );
  }
  return true;
};

/** The owner answered for the contact the source evidenced and for the revision or snapshot it names, and for no other. */
const answersOriginalContact = (endpoint: ProtectedEndpoint, contact: OriginalContactBinding) =>
  resourceRefKey(endpoint.contactRef) === resourceRefKey(contact.contactRef) &&
  echoesEvidence(endpoint, contact.evidence);

/** A usable endpoint is allowed only for the original contact and with a mask that hides the address. */
const assessEndpoint = (endpoint: ProtectedEndpoint, bound: BoundRecipient): RecipientAssessmentCase => {
  if (!answersOriginalContact(endpoint, bound.contact)) {
    return RecipientAssessment.RecipientNotAllowed({ reason: 'ENDPOINT_IDENTITY_CHANGED', subject: bound.subject });
  }
  return endpointMaskIsSafe(endpoint)
    ? RecipientAssessment.RecipientAllowed({ endpoint, subject: bound.subject })
    : RecipientAssessment.RecipientNotAllowed({ reason: 'ENDPOINT_MASK_UNSAFE', subject: bound.subject });
};

const queryOf = (input: RecipientEvaluationInput, { contact, subject }: BoundRecipient): RecipientGateQuery => ({
  contact,
  occurrence: input.request.occurrence,
  purpose: input.request.purpose,
  recipient: { recipientRef: subject.binding.recipientRef, role: subject.binding.role },
  scope: input.scope,
  sourceModule: input.request.source.moduleKey,
  typeId: input.type.typeId,
});

const sourceUnavailable = (bound: BoundRecipient) =>
  RecipientAssessment.SourceUnavailable({ authority: 'SOURCE_OWNER', subject: bound.subject });

/**
 * Ask the gate about one bound recipient; unavailable authority fails closed into its own outcome. A gate that
 * throws, dies or does not answer within its deadline makes THIS recipient SourceUnavailable and no other: the
 * failure never reaches the recipients evaluated beside it.
 */
export const checkBoundRecipient = (
  input: RecipientEvaluationInput,
  bound: BoundRecipient,
): Effect.Effect<RecipientAssessmentCase, never, RecipientCurrentGate> =>
  Effect.flatMap(Effect.service(RecipientCurrentGate), (gate) =>
    Effect.suspend(() => gate.check(queryOf(input, bound))).pipe(
      Effect.map((verdict) =>
        RecipientGateVerdict.$match(verdict, {
          Unusable: ({ reason }) => RecipientAssessment.RecipientNotAllowed({ reason, subject: bound.subject }),
          Usable: ({ endpoint }) => assessEndpoint(endpoint, bound),
        }),
      ),
      Effect.catchTag('RecipientAuthorityUnavailable', ({ authority }) =>
        Effect.succeed(RecipientAssessment.SourceUnavailable({ authority, subject: bound.subject })),
      ),
      Effect.timeoutOption(gate.checkTimeout),
      Effect.map(Option.getOrElse(() => sourceUnavailable(bound))),
      // Anything left is a defect of the owner adapter: it is logged by its safe kind only, kept out of this recipient's result and
      // turned into the same fail-closed outcome as an unavailable owner.
      Effect.tapCause((cause) =>
        Effect.logError('Recipient gate check failed unexpectedly; failing closed', safeCauseSummaryOf(cause)),
      ),
      Effect.exit,
      Effect.map(Exit.match({ onFailure: () => sourceUnavailable(bound), onSuccess: identity })),
    ),
  );

/** Pair one assessment with the safe evidence of this very evaluation. */
export const evaluatedRecipientOf = (
  input: RecipientEvaluationInput,
  evaluatedAt: DateTime.Utc,
  assessment: RecipientAssessmentCase,
): EvaluatedRecipient => ({
  assessment,
  evidence: recipientEvidenceOf(assessment, {
    evaluatedAt,
    request: input.request,
    scope: input.scope,
    type: input.type,
  }),
});

/** Assess every recipient of the request individually. Never fails: every problem is a recipient outcome. */
export const assessRecipients = Effect.fn('Communications.assessRecipients')(function* assessAll(
  input: RecipientEvaluationInput,
) {
  const evaluatedAt = yield* DateTime.now;
  const stages = bindOriginalRecipients(input.type, input.scope, input.bindings);
  const assessments = yield* Effect.forEach(
    stages,
    (stage) => (stage.kind === 'settled' ? Effect.succeed(stage.assessment) : checkBoundRecipient(input, stage)),
    { concurrency: GATE_CONCURRENCY },
  );
  return assessments.map((assessment) => evaluatedRecipientOf(input, evaluatedAt, assessment));
});

/**
 * The Communication Decision fact of one assessment. Privacy evidence is supplied by the caller (d21-04): this
 * recipient evaluation neither fabricates nor implies it. Allowed carries no stop; the other three outcomes map to
 * their own distinct stop so uncertainty is never reported as a prohibition.
 */
export const recipientFactOf = (
  assessment: RecipientAssessmentCase,
  request: CommunicationDecisionRequest,
  privacy: PrivacyEvidence,
): RecipientFact => {
  const { binding } = assessment.subject;
  return {
    occurrenceId: request.occurrence.occurrenceId,
    privacy,
    ...RecipientAssessment.$match(assessment, {
      RecipientAllowed: () => ({}),
      RecipientNotAllowed: () => ({ recipientStop: 'RECIPIENT_NOT_ELIGIBLE' as const }),
      RecipientUnresolved: () => ({ recipientStop: 'RECIPIENT_BASIS_MISSING' as const }),
      SourceUnavailable: () => ({ recipientStop: 'RECIPIENT_AUTHORITY_UNAVAILABLE' as const }),
    }),
    ref: binding.recipientRef,
    role: binding.role,
    tenantId: request.tenantId,
  };
};
