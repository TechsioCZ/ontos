import { ConsentDecisionInvariantError } from './consent-decision-invariant-error.ts';
import { Context, Effect, Schema } from 'effect';

import { PrincipalAttributionSchema, PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { ConsentScopeSchema, validateConsentScope } from './privacy-consent-scope.ts';
import type { ConsentMaterialDimensionKind } from './privacy-consent-scope.ts';
import type { PurposeVersion } from './processing-purpose.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const EvidenceRefs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32));
const OptionalEvidenceRefs = Schema.Array(Ref).check(Schema.isMaxLength(32));

/** Re-granting is a new GRANTED decision; history, never mutation, distinguishes it. */
export const ConsentDecisionKindSchema = Schema.Literals(['GRANTED', 'REFUSED', 'WITHDRAWN']);
export type ConsentDecisionKind = typeof ConsentDecisionKindSchema.Type;

/** An immutable decision fact. Scope and evidence are retained on every revision. */
export const ConsentDecisionSchema = Schema.Struct({
  actorEvidence: Schema.toEncoded(Schema.OptionFromNullOr(PrincipalAttributionSchema)),
  decision: ConsentDecisionKindSchema,
  decisionId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyDecisionId'))),
  effectiveAt: PrivacyIsoTimestampSchema,
  flowEvidenceRefs: OptionalEvidenceRefs,
  flowEvidenceTrust: Schema.optional(Schema.Literal('TRUSTED_OPERATION_CONTEXT')),
  noticeEvidenceRefs: EvidenceRefs,
  provenanceRefs: EvidenceRefs,
  recordedAt: PrivacyIsoTimestampSchema,
  scope: ConsentScopeSchema,
  /** Public Action retries carry the same key; it is not business ordering. */
  idempotencyKey: Schema.toEncoded(Schema.optional(Ref).pipe(Schema.brand('PrivacyIdempotencyKey'))),
});
export type ConsentDecision = typeof ConsentDecisionSchema.Type;

/** Validates explicit decisions without deriving consent from a Notice or Terms fact. */
// fallow-ignore-next-line complexity -- Consent acceptance deliberately enumerates provenance, timing, scope, and decision-specific invariants.
export const validateConsentDecision = (
  input: ConsentDecision,
  purposeVersion?: PurposeVersion,
  requiredDimensions?: readonly ConsentMaterialDimensionKind[],
): string | undefined => {
  if (input.recordedAt < input.effectiveAt) {
    return 'Recorded time cannot precede effective time';
  }
  if (input.provenanceRefs.length === 0) {
    return 'Consent Decision requires provenance evidence';
  }
  if (input.noticeEvidenceRefs.length === 0) {
    return 'Consent Decision requires notice evidence';
  }
  const hasSafeFlowEvidence =
    input.flowEvidenceRefs.length > 0 && input.flowEvidenceTrust === 'TRUSTED_OPERATION_CONTEXT';
  if (input.actorEvidence === null && !hasSafeFlowEvidence) {
    return 'Consent Decision requires actor evidence or trusted flow evidence';
  }
  const scope =
    purposeVersion === undefined
      ? validateConsentScope({ scope: input.scope })
      : validateConsentScope({
          purposeVersion,
          requiredDimensions: requiredDimensions ?? purposeVersion.requiredConsentDimensions ?? [],
          scope: input.scope,
        });
  if (!scope.valid) {
    return scope.errors[0];
  }
  if (input.actorEvidence !== null) {
    const { actor } = input.actorEvidence;
    if (actor.tenantId !== input.scope.privacySubjectRef.tenantId) {
      return 'Decision actor and consent scope must share a tenant';
    }
  }
  return undefined;
};

const decisionOrder = (decision: ConsentDecision): string =>
  `${decision.effectiveAt}\u0000${decision.recordedAt}\u0000${decision.decisionId}`;
const compareDecisions = (left: ConsentDecision, right: ConsentDecision): number =>
  decisionOrder(left).localeCompare(decisionOrder(right));

/** In-memory append-only decision store used by the domain and contract tests. */
export interface ConsentDecisionStore {
  readonly current: (scopeRef: string) => ConsentCurrentResolution;
  readonly currentResolution: (scopeRef: string) => ConsentCurrentResolution;
  readonly history: (scopeRef: string) => readonly ConsentDecision[];
  readonly record: (
    decision: ConsentDecision,
    purposeVersion?: PurposeVersion,
  ) => Effect.Effect<ConsentDecision, ConsentDecisionInvariantError>;
}

/** Owner-local service contract; scope is supplied by its transaction factory. */
export class ConsentDecisionStoreTag extends Context.Service<ConsentDecisionStoreTag, ConsentDecisionStore>()(
  '@app/privacy/shared/domain/privacy-consent-decision/ConsentDecisionStoreTag',
) {}

export type ConsentCurrentResolution =
  | { readonly decision: ConsentDecision; readonly outcome: 'CURRENT' }
  | { readonly outcome: 'ABSENT' }
  | {
      readonly decisions: readonly ConsentDecision[];
      readonly outcome: 'CONFLICT';
      readonly reason: 'SAME_EFFECTIVE_TIME';
    };

const decisionsAreEquivalent = Schema.toEquivalence(ConsentDecisionSchema);
const consentScopesAreEquivalent = Schema.toEquivalence(ConsentScopeSchema);

export { ConsentDecisionInvariantError } from './consent-decision-invariant-error.ts';

const resolveCurrentConsent = (decisions: readonly ConsentDecision[], scopeRef: string): ConsentCurrentResolution => {
  const history = decisions.filter(({ scope }) => scope.scopeRef === scopeRef);
  if (history.length === 0) {
    return { outcome: 'ABSENT' };
  }
  const latestEffectiveAt = history.toSorted(compareDecisions).at(-1)?.effectiveAt;
  if (latestEffectiveAt === undefined) {
    return { outcome: 'ABSENT' };
  }
  const latest = history.filter(({ effectiveAt }) => effectiveAt === latestEffectiveAt);
  const [first] = latest;
  if (
    first === undefined ||
    latest.some(
      (candidate) => candidate.decision !== first.decision || !consentScopesAreEquivalent(candidate.scope, first.scope),
    )
  ) {
    return {
      decisions: latest.toSorted(compareDecisions),
      outcome: 'CONFLICT',
      reason: 'SAME_EFFECTIVE_TIME',
    };
  }
  return { decision: first, outcome: 'CURRENT' };
};

export const makeConsentDecisionStore = (): ConsentDecisionStore => {
  const decisions: ConsentDecision[] = [];
  const byIdempotencyKey = new Map<string, ConsentDecision>();
  return ConsentDecisionStoreTag.of({
    current: (scopeRef) => resolveCurrentConsent(decisions, scopeRef),
    currentResolution: (scopeRef) => resolveCurrentConsent(decisions, scopeRef),
    history: (scopeRef) => decisions.filter(({ scope }) => scope.scopeRef === scopeRef).toSorted(compareDecisions),
    record: (decision, purposeVersion) => {
      const error = validateConsentDecision(decision, purposeVersion);
      if (error !== undefined) {
        return Effect.fail(new ConsentDecisionInvariantError({ reason: error }));
      }
      if (decision.idempotencyKey !== undefined) {
        const existing = byIdempotencyKey.get(decision.idempotencyKey);
        if (existing !== undefined) {
          if (decisionsAreEquivalent(existing, decision)) {
            return Effect.succeed(existing);
          }
          return Effect.fail(new ConsentDecisionInvariantError({ reason: 'Consent Decision idempotency conflict' }));
        }
      }
      const existingById = decisions.find(({ decisionId }) => decisionId === decision.decisionId);
      if (existingById !== undefined) {
        if (decisionsAreEquivalent(existingById, decision)) {
          return Effect.succeed(existingById);
        }
        return Effect.fail(new ConsentDecisionInvariantError({ reason: 'Consent Decision identity conflict' }));
      }
      const retained = Object.freeze({ ...decision });
      decisions.push(retained);
      if (decision.idempotencyKey !== undefined) {
        byIdempotencyKey.set(decision.idempotencyKey, retained);
      }
      return Effect.succeed(retained);
    },
  });
};
