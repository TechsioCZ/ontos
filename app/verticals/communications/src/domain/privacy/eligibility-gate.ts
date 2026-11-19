import { Context, Data, Effect, Layer, Schema } from 'effect';
import type { Duration } from 'effect';

import type { CommunicationDecisionRequest } from '../catalog/decision-request.ts';
import type { CommunicationResourceRef, MessageTypeId, RecipientRole } from '../catalog/vocabulary.ts';
import { ProcessingEligibilityUnavailable } from './eligibility-errors.ts';
import { PrivacyPurposeVersionIdSchema, PrivacyScopeIdSchema } from './processing-scope.ts';
import type { ProcessingScope } from './processing-scope.ts';

export type { UnavailableReason } from './eligibility-errors.ts';

/**
 * Consumer port of the PUBLIC Privacy Processing Eligibility contract (#1396, #555-#563). Communications asks Privacy
 * and consumes the answer; it never decides a legal basis, a Consent or a subscription, and it keeps no preference
 * of its own (BR-02). The port speaks only the business vocabulary; the real client (an authorized call to the Privacy
 * owner's published Read) is wired by the composition (d21-07), so this domain imports no other deployment.
 *
 * Three things are different facts and are NEVER merged here:
 * - the owner's Current DECISION (`Allowed`, `NotAllowed`, `Indeterminate`);
 * - a failure to reach a decision at all (`ProcessingEligibilityUnavailable`: denied access, owner outage, ambiguous context);
 * - provider uncertainty, which is not asked here (step 22, reconciliation).
 */

/** Safe references to the facts behind an owner decision; never a payload, a secret or a consent history copy. */
const EligibilityEvidenceSchema = Schema.Struct({
  authoritativeReferences: Schema.Array(
    Schema.Struct({ kind: Schema.String, reference: Schema.String, revision: Schema.String }),
  ),
  /** The exact scope Privacy says it evaluated, so a decision for another use is recognized and never applied. */
  evaluatedScope: Schema.Struct({
    controllerRef: Schema.String,
    dataCategoryRefs: Schema.Array(Schema.String),
    operation: Schema.String,
    privacySubjectRef: Schema.String,
    processingScopeRef: Schema.Struct({ scopeId: PrivacyScopeIdSchema, scopeType: Schema.String }),
    purposeRef: Schema.String,
    purposeVersionId: PrivacyPurposeVersionIdSchema,
    recipientRefs: Schema.Array(Schema.String),
  }),
  policyRevisions: Schema.Array(Schema.Struct({ policyRef: Schema.String, revision: Schema.String })),
  /** Owner explanation codes, for example the blocking fact; never interpreted as legal advice. */
  reasonCodes: Schema.Array(Schema.String),
  trustedDecisionTime: Schema.DateTimeUtcFromString,
});
export type EligibilityEvidence = typeof EligibilityEvidenceSchema.Type;

/**
 * Why the owner could not EVIDENCE a decision although it answered:
 * - INPUTS_NOT_EVIDENCED: Privacy says a mandatory input is unavailable, stale or in conflict, and no prohibition is proven;
 * - CONTEXT_NOT_SUPPORTED: Privacy has no exact current context for this use (for example an Auth occurrence it cannot
 *   represent before the address is verified); nothing was evaluated, so nothing is allowed and nothing is forbidden;
 * - EVIDENCE_MISSING: a denial arrived without the owner evidence that a proven prohibition requires;
 * - EVIDENCE_SCOPE_MISMATCH: the owner decision is for another use than the one asked about, so it is not applied;
 * - EVIDENCE_INCONSISTENT: the decision contradicts its own evidence.
 */
const IndeterminateCauseSchema = Schema.Literals([
  'INPUTS_NOT_EVIDENCED',
  'CONTEXT_NOT_SUPPORTED',
  'EVIDENCE_MISSING',
  'EVIDENCE_SCOPE_MISMATCH',
  'EVIDENCE_INCONSISTENT',
]);
export type IndeterminateCause = typeof IndeterminateCauseSchema.Type;

/** Basis of a proven prohibition: an evaluated Current fact, or Privacy's own recorded protection of the material. */
const NotAllowedBasisSchema = Schema.Literals(['EVALUATED_PROHIBITION', 'PROTECTED_MATERIAL']);
export type NotAllowedBasis = typeof NotAllowedBasisSchema.Type;

/** What the Privacy owner decided Now for one exact scope. */
export type ProcessingEligibilityVerdictCase = Data.TaggedEnum<{
  Allowed: { readonly evidence: EligibilityEvidence };
  Indeterminate: { readonly cause: IndeterminateCause; readonly evidence?: EligibilityEvidence };
  NotAllowed: { readonly basis: NotAllowedBasis; readonly evidence?: EligibilityEvidence };
}>;
export const ProcessingEligibilityVerdict = Data.taggedEnum<ProcessingEligibilityVerdictCase>();

/** One question: may THIS message to THIS original recipient be processed for exactly THIS scope now? */
export interface ProcessingEligibilityQuery {
  readonly occurrence: CommunicationDecisionRequest['occurrence'];
  readonly recipient: { readonly recipientRef: CommunicationResourceRef; readonly role: RecipientRole };
  readonly scope: ProcessingScope;
  readonly sourceModule: CommunicationDecisionRequest['source']['moduleKey'];
  readonly tenantId: CommunicationDecisionRequest['tenantId'];
  readonly typeId: MessageTypeId;
}

/** What an adapter must supply besides its answers. The deadline is a deployment decision; the domain has no default. */
export interface ProcessingEligibilityGateSettings {
  /** Longest one check may take. A check past it fails closed as an unavailable owner. */
  readonly checkTimeout: Duration.Input;
}

/**
 * TRUST BOUNDARY for the owner contract (d21-07): an adapter MUST ask with the calling Principal's own authority and
 * MUST report the owner's `evaluatedScope` back unchanged. This domain compares that echo with the question and
 * refuses a decision for another use, but it cannot verify that the adapter echoed what the owner really returned.
 * Every call asks Privacy again: there is no cache and no time-to-live in this contract.
 */
export interface ProcessingEligibilityGateService extends ProcessingEligibilityGateSettings {
  readonly check: (
    query: ProcessingEligibilityQuery,
  ) => Effect.Effect<ProcessingEligibilityVerdictCase, ProcessingEligibilityUnavailable>;
}

export class ProcessingEligibilityGate extends Context.Service<
  ProcessingEligibilityGate,
  ProcessingEligibilityGateService
>()('@app/communications/domain/privacy/eligibility-gate/ProcessingEligibilityGate') {}

/**
 * The only production composition until the d21-07 composition wires the authorized Privacy client: every check fails
 * closed as an unavailable owner. It is explicit so nothing is ever allowed by default or by a missing adapter.
 */
export const unavailableProcessingEligibilityGateLayer = (settings: ProcessingEligibilityGateSettings) =>
  Layer.succeed(ProcessingEligibilityGate, {
    ...settings,
    check: () => Effect.fail(new ProcessingEligibilityUnavailable({ reason: 'OWNER_UNAVAILABLE' })),
  });
