import { Option, Schema } from 'effect';

import { IntendedProcessingScopeSchema } from './privacy-processing-eligibility.ts';
import type { IntendedProcessingScope } from './privacy-processing-eligibility.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Refs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** The minimization decision is scoped to one intended use, never to a source collection in general. */
export const PrivacyMinimizationDecisionSchema = Schema.Struct({
  allowedDataCategoryRefs: Schema.Array(Ref).check(Schema.isMaxLength(64)),
  decisionRef: Ref,
  evaluatedAt: PrivacyIsoTimestampSchema,
  evaluatedScope: IntendedProcessingScopeSchema,
  legalBasisRef: Ref,
  legalBasisVersion: Ref,
  outcome: Schema.Literals(['ALLOWED', 'NOT_ALLOWED', 'INDETERMINATE']),
  policyRef: Ref,
  policyVersion: Ref,
  reasonCodes: Refs,
  requestedDataCategoryRefs: Refs,
  sourceActivityRef: Schema.OptionFromNullOr(Ref),
});
export type PrivacyMinimizationDecision = typeof PrivacyMinimizationDecisionSchema.Type;

export interface EvaluatePrivacyMinimizationInput {
  readonly asOf: PrivacyMinimizationDecision['evaluatedAt'];
  readonly decisionRef: string;
  readonly intendedScope: IntendedProcessingScope;
  readonly legalBasis: {
    readonly basisRef: string;
    readonly basisVersion: string;
    readonly current: boolean;
  } | null;
  readonly policy: {
    readonly allowedDataCategoryRefs: readonly string[];
    readonly policyRef: string;
    readonly policyVersion: string;
  } | null;
  readonly requestedDataCategoryRefs: readonly string[];
  readonly sourceActivityRef?: string | null;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const policyEvidence = (policy: EvaluatePrivacyMinimizationInput['policy']) => {
  if (policy === null) {
    const allowedDataCategoryRefs: string[] = [];
    return {
      allowedDataCategoryRefs,
      policyRef: 'unresolved',
      policyVersion: 'unresolved',
    };
  }
  return {
    allowedDataCategoryRefs: unique(policy.allowedDataCategoryRefs),
    policyRef: policy.policyRef,
    policyVersion: policy.policyVersion,
  };
};

const legalBasisEvidence = (legalBasis: EvaluatePrivacyMinimizationInput['legalBasis']) => {
  if (legalBasis === null) {
    return { legalBasisRef: 'unresolved', legalBasisVersion: 'unresolved' };
  }
  return { legalBasisRef: legalBasis.basisRef, legalBasisVersion: legalBasis.basisVersion };
};

const minimizationOutcome = (
  input: EvaluatePrivacyMinimizationInput,
  requested: readonly string[],
): Pick<PrivacyMinimizationDecision, 'outcome' | 'reasonCodes'> => {
  if (requested.length === 0) {
    return { outcome: 'NOT_ALLOWED', reasonCodes: ['requested_scope_has_no_data_categories'] };
  }
  if (input.policy === null || input.legalBasis === null) {
    return { outcome: 'INDETERMINATE', reasonCodes: ['minimization_input_unresolved'] };
  }
  if (!input.legalBasis.current) {
    return { outcome: 'INDETERMINATE', reasonCodes: ['legal_basis_not_current'] };
  }
  const allowed = new Set(input.policy.allowedDataCategoryRefs);
  return requested.some((category) => !allowed.has(category))
    ? { outcome: 'NOT_ALLOWED', reasonCodes: ['data_category_exceeds_declared_minimum'] }
    : { outcome: 'ALLOWED', reasonCodes: ['exact_scope_is_minimized'] };
};

const sameScope = (left: IntendedProcessingScope, right: IntendedProcessingScope): boolean =>
  left.controllerRef === right.controllerRef &&
  left.operation === right.operation &&
  left.processingScopeRef.scopeId === right.processingScopeRef.scopeId &&
  left.processingScopeRef.scopeType === right.processingScopeRef.scopeType &&
  left.purposeRef === right.purposeRef &&
  left.purposeVersionId === right.purposeVersionId &&
  unique(left.dataCategoryRefs).length === unique(right.dataCategoryRefs).length &&
  unique(left.dataCategoryRefs).every((value) => new Set(right.dataCategoryRefs).has(value)) &&
  unique(left.recipientRefs).length === unique(right.recipientRefs).length &&
  unique(left.recipientRefs).every((value) => new Set(right.recipientRefs).has(value));

/**
 * Evaluates the exact requested use. A source activity is evidence of provenance only; it
 * cannot provide a legal basis or authorize a broader, different, or newer purpose.
 */
export const evaluatePrivacyMinimization = (input: EvaluatePrivacyMinimizationInput): PrivacyMinimizationDecision => {
  const requested = unique(input.requestedDataCategoryRefs);
  return {
    ...legalBasisEvidence(input.legalBasis),
    ...minimizationOutcome(input, requested),
    ...policyEvidence(input.policy),
    decisionRef: input.decisionRef,
    evaluatedAt: input.asOf,
    evaluatedScope: { ...input.intendedScope, dataCategoryRefs: requested },
    requestedDataCategoryRefs: requested,
    sourceActivityRef: Option.fromNullishOr(input.sourceActivityRef),
  };
};

/** A decision can be applied only when it describes the same exact scope as the consumer request. */
export const isPrivacyMinimizationDecisionForScope = (
  decision: PrivacyMinimizationDecision,
  scope: IntendedProcessingScope,
): boolean => sameScope(decision.evaluatedScope, scope);
