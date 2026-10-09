import { Schema } from 'effect';

import { CatalogResourceRefSchema } from './catalog-revision-reference.ts';
import type { CatalogResourceRef } from './catalog-revision-reference.ts';
import {
  CatalogExternalSourceRecordRefSchema,
  sameCatalogExternalSourceRecord,
} from './external-identifier-boundary.ts';

/**
 * The exact Catalog resource kinds an external record may address. An external system ID is never
 * one of these and never becomes Product identity or a SKU; it can only help point at one.
 */
export const CatalogExternalTargetKindSchema = Schema.Literals(['PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION']);
export type CatalogExternalTargetKind = typeof CatalogExternalTargetKindSchema.Type;

const targetKindByResourceType = new Map<string, CatalogExternalTargetKind>([
  ['commerce.catalog.package-definition', 'PACKAGE_DEFINITION'],
  ['commerce.catalog.product', 'PRODUCT'],
  ['commerce.catalog.variant', 'VARIANT'],
]);

/** Resolve the declared Catalog kind from a target resource type; unknown types address nothing. */
export const catalogExternalTargetKindForResourceType = (resourceType: string): CatalogExternalTargetKind | undefined =>
  targetKindByResourceType.get(resourceType);

/**
 * One external record an importer wants to resolve together with the meaning the publishing source
 * assigns to that record. The resolved target kind must equal this declared meaning, so a
 * Product-level record is never silently widened to every sibling Variant.
 */
export const CatalogExternalTargetRequestSchema = Schema.Struct({
  recordMeaning: CatalogExternalTargetKindSchema,
  sourceRecord: CatalogExternalSourceRecordRefSchema,
});
export type CatalogExternalTargetRequest = typeof CatalogExternalTargetRequestSchema.Type;

const correlationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogExternalCorrelationId'),
);

const ruleId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogExternalDeterministicRuleId'),
);

export const CatalogExternalCorrelationStateSchema = Schema.Literals(['CONFIRMED', 'DISPUTED', 'RETRACTED']);
export type CatalogExternalCorrelationState = typeof CatalogExternalCorrelationStateSchema.Type;

/**
 * A correlation retained and owned by the owner-local Connector Registry. Catalog only reads this
 * evidence; it never creates, owns, or stores a competing copy.
 */
export const CatalogExternalCorrelationSchema = Schema.Struct({
  correlationId,
  declaredTargetKind: CatalogExternalTargetKindSchema,
  sourceRecord: CatalogExternalSourceRecordRefSchema,
  state: CatalogExternalCorrelationStateSchema,
  target: CatalogResourceRefSchema,
});
export type CatalogExternalCorrelation = typeof CatalogExternalCorrelationSchema.Type;

/** A deterministic rule may only match on an explicitly recognised business code, never a name. */
export const CatalogExternalDeterministicMatchKindSchema = Schema.Literals(['SKU', 'GTIN']);
export type CatalogExternalDeterministicMatchKind = typeof CatalogExternalDeterministicMatchKindSchema.Type;

/**
 * A rule pre-approved for one exact source and record meaning. Only the listed match kinds are
 * recognised as unambiguous for this source; name similarity is deliberately not representable.
 */
export const CatalogExternalDeterministicRuleSchema = Schema.Struct({
  acceptedMatchKinds: Schema.Array(CatalogExternalDeterministicMatchKindSchema),
  issuerId: CatalogExternalSourceRecordRefSchema.fields.issuerId,
  issuerKind: CatalogExternalSourceRecordRefSchema.fields.issuerKind,
  recordMeaning: CatalogExternalTargetKindSchema,
  recordNamespace: CatalogExternalSourceRecordRefSchema.fields.recordNamespace,
  ruleId,
});
export type CatalogExternalDeterministicRule = typeof CatalogExternalDeterministicRuleSchema.Type;

/** Trustworthy evidence a pre-approved rule may use; it must collapse to exactly one target. */
export const CatalogExternalDeterministicCandidateSchema = Schema.Struct({
  matchedBy: CatalogExternalDeterministicMatchKindSchema,
  matchValue: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240), Schema.isTrimmed()),
  target: CatalogResourceRefSchema,
});
export type CatalogExternalDeterministicCandidate = typeof CatalogExternalDeterministicCandidateSchema.Type;

/** A resolved target is an address only. It never carries authority over any Catalog fact. */
export type CatalogResolvedExternalTarget =
  | {
      readonly capture: 'ALREADY_OWNER_CONFIRMED';
      readonly correlationRef: string;
      readonly factAuthority: 'TARGET_ONLY';
      readonly source: 'OWNER_CORRELATION';
      readonly status: 'RESOLVED';
      readonly target: CatalogResourceRef;
      readonly targetKind: CatalogExternalTargetKind;
    }
  | {
      readonly capture: 'REQUIRED_BEFORE_ACCEPTANCE';
      readonly factAuthority: 'TARGET_ONLY';
      readonly ruleId: string;
      readonly source: 'PRE_APPROVED_RULE';
      readonly status: 'RESOLVED';
      readonly target: CatalogResourceRef;
      readonly targetKind: CatalogExternalTargetKind;
    };

/** Every unresolved outcome is explicit; none of them permits overwriting or auto-creating. */
export type CatalogUnresolvedExternalTarget =
  | { readonly reason: string; readonly status: 'MISSING_LINK' }
  | { readonly candidates: readonly CatalogResourceRef[]; readonly reason: string; readonly status: 'AMBIGUOUS' }
  | { readonly reason: string; readonly status: 'TARGET_TYPE_MISMATCH' }
  | { readonly reason: string; readonly status: 'UNVERIFIABLE' }
  | { readonly reason: string; readonly status: 'INVALID' };

export type CatalogExternalTargetResolution = CatalogResolvedExternalTarget | CatalogUnresolvedExternalTarget;

export interface CatalogExternalTargetResolutionInput {
  readonly correlations: readonly CatalogExternalCorrelation[];
  readonly deterministicCandidates?: readonly CatalogExternalDeterministicCandidate[];
  readonly deterministicRules?: readonly CatalogExternalDeterministicRule[];
  readonly request: CatalogExternalTargetRequest;
}

const targetKey = (target: CatalogResourceRef): string =>
  `${target.tenantId}:${target.resourceType}:${target.resourceId}`;

const distinctTargets = (targets: readonly CatalogResourceRef[]): readonly CatalogResourceRef[] => {
  const seen = new Set<string>();
  const unique: CatalogResourceRef[] = [];
  for (const target of targets) {
    const key = targetKey(target);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(target);
    }
  }
  return unique;
};

const hasUsableRequest = (request: CatalogExternalTargetRequest): boolean =>
  request.sourceRecord.tenantId.length > 0 &&
  request.sourceRecord.issuerId.length > 0 &&
  request.sourceRecord.recordId.length > 0 &&
  request.sourceRecord.recordNamespace.length > 0;

const resolveFromCorrelations = (
  matching: readonly CatalogExternalCorrelation[],
  request: CatalogExternalTargetRequest,
): CatalogExternalTargetResolution | undefined => {
  const confirmed = matching.filter((correlation) => correlation.state === 'CONFIRMED');
  if (confirmed.length === 0) {
    if (matching.length === 0) {
      return undefined;
    }
    return matching.some((correlation) => correlation.state === 'DISPUTED')
      ? { reason: 'A correlation for this exact source record is disputed', status: 'UNVERIFIABLE' }
      : undefined;
  }
  for (const correlation of confirmed) {
    if (correlation.target.tenantId !== request.sourceRecord.tenantId) {
      return { reason: 'A confirmed correlation crosses Tenant scope', status: 'UNVERIFIABLE' };
    }
    const kind = catalogExternalTargetKindForResourceType(correlation.target.resourceType);
    if (kind === undefined || kind !== correlation.declaredTargetKind) {
      return { reason: 'A Connector Registry correlation type is internally inconsistent', status: 'UNVERIFIABLE' };
    }
  }
  const targets = distinctTargets(confirmed.map((correlation) => correlation.target));
  if (targets.length > 1) {
    return {
      candidates: targets,
      reason: 'More than one Catalog target is confirmed for this exact source record',
      status: 'AMBIGUOUS',
    };
  }
  const [target] = targets;
  if (target === undefined) {
    return { reason: 'The Connector Registry returned no usable target', status: 'UNVERIFIABLE' };
  }
  const kind = catalogExternalTargetKindForResourceType(target.resourceType);
  if (kind === undefined || kind !== request.recordMeaning) {
    return {
      reason: 'The confirmed target kind does not match the meaning of the source record',
      status: 'TARGET_TYPE_MISMATCH',
    };
  }
  const correlation = confirmed.find((claim) => targetKey(claim.target) === targetKey(target));
  if (correlation === undefined) {
    return { reason: 'The Connector Registry returned no usable target', status: 'UNVERIFIABLE' };
  }
  return {
    capture: 'ALREADY_OWNER_CONFIRMED',
    correlationRef: correlation.correlationId,
    factAuthority: 'TARGET_ONLY',
    source: 'OWNER_CORRELATION',
    status: 'RESOLVED',
    target,
    targetKind: kind,
  };
};

const resolveFromRules = (input: CatalogExternalTargetResolutionInput): CatalogExternalTargetResolution => {
  const { request } = input;
  const applicable = (input.deterministicRules ?? []).filter(
    (rule) =>
      rule.issuerId === request.sourceRecord.issuerId &&
      rule.issuerKind === request.sourceRecord.issuerKind &&
      rule.recordNamespace === request.sourceRecord.recordNamespace &&
      rule.recordMeaning === request.recordMeaning,
  );
  if (applicable.length === 0) {
    return {
      reason: 'No confirmed correlation or pre-approved rule addresses this exact source record',
      status: 'MISSING_LINK',
    };
  }
  if (applicable.length > 1) {
    return { reason: 'More than one pre-approved rule addresses this exact source record', status: 'UNVERIFIABLE' };
  }
  const [rule] = applicable;
  if (rule === undefined) {
    return {
      reason: 'No confirmed correlation or pre-approved rule addresses this exact source record',
      status: 'MISSING_LINK',
    };
  }
  const acceptedMatchKinds = new Set(rule.acceptedMatchKinds);
  const candidates = (input.deterministicCandidates ?? []).filter(
    (candidate) =>
      candidate.matchValue.length > 0 &&
      candidate.target.tenantId === request.sourceRecord.tenantId &&
      acceptedMatchKinds.has(candidate.matchedBy) &&
      catalogExternalTargetKindForResourceType(candidate.target.resourceType) === rule.recordMeaning,
  );
  const targets = distinctTargets(candidates.map((candidate) => candidate.target));
  if (targets.length === 0) {
    return { reason: 'The pre-approved rule found no exact target', status: 'MISSING_LINK' };
  }
  if (targets.length > 1) {
    return {
      candidates: targets,
      reason: 'The pre-approved rule is ambiguous for this exact source record',
      status: 'AMBIGUOUS',
    };
  }
  const [target] = targets;
  if (target === undefined) {
    return { reason: 'The pre-approved rule found no exact target', status: 'MISSING_LINK' };
  }
  const kind = catalogExternalTargetKindForResourceType(target.resourceType);
  if (kind === undefined || kind !== request.recordMeaning) {
    return {
      reason: 'The rule target kind does not match the meaning of the source record',
      status: 'TARGET_TYPE_MISMATCH',
    };
  }
  return {
    capture: 'REQUIRED_BEFORE_ACCEPTANCE',
    factAuthority: 'TARGET_ONLY',
    ruleId: rule.ruleId,
    source: 'PRE_APPROVED_RULE',
    status: 'RESOLVED',
    target,
    targetKind: kind,
  };
};

/**
 * Resolve the exact Catalog addressee for one external source record. Only a confirmed,
 * unambiguous, usable owner correlation or a pre-approved deterministic rule can resolve; the
 * function never merges equal literals from different issuers, namespaces, or Tenants.
 */
export const resolveCatalogExternalTarget = (
  input: CatalogExternalTargetResolutionInput,
): CatalogExternalTargetResolution => {
  const { request } = input;
  if (!hasUsableRequest(request)) {
    return { reason: 'Source record and record meaning are required', status: 'INVALID' };
  }
  const matching = input.correlations.filter((correlation) =>
    sameCatalogExternalSourceRecord(correlation.sourceRecord, request.sourceRecord),
  );
  const fromCorrelations = resolveFromCorrelations(matching, request);
  return fromCorrelations ?? resolveFromRules(input);
};

export type CatalogExternalCorrelationCaptureDecision =
  | { readonly correlationRef: string; readonly status: 'ALREADY_CAPTURED' }
  | { readonly correlationRef: string; readonly status: 'CAPTURE_REQUIRED' }
  | { readonly reason: string; readonly status: 'CONFLICT' }
  | { readonly reason: string; readonly status: 'UNVERIFIABLE' }
  | { readonly reason: string; readonly status: 'INVALID' };

/**
 * Decide whether a new safe assignment may be captured at the correlation owner. Capture must
 * happen before dependent external facts are accepted; a concurrent conflicting correlation or an
 * unavailable owner demands explicit remediation, never a second independent copy.
 */
export const assessCatalogExternalCorrelationCapture = (input: {
  readonly existing: readonly CatalogExternalCorrelation[];
  readonly proposed: CatalogExternalCorrelation;
  readonly registry: 'AVAILABLE' | 'UNAVAILABLE';
  readonly request: CatalogExternalTargetRequest;
}): CatalogExternalCorrelationCaptureDecision => {
  if (input.registry === 'UNAVAILABLE') {
    return { reason: 'The Connector Registry owner is unavailable', status: 'UNVERIFIABLE' };
  }
  const { proposed, request } = input;
  if (proposed.state !== 'CONFIRMED') {
    return { reason: 'Only a confirmed assignment can be captured', status: 'INVALID' };
  }
  if (
    proposed.target.tenantId !== request.sourceRecord.tenantId ||
    !sameCatalogExternalSourceRecord(proposed.sourceRecord, request.sourceRecord)
  ) {
    return { reason: 'The proposed correlation does not match the exact source record and Tenant', status: 'INVALID' };
  }
  const kind = catalogExternalTargetKindForResourceType(proposed.target.resourceType);
  if (kind === undefined || kind !== proposed.declaredTargetKind || kind !== request.recordMeaning) {
    return { reason: 'The proposed correlation kind does not match the source record meaning', status: 'INVALID' };
  }
  const sameSource = input.existing.filter((correlation) =>
    sameCatalogExternalSourceRecord(correlation.sourceRecord, request.sourceRecord),
  );
  const identical = sameSource.find((correlation) => correlation.correlationId === proposed.correlationId);
  if (identical !== undefined) {
    return identical.state === 'CONFIRMED' && targetKey(identical.target) === targetKey(proposed.target)
      ? { correlationRef: identical.correlationId, status: 'ALREADY_CAPTURED' }
      : { reason: 'The correlation reference already exists with different content', status: 'CONFLICT' };
  }
  const competing = sameSource.filter((correlation) => correlation.correlationId !== proposed.correlationId);
  if (competing.some((correlation) => correlation.state === 'DISPUTED')) {
    return { reason: 'A concurrent correlation for this source record is disputed', status: 'CONFLICT' };
  }
  const confirmed = competing.filter((correlation) => correlation.state === 'CONFIRMED');
  if (confirmed.some((correlation) => targetKey(correlation.target) !== targetKey(proposed.target))) {
    return { reason: 'Another confirmed correlation already assigns this source record', status: 'CONFLICT' };
  }
  const captured = confirmed.find((correlation) => targetKey(correlation.target) === targetKey(proposed.target));
  return captured === undefined
    ? { correlationRef: proposed.correlationId, status: 'CAPTURE_REQUIRED' }
    : { correlationRef: captured.correlationId, status: 'ALREADY_CAPTURED' };
};

export const CatalogExternalFactOwnershipSchema = Schema.Literals(['CATALOG_LOCAL', 'EXTERNAL_SOURCE']);
export type CatalogExternalFactOwnership = typeof CatalogExternalFactOwnershipSchema.Type;

/** Supplied by the #481 fact-authority assessment; #422 never derives it from a correlation. */
export const CatalogExternalSourceAuthoritySchema = Schema.Literals(['VERIFIED', 'UNVERIFIED', 'ABSENT']);
export type CatalogExternalSourceAuthority = typeof CatalogExternalSourceAuthoritySchema.Type;

export type CatalogExternalFactAdmission =
  | { readonly factKey: string; readonly status: 'ADMISSIBLE'; readonly target: CatalogResourceRef }
  | { readonly factKey: string; readonly reason: string; readonly status: 'HELD' };

/**
 * Gate one dependent external fact on a resolved address, an owner-captured new assignment, the
 * fact's own local ownership, and the separately assessed source authority. A correct correlation
 * alone can never admit a fact that Catalog owns locally or that the source has no authority over.
 */
export const assessCatalogExternalFactAdmission = (input: {
  readonly captureConfirmed: boolean;
  readonly fact: {
    readonly factKey: string;
    readonly ownership: CatalogExternalFactOwnership;
    readonly target: CatalogResourceRef;
  };
  readonly resolution: CatalogExternalTargetResolution;
  readonly sourceAuthority: CatalogExternalSourceAuthority;
}): CatalogExternalFactAdmission => {
  const { fact, resolution } = input;
  if (resolution.status !== 'RESOLVED') {
    return { factKey: fact.factKey, reason: resolution.status, status: 'HELD' };
  }
  if (resolution.capture === 'REQUIRED_BEFORE_ACCEPTANCE' && !input.captureConfirmed) {
    return { factKey: fact.factKey, reason: 'CORRELATION_NOT_CAPTURED', status: 'HELD' };
  }
  if (fact.ownership === 'CATALOG_LOCAL') {
    return { factKey: fact.factKey, reason: 'LOCALLY_OWNED_FACT', status: 'HELD' };
  }
  if (targetKey(fact.target) !== targetKey(resolution.target)) {
    return { factKey: fact.factKey, reason: 'TARGET_MISMATCH', status: 'HELD' };
  }
  if (input.sourceAuthority !== 'VERIFIED') {
    return { factKey: fact.factKey, reason: 'NO_SOURCE_AUTHORITY', status: 'HELD' };
  }
  return { factKey: fact.factKey, status: 'ADMISSIBLE', target: resolution.target };
};
