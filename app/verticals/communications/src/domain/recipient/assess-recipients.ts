import { DateTime, Effect } from 'effect';

import type { CommunicationDecisionRequest, RecipientFact } from '../catalog/decision-request.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import type { PrivacyEvidence } from '../catalog/vocabulary.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import { bindOriginalRecipients } from './bind-original-recipients.ts';
import type { BoundRecipient } from './bind-original-recipients.ts';
import { RecipientCurrentGate, RecipientGateVerdict } from './current-gate.ts';
import type { RecipientGateQuery } from './current-gate.ts';
import type {
  OriginalContactBinding,
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

/** The owner answered for the contact and revision the source evidenced, and for no other. */
const answersOriginalContact = (endpoint: ProtectedEndpoint, contact: OriginalContactBinding) =>
  resourceRefKey(endpoint.contactRef) === resourceRefKey(contact.contactRef) &&
  (contact.evidence.kind !== 'VERSIONED_SNAPSHOT' || endpoint.contactRevision === contact.evidence.contactRevision);

const queryOf = (input: RecipientEvaluationInput, { contact, subject }: BoundRecipient): RecipientGateQuery => ({
  contact,
  occurrence: input.request.occurrence,
  purpose: input.request.purpose,
  recipient: { recipientRef: subject.binding.recipientRef, role: subject.binding.role },
  scope: input.scope,
  sourceModule: input.request.source.moduleKey,
  typeId: input.type.typeId,
});

/** Ask the gate about one bound recipient; unavailable authority fails closed into its own outcome. */
export const checkBoundRecipient = (
  input: RecipientEvaluationInput,
  bound: BoundRecipient,
): Effect.Effect<RecipientAssessmentCase, never, RecipientCurrentGate> =>
  Effect.flatMap(Effect.service(RecipientCurrentGate), (gate) =>
    gate.check(queryOf(input, bound)).pipe(
      Effect.map((verdict) =>
        RecipientGateVerdict.$match(verdict, {
          Unusable: ({ reason }) => RecipientAssessment.RecipientNotAllowed({ reason, subject: bound.subject }),
          Usable: ({ endpoint }) =>
            answersOriginalContact(endpoint, bound.contact)
              ? RecipientAssessment.RecipientAllowed({ endpoint, subject: bound.subject })
              : RecipientAssessment.RecipientNotAllowed({
                  reason: 'ENDPOINT_IDENTITY_CHANGED',
                  subject: bound.subject,
                }),
        }),
      ),
      Effect.catchTag('RecipientAuthorityUnavailable', ({ authority }) =>
        Effect.succeed(RecipientAssessment.SourceUnavailable({ authority, subject: bound.subject })),
      ),
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
