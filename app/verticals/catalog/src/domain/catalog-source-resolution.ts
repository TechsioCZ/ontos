/**
 * A private, pure decision over already verified Catalog evidence. The caller must
 * obtain target and authority verification from their owners; this module never
 * treats a connector, route, arrival timestamp, or caller's external ID as proof.
 */
import { DateTime, Option } from 'effect';

export interface CatalogFactScope {
  readonly factKey: string;
  readonly targetId: string;
  readonly targetKind: 'PRODUCT' | 'VARIANT' | 'PACKAGE_DEFINITION';
  readonly tenantId: string;
}

export interface CatalogSourceAssertion<Value> {
  readonly assertionId: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly evidencedAt: Date;
  readonly issuerSystemId: string;
  readonly scope: CatalogFactScope;
  readonly sourceRecordId: string;
  readonly sourceRevision: bigint;
  readonly value: Value;
  readonly valueFingerprint: string;
}

export interface CatalogSourceAuthority {
  readonly issuerSystemId: string;
  readonly scope: CatalogFactScope;
  readonly status: 'VERIFIED' | 'UNVERIFIED';
}

export interface CatalogLocalOverride<Value> {
  readonly actorPrincipalId: string;
  readonly evidenceRef: string;
  readonly lifecycle: 'ACTIVE' | 'RELEASED';
  readonly reason: string;
  readonly revision: bigint;
  readonly scope: CatalogFactScope;
  readonly value: Value;
}

/**
 * Caller-verified Catalog ownership, permission, and value validity for one exact fact/scope.
 * The pure decision never infers any of these from an assertion or override record itself.
 */
export interface CatalogFactAdmission {
  readonly assertionAdmission: 'EXTERNAL_SOURCE' | 'NONE';
  readonly factOwnership: 'CATALOG_LOCAL' | 'EXTERNAL_SOURCE' | 'UNKNOWN';
  readonly overridePermitted: boolean;
  readonly overrideValueValid: boolean;
}

export type CatalogAssertionDecision<Value> =
  | { readonly base: CatalogSourceAssertion<Value>; readonly currentChanged: boolean; readonly status: 'ACCEPTED' }
  | { readonly reason: string; readonly status: 'DUPLICATE' | 'STALE' | 'NO_AUTHORITY' | 'INVALID' | 'INDETERMINATE' };

export type CatalogCurrentResolution<Value> =
  | { readonly source: 'BASE' | 'LOCAL_OVERRIDE'; readonly status: 'CURRENT'; readonly value: Value }
  | { readonly reason: string; readonly status: 'ABSENT' | 'INVALID' | 'NO_AUTHORITY' | 'INDETERMINATE' };

/** One import item together with the owner-verified evidence that decides its acceptance. */
export interface CatalogSourceAssertionItem<Value> {
  readonly assertion: CatalogSourceAssertion<Value>;
  readonly authority: CatalogSourceAuthority | null;
  readonly targetVerified: boolean;
  readonly valueValid: boolean;
}

interface CatalogDecisionFailure {
  readonly reason: string;
  readonly status: 'NO_AUTHORITY' | 'INVALID' | 'INDETERMINATE';
}

interface EffectiveWindow {
  readonly from: number;
  readonly to: number | null;
}

type OverrideDecision<Value> =
  | { readonly kind: 'FALL_THROUGH' }
  | { readonly kind: 'RESOLVED'; readonly resolution: CatalogCurrentResolution<Value> };

const hasText = (value: string): boolean => value.trim().length > 0;

const sameScope = (left: CatalogFactScope, right: CatalogFactScope): boolean =>
  left.tenantId === right.tenantId &&
  left.targetKind === right.targetKind &&
  left.targetId === right.targetId &&
  left.factKey === right.factKey;

const hasUsableScope = (scope: CatalogFactScope): boolean =>
  hasText(scope.factKey) && hasText(scope.targetId) && hasText(scope.tenantId);

/** Safe epoch conversion: an unusable Date yields `undefined` instead of throwing. */
const epochOf = (date: Date): number | undefined =>
  Option.getOrUndefined(Option.map(DateTime.make(date), DateTime.toEpochMillis));

const effectiveWindow = (assertion: CatalogSourceAssertion<unknown>): EffectiveWindow | undefined => {
  const from = epochOf(assertion.effectiveFrom);
  if (from === undefined) {
    return undefined;
  }
  if (assertion.effectiveTo === undefined) {
    return { from, to: null };
  }
  const to = epochOf(assertion.effectiveTo);
  return to === undefined || to <= from ? undefined : { from, to };
};

/** A window is well formed whenever it is bounded consistently; a future start is still valid. */
const hasWellFormedEffectivePeriod = (assertion: CatalogSourceAssertion<unknown>, atEpoch: number): boolean => {
  const window = effectiveWindow(assertion);
  return window !== undefined && (window.to === null || atEpoch < window.to);
};

const usableAt = (assertion: CatalogSourceAssertion<unknown>, atEpoch: number): boolean => {
  const window = effectiveWindow(assertion);
  return window !== undefined && window.from <= atEpoch && (window.to === null || atEpoch < window.to);
};

const hasUsableAssertionIdentity = (assertion: CatalogSourceAssertion<unknown>): boolean =>
  hasText(assertion.assertionId) &&
  hasText(assertion.issuerSystemId) &&
  hasText(assertion.sourceRecordId) &&
  hasText(assertion.valueFingerprint) &&
  assertion.sourceRevision >= 0n &&
  hasUsableScope(assertion.scope);

const hasUsableOverrideIdentity = (override: CatalogLocalOverride<unknown>): boolean =>
  hasText(override.actorPrincipalId) &&
  hasText(override.evidenceRef) &&
  hasText(override.reason) &&
  override.revision >= 0n &&
  hasUsableScope(override.scope);

const hasRequiredAssertionEvidence = (assertion: CatalogSourceAssertion<unknown>, atEpoch: number): boolean =>
  hasUsableAssertionIdentity(assertion) && hasWellFormedEffectivePeriod(assertion, atEpoch);

const sameInstant = (left: Date | undefined, right: Date | undefined): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  const leftEpoch = epochOf(left);
  const rightEpoch = epochOf(right);
  return leftEpoch !== undefined && rightEpoch !== undefined && leftEpoch === rightEpoch;
};

const compareAcceptedBase = <Value>(
  assertion: CatalogSourceAssertion<Value>,
  currentBase: CatalogSourceAssertion<Value>,
  valuesEqual: (left: Value, right: Value) => boolean,
): CatalogAssertionDecision<Value> | null => {
  if (!sameScope(currentBase.scope, assertion.scope)) {
    return { reason: 'Existing base belongs to a different fact or Tenant', status: 'INDETERMINATE' };
  }
  if (
    currentBase.issuerSystemId !== assertion.issuerSystemId ||
    currentBase.sourceRecordId !== assertion.sourceRecordId
  ) {
    return { reason: 'Source revisions are not comparable', status: 'INDETERMINATE' };
  }
  if (assertion.sourceRevision === currentBase.sourceRevision) {
    const sameProvenance =
      assertion.assertionId === currentBase.assertionId &&
      assertion.valueFingerprint === currentBase.valueFingerprint &&
      sameInstant(assertion.evidencedAt, currentBase.evidencedAt) &&
      sameInstant(assertion.effectiveFrom, currentBase.effectiveFrom) &&
      sameInstant(assertion.effectiveTo, currentBase.effectiveTo);
    return sameProvenance && valuesEqual(assertion.value, currentBase.value)
      ? { reason: 'The same source assertion was already accepted', status: 'DUPLICATE' }
      : { reason: 'Conflicting assertions share a source revision', status: 'INDETERMINATE' };
  }
  return assertion.sourceRevision < currentBase.sourceRevision
    ? { reason: 'A newer source revision was already accepted', status: 'STALE' }
    : null;
};

/** Only a Catalog-owned, permitted fact with a valid value may ever resolve a Local Override. */
const assessOverrideAdmission = (admission: CatalogFactAdmission | null): CatalogDecisionFailure | null => {
  if (admission === null) {
    return { reason: 'Local Override admission is unavailable', status: 'INDETERMINATE' };
  }
  if (admission.factOwnership !== 'CATALOG_LOCAL') {
    return { reason: 'Local Override may only hold a Catalog-owned fact', status: 'NO_AUTHORITY' };
  }
  if (!admission.overridePermitted) {
    return { reason: 'Local Override requires its own verified fact permission', status: 'NO_AUTHORITY' };
  }
  if (!admission.overrideValueValid) {
    return { reason: 'Local Override value is not valid for the Catalog fact', status: 'INVALID' };
  }
  return null;
};

const assessSourceAuthority = (
  assertion: CatalogSourceAssertion<unknown>,
  authority: CatalogSourceAuthority | null,
  admission: CatalogFactAdmission | null,
): CatalogDecisionFailure | null => {
  if (admission === null) {
    return { reason: 'Catalog fact admission is unavailable', status: 'INDETERMINATE' };
  }
  if (admission.assertionAdmission !== 'EXTERNAL_SOURCE') {
    return { reason: 'This Catalog fact does not admit external source assertions', status: 'NO_AUTHORITY' };
  }
  if (
    authority === null ||
    authority.status !== 'VERIFIED' ||
    !hasText(authority.issuerSystemId) ||
    !hasUsableScope(authority.scope) ||
    authority.issuerSystemId !== assertion.issuerSystemId ||
    !sameScope(assertion.scope, authority.scope)
  ) {
    return { reason: 'Issuer has no verified authority for this exact fact and scope', status: 'NO_AUTHORITY' };
  }
  return null;
};

const assessActiveOverride = <Value>(
  activeOverride: CatalogLocalOverride<Value>,
  admission: CatalogFactAdmission | null,
  scope: CatalogFactScope,
): CatalogDecisionFailure | null => {
  if (
    activeOverride.lifecycle !== 'ACTIVE' ||
    !hasUsableOverrideIdentity(activeOverride) ||
    !sameScope(activeOverride.scope, scope)
  ) {
    return { reason: 'Override state does not match the exact fact', status: 'INDETERMINATE' };
  }
  return assessOverrideAdmission(admission);
};

/** Evaluate one assertion against the latest accepted base for this exact fact. */
export const assessCatalogSourceAssertion = <Value>(input: {
  readonly activeOverride: CatalogLocalOverride<Value> | null;
  readonly admission: CatalogFactAdmission | null;
  readonly assertion: CatalogSourceAssertion<Value>;
  readonly at: Date;
  readonly authority: CatalogSourceAuthority | null;
  readonly currentBase: CatalogSourceAssertion<Value> | null;
  readonly targetVerified: boolean;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
  readonly valueValid: boolean;
}): CatalogAssertionDecision<Value> => {
  const atEpoch = epochOf(input.at);
  if (atEpoch === undefined) {
    return { reason: 'Assessment time is not a valid instant', status: 'INVALID' };
  }
  if (!input.targetVerified) {
    return { reason: 'Exact Catalog target is not verified', status: 'INDETERMINATE' };
  }
  const authorityFailure = assessSourceAuthority(input.assertion, input.authority, input.admission);
  if (authorityFailure !== null) {
    return authorityFailure;
  }
  if (!input.valueValid || !hasRequiredAssertionEvidence(input.assertion, atEpoch)) {
    return { reason: 'Assertion value, provenance, or effective period is invalid', status: 'INVALID' };
  }
  if (input.activeOverride !== null) {
    const overrideFailure = assessActiveOverride(input.activeOverride, input.admission, input.assertion.scope);
    if (overrideFailure !== null) {
      return overrideFailure;
    }
  }
  if (input.currentBase !== null) {
    const compared = compareAcceptedBase(input.assertion, input.currentBase, input.valuesEqual);
    if (compared !== null) {
      return compared;
    }
  }
  return {
    base: input.assertion,
    currentChanged:
      input.activeOverride === null &&
      usableAt(input.assertion, atEpoch) &&
      (input.currentBase === null || !input.valuesEqual(input.assertion.value, input.currentBase.value)),
    status: 'ACCEPTED',
  };
};

/** Each import item gets its own typed result so a batch cannot hide partial rejection. */
export const assessCatalogSourceAssertions = <Value>(input: {
  readonly activeOverride: CatalogLocalOverride<Value> | null;
  readonly admission: CatalogFactAdmission | null;
  readonly at: Date;
  readonly currentBase: CatalogSourceAssertion<Value> | null;
  readonly items: readonly CatalogSourceAssertionItem<Value>[];
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}): readonly CatalogAssertionDecision<Value>[] =>
  input.items.map((item) =>
    assessCatalogSourceAssertion({
      activeOverride: input.activeOverride,
      admission: input.admission,
      assertion: item.assertion,
      at: input.at,
      authority: item.authority,
      currentBase: input.currentBase,
      targetVerified: item.targetVerified,
      valuesEqual: input.valuesEqual,
      valueValid: item.valueValid,
    }),
  );

const latestRevisionOverrides = <Value>(
  overrides: readonly CatalogLocalOverride<Value>[],
): readonly CatalogLocalOverride<Value>[] => {
  let latest: bigint | undefined;
  for (const override of overrides) {
    if (latest === undefined || override.revision > latest) {
      latest = override.revision;
    }
  }
  return latest === undefined ? [] : overrides.filter((override) => override.revision === latest);
};

const decideOverride = <Value>(input: {
  readonly admission: CatalogFactAdmission | null;
  readonly overrides: readonly CatalogLocalOverride<Value>[];
  readonly scope: CatalogFactScope;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}): OverrideDecision<Value> => {
  const scopedOverrides = input.overrides.filter((override) => sameScope(override.scope, input.scope));
  if (scopedOverrides.some((override) => !hasUsableOverrideIdentity(override))) {
    return { kind: 'RESOLVED', resolution: { reason: 'Override decision evidence is incomplete', status: 'INVALID' } };
  }
  const latest = latestRevisionOverrides(scopedOverrides);
  const [latestOverride] = latest;
  if (latestOverride === undefined) {
    return { kind: 'FALL_THROUGH' };
  }
  const conflict =
    latest.length > 1 &&
    !latest.every(
      (override) =>
        override.lifecycle === latestOverride.lifecycle &&
        override.actorPrincipalId === latestOverride.actorPrincipalId &&
        override.reason === latestOverride.reason &&
        override.evidenceRef === latestOverride.evidenceRef &&
        input.valuesEqual(override.value, latestOverride.value),
    );
  if (conflict) {
    return {
      kind: 'RESOLVED',
      resolution: { reason: 'Conflicting overrides share the latest revision', status: 'INDETERMINATE' },
    };
  }
  if (latestOverride.lifecycle !== 'ACTIVE') {
    return { kind: 'FALL_THROUGH' };
  }
  const rejected = assessOverrideAdmission(input.admission);
  return {
    kind: 'RESOLVED',
    resolution: rejected ?? { source: 'LOCAL_OVERRIDE', status: 'CURRENT', value: latestOverride.value },
  };
};

const allSameSource = (bases: readonly CatalogSourceAssertion<unknown>[]): boolean => {
  const [first] = bases;
  return (
    first !== undefined &&
    bases.every((base) => base.issuerSystemId === first.issuerSystemId && base.sourceRecordId === first.sourceRecordId)
  );
};

const newerBase = <Value>(left: CatalogSourceAssertion<Value>, right: CatalogSourceAssertion<Value>): boolean => {
  if (left.sourceRevision !== right.sourceRevision) {
    return left.sourceRevision > right.sourceRevision;
  }
  const leftFrom = epochOf(left.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  const rightFrom = epochOf(right.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  if (leftFrom !== rightFrom) {
    return leftFrom > rightFrom;
  }
  return (
    (epochOf(left.evidencedAt) ?? Number.NEGATIVE_INFINITY) > (epochOf(right.evidencedAt) ?? Number.NEGATIVE_INFINITY)
  );
};

const resolveBase = <Value>(input: {
  readonly acceptedBases: readonly CatalogSourceAssertion<Value>[];
  readonly atEpoch: number;
  readonly scope: CatalogFactScope;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}): CatalogCurrentResolution<Value> => {
  const usableBases = input.acceptedBases.filter(
    (base) =>
      sameScope(base.scope, input.scope) &&
      hasRequiredAssertionEvidence(base, input.atEpoch) &&
      usableAt(base, input.atEpoch),
  );
  const [firstBase, ...remainingBases] = usableBases;
  if (firstBase === undefined) {
    return { reason: 'No usable accepted authoritative base is available', status: 'ABSENT' };
  }
  if (!allSameSource(usableBases)) {
    return { reason: 'Usable accepted bases come from incomparable sources', status: 'INDETERMINATE' };
  }
  let newest = firstBase;
  for (const candidate of remainingBases) {
    if (newerBase(candidate, newest)) {
      newest = candidate;
    }
  }
  const conflicting = usableBases.some(
    (base) =>
      base.sourceRevision === newest.sourceRevision &&
      sameInstant(base.effectiveFrom, newest.effectiveFrom) &&
      !input.valuesEqual(base.value, newest.value),
  );
  return conflicting
    ? { reason: 'Usable accepted bases disagree at the same source revision', status: 'INDETERMINATE' }
    : { source: 'BASE', status: 'CURRENT', value: newest.value };
};

/**
 * Resolve only from accepted base evidence and the one explicit latest override revision.
 * After release (or when no override applies) the newest usable accepted base wins; when none
 * is usable the result is ABSENT, and an incomparable or conflicting base set is INDETERMINATE.
 */
export const resolveCatalogSourceFact = <Value>(input: {
  readonly acceptedBases: readonly CatalogSourceAssertion<Value>[];
  readonly admission: CatalogFactAdmission | null;
  readonly at: Date;
  readonly overrides: readonly CatalogLocalOverride<Value>[];
  readonly scope: CatalogFactScope;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}): CatalogCurrentResolution<Value> => {
  const atEpoch = epochOf(input.at);
  if (atEpoch === undefined) {
    return { reason: 'Resolution time is not a valid instant', status: 'INVALID' };
  }
  if (!hasUsableScope(input.scope)) {
    return { reason: 'Resolution scope is not a qualified Catalog fact', status: 'INVALID' };
  }
  const override = decideOverride({
    admission: input.admission,
    overrides: input.overrides,
    scope: input.scope,
    valuesEqual: input.valuesEqual,
  });
  if (override.kind === 'RESOLVED') {
    return override.resolution;
  }
  return resolveBase({
    acceptedBases: input.acceptedBases,
    atEpoch,
    scope: input.scope,
    valuesEqual: input.valuesEqual,
  });
};
