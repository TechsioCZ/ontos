import { DateTime, Option } from 'effect';

import type {
  TaxSourceConflictKind,
  TaxSourceEligibility,
  TaxSourceRegistrationMeaning,
} from '../../shared/actions/tax-source-assertion.ts';
import type {
  TaxFactAuthorityOutcome,
  TaxSourceRegistrationResolutionReason,
} from '../../shared/domain/tax-source-read-contracts.ts';
import type { SellingLegalEntityVatRegistrationState } from './selling-legal-entity-vat-registration.ts';
import { evaluateTaxSourceAuthority } from './tax-source-acceptance.ts';
import type { TaxSourceAcceptance, TaxSourceAuthority } from './tax-source-acceptance.ts';

/** An authority contract revision with its half-open authority period `[authorityFrom, authorityTo)`. */
export interface TaxSourceAuthorityPeriod extends TaxSourceAuthority {
  readonly authorityFrom: DateTime.Utc;
  readonly authorityTo: Option.Option<DateTime.Utc>;
}

/**
 * One assertion whose stored eligibility is `ELIGIBLE`. It carries no authority role: the role is evaluated at each
 * business instant from the contract revision covering it, never frozen at recording time (#959 F1, F8, F25).
 * Arrival time is deliberately absent (#958 F19).
 */
export interface EligibleTaxSourceAssertion {
  readonly assertionId: string;
  readonly registrationMeaning: TaxSourceRegistrationMeaning;
  readonly sourceRef: string;
  readonly validFrom: Option.Option<DateTime.Utc>;
  readonly validTo: Option.Option<DateTime.Utc>;
}

/** The complete owner set for one seller and fact family; absence of rows is never authoritative absence. */
export interface CompleteSellingLegalEntityVatRegistrationState {
  readonly authorities: readonly TaxSourceAuthorityPeriod[];
  readonly eligibleAssertions: readonly EligibleTaxSourceAssertion[];
}

export interface SellingLegalEntityVatRegistrationResolution {
  readonly authority: Readonly<{
    outcome: TaxFactAuthorityOutcome;
    systemOfRecord: Option.Option<TaxSourceAuthorityPeriod>;
  }>;
  /** Authoritative assertions the state was derived from, ordered by identity. */
  readonly basisAssertionIds: readonly string[];
  /** Evidence-role assertions contradicting the state at the instant; they never change it (#959 F10, F27). */
  readonly evidenceDisagreementIds: readonly string[];
  readonly reason: TaxSourceRegistrationResolutionReason;
  readonly state: Exclude<SellingLegalEntityVatRegistrationState, 'UNAVAILABLE'>;
}

/** Business claim of one assertion: its polarity over a half-open validity period. */
export interface TaxSourceClaim {
  readonly from: Option.Option<DateTime.Utc>;
  readonly polarity: 'NEGATIVE' | 'POSITIVE';
  readonly to: Option.Option<DateTime.Utc>;
}

/**
 * `REGISTERED` claims registration over `[validFrom, validTo)` and asserts nothing after an end; `NON_REGISTERED`
 * claims absence of registration over `[validFrom, validTo)`; `ENDED` claims the registration ended at `validTo`
 * and is negative from then on. A claim missing its required validity has no business meaning (#958 F26).
 */
export const taxSourceClaim = (
  assertion: Pick<EligibleTaxSourceAssertion, 'registrationMeaning' | 'validFrom' | 'validTo'>,
): Option.Option<TaxSourceClaim> => {
  if (assertion.registrationMeaning === 'ENDED') {
    return assertion.validTo.pipe(
      Option.map((endedAt) => ({ from: Option.some(endedAt), polarity: 'NEGATIVE' as const, to: Option.none() })),
    );
  }
  const polarity = assertion.registrationMeaning === 'REGISTERED' ? 'POSITIVE' : 'NEGATIVE';
  return assertion.validFrom.pipe(Option.map((from) => ({ from: Option.some(from), polarity, to: assertion.validTo })));
};

const startsBefore = (start: Option.Option<DateTime.Utc>, end: Option.Option<DateTime.Utc>): boolean =>
  Option.isNone(start) || Option.isNone(end) || DateTime.isLessThan(start.value, end.value);

/** Half-open membership: a period starting at the instant covers it, one ending there does not. */
export const periodCoversInstant = (
  from: Option.Option<DateTime.Utc>,
  to: Option.Option<DateTime.Utc>,
  at: DateTime.Utc,
): boolean =>
  (Option.isNone(from) || DateTime.isLessThanOrEqualTo(from.value, at)) &&
  (Option.isNone(to) || DateTime.isLessThan(at, to.value));

/** Two claims contradict when their polarity differs over a shared business instant. */
export const taxSourceClaimsContradict = (left: TaxSourceClaim, right: TaxSourceClaim): boolean =>
  left.polarity !== right.polarity && startsBefore(left.from, right.to) && startsBefore(right.from, left.to);

const byText = (left: string, right: string) => left.localeCompare(right, 'en');

/** Contract revisions whose half-open authority period covers the instant, in a stable order and never ranked. */
export const authoritiesCoveringInstant = <Authority extends TaxSourceAuthorityPeriod>(
  authorities: readonly Authority[],
  at: DateTime.Utc,
): readonly Authority[] =>
  authorities
    .filter((authority) => periodCoversInstant(Option.some(authority.authorityFrom), authority.authorityTo, at))
    .toSorted((left, right) => byText(left.contractId, right.contractId));

/** Role of a source under the single System of Record covering an instant; `NONE` when it has no role there. */
const roleUnder = (authority: TaxSourceAuthority, sourceRef: string) =>
  evaluateTaxSourceAuthority({ authoritiesAtInstant: [authority], sourceRef }).role;

/** Combines two optional bounds; an absent bound is unbounded and yields to the other one. */
const bound =
  (pick: (left: DateTime.Utc, right: DateTime.Utc) => DateTime.Utc) =>
  (left: Option.Option<DateTime.Utc>, right: Option.Option<DateTime.Utc>): Option.Option<DateTime.Utc> =>
    Option.match(left, {
      onNone: () => right,
      onSome: (leftValue) =>
        Option.some(
          Option.match(right, { onNone: () => leftValue, onSome: (rightValue) => pick(leftValue, rightValue) }),
        ),
    });
const latest = bound(DateTime.max);
const earliest = bound(DateTime.min);

/** Instants starting a segment of constant authority coverage inside `[from, to)`; evaluating each is exhaustive. */
const coverageSegmentStarts = (
  from: Option.Option<DateTime.Utc>,
  to: Option.Option<DateTime.Utc>,
  authorities: readonly TaxSourceAuthorityPeriod[],
): readonly DateTime.Utc[] =>
  [
    ...Option.toArray(from),
    ...authorities.flatMap((authority) => [authority.authorityFrom, ...Option.toArray(authority.authorityTo)]),
  ].filter((instant) => periodCoversInstant(from, to, instant));

/**
 * Whether two contradicting claims are a TAX conflict, judged only where they overlap AND exactly one System of
 * Record covers the instant, with each source's role under THAT revision (#959 F1-F2, F10-F11, F25). Both claims
 * from the System of Record of the instant are incompatible authoritative assertions (#925 F25); the System of
 * Record against a listed evidence source is an explicit disagreement (#959 F10-F11, F27). A source outside its
 * authority window (superseded System of Record, delisted evidence) and instants under an authority gap or
 * configuration conflict never create one. Authority boundaries split the overlap into segments of constant
 * coverage, so evaluating each segment start is exhaustive.
 */
export const taxSourceContradiction = (
  left: EligibleTaxSourceAssertion,
  right: EligibleTaxSourceAssertion,
  authorities: readonly TaxSourceAuthorityPeriod[],
): Option.Option<TaxSourceConflictKind> => {
  const leftClaim = taxSourceClaim(left);
  const rightClaim = taxSourceClaim(right);
  if (Option.isNone(leftClaim) || Option.isNone(rightClaim)) {
    return Option.none();
  }
  if (!taxSourceClaimsContradict(leftClaim.value, rightClaim.value)) {
    return Option.none();
  }
  const from = latest(leftClaim.value.from, rightClaim.value.from);
  const to = earliest(leftClaim.value.to, rightClaim.value.to);
  const kinds = coverageSegmentStarts(from, to, authorities).flatMap((instant): TaxSourceConflictKind[] => {
    const [systemOfRecord, ...competing] = authoritiesCoveringInstant(authorities, instant);
    if (systemOfRecord === undefined || competing.length > 0) {
      return [];
    }
    const roles = [roleUnder(systemOfRecord, left.sourceRef), roleUnder(systemOfRecord, right.sourceRef)];
    if (roles.every((role) => role === 'SYSTEM_OF_RECORD')) {
      return ['INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS'];
    }
    return roles.includes('SYSTEM_OF_RECORD') && roles.includes('EVIDENCE') ? ['EVIDENCE_DISAGREEMENT'] : [];
  });
  // One pair is either the same source (only ever incompatible) or two sources (only ever a disagreement).
  return Option.fromUndefinedOr(kinds.toSorted(byText).at(0));
};

/** Per-segment authority of a source over one claim: the covering revisions and the decision at the segment start. */
const claimedSegmentAuthorities = (
  claim: TaxSourceClaim,
  sourceRef: string,
  authorities: readonly TaxSourceAuthorityPeriod[],
) =>
  coverageSegmentStarts(claim.from, claim.to, authorities).map((instant) => {
    const covering = authoritiesCoveringInstant(authorities, instant);
    return { covering, decision: evaluateTaxSourceAuthority({ authoritiesAtInstant: covering, sourceRef }) };
  });

type TaxSourceAcceptanceInput = Pick<
  EligibleTaxSourceAssertion,
  'registrationMeaning' | 'sourceRef' | 'validFrom' | 'validTo'
> &
  Readonly<{ eligibility: TaxSourceEligibility }>;

/** Precedence of per-instant authority outcomes when one claim spans several coverage segments. */
const acceptancePrecedence = {
  ACCEPTED: 0,
  NEEDS_REVIEW: 1,
  REJECTED: 2,
  UNVERIFIABLE: 3,
} as const satisfies Readonly<Record<TaxSourceAcceptance['outcome'], number>>;

/**
 * #957 source acceptance of one assertion, evaluated over its OWN claimed business validity under the given contract
 * revisions (#957 H, F12, F25-F29). Authority is judged per business instant (#959 F1, F8, F25): `ACCEPTED` when the
 * source is the System of Record or listed evidence under the revision covering some claimed instant, so an
 * assertion recorded before its contract or late after a handoff is accepted for the instants its source has a role;
 * otherwise `NEEDS_REVIEW`/`AUTHORITY_CONFIGURATION_CONFLICT` when competing revisions cover a claimed instant and
 * the source has a role under one of them (its permission there is undecidable); otherwise `REJECTED`/`SOURCE_NOT_PERMITTED` when a revision covers the
 * claim but never permits the source; otherwise `UNVERIFIABLE`/`AUTHORITY_MISSING`. An ineligible assertion has no
 * claim and is `UNVERIFIABLE`/`VALIDITY_UNKNOWN`. Acceptance only admits the assertion; resolution still derives the
 * role at each evaluated instant.
 */
export const evaluateTaxSourceAssertionAcceptance = ({
  assertion,
  authorities,
}: Readonly<{
  assertion: TaxSourceAcceptanceInput;
  authorities: readonly TaxSourceAuthorityPeriod[];
}>): TaxSourceAcceptance => {
  const claim = taxSourceClaim(assertion);
  if (assertion.eligibility !== 'ELIGIBLE' || Option.isNone(claim)) {
    return { outcome: 'UNVERIFIABLE', reason: 'VALIDITY_UNKNOWN' };
  }
  const [decided] = claimedSegmentAuthorities(claim.value, assertion.sourceRef, authorities)
    .map(({ decision }) => decision)
    .toSorted((left, right) => acceptancePrecedence[left.outcome] - acceptancePrecedence[right.outcome]);
  return decided === undefined
    ? { outcome: 'UNVERIFIABLE', reason: 'AUTHORITY_MISSING' }
    : { outcome: decided.outcome, reason: decided.reason };
};

/**
 * Competing contract revisions behind a `NEEDS_REVIEW`/`AUTHORITY_CONFIGURATION_CONFLICT` acceptance: the revisions
 * covering every claimed coverage segment where the source's permission is undecidable, walked exactly as
 * {@link evaluateTaxSourceAssertionAcceptance} walks them, so a recorded configuration conflict always agrees with the
 * evaluated acceptance reason (#959 F2-F3, F28). Empty for any other acceptance.
 */
export const taxSourceAuthorityConfigurationConflict = ({
  assertion,
  authorities,
}: Readonly<{
  assertion: TaxSourceAcceptanceInput;
  authorities: readonly TaxSourceAuthorityPeriod[];
}>): readonly string[] => {
  const claim = taxSourceClaim(assertion);
  if (
    assertion.eligibility !== 'ELIGIBLE' ||
    Option.isNone(claim) ||
    evaluateTaxSourceAssertionAcceptance({ assertion, authorities }).reason !== 'AUTHORITY_CONFIGURATION_CONFLICT'
  ) {
    return [];
  }
  const revisionIds = claimedSegmentAuthorities(claim.value, assertion.sourceRef, authorities).flatMap(
    ({ covering, decision }) =>
      decision.reason === 'AUTHORITY_CONFIGURATION_CONFLICT'
        ? covering.map(({ contractRevisionId }) => contractRevisionId)
        : [],
  );
  return [...new Set(revisionIds)].toSorted(byText);
};

const ids = (assertions: readonly EligibleTaxSourceAssertion[]) =>
  assertions.map(({ assertionId }) => assertionId).toSorted(byText);

const claimed = (assertions: readonly EligibleTaxSourceAssertion[]) =>
  assertions.flatMap((assertion) =>
    Option.match(taxSourceClaim(assertion), { onNone: () => [], onSome: (claim) => [{ assertion, claim }] }),
  );

/**
 * Selling Legal Entity VAT Registration at evaluation time E from the complete owner set (#922, #925, #959).
 * Exactly one System of Record must cover E; several are a configuration conflict with no technical winner
 * (#959 F1-F3, F28). Only ELIGIBLE assertions of the source that is System of Record AT E decide, by declared
 * validity alone; each assertion's role is derived from the revision covering E, never from the role it had when it
 * was recorded, so an assertion recorded before its contract, or late after an authority handoff, counts for the
 * instants its source is authoritative (#959 F1, F8-F9, F25). Arrival,
 * delivery order and recorded time are never read (#925 F9-F10, #958 F15-F19). An elapsed positive validity is
 * STALE, never extended as last-known (#925 F18-F20); incompatible authoritative claims are UNRESOLVED (#925 F25).
 */
export const resolveSellingLegalEntityVatRegistration = ({
  completeState,
  evaluationTime,
}: Readonly<{
  completeState: CompleteSellingLegalEntityVatRegistrationState;
  evaluationTime: DateTime.Utc;
}>): SellingLegalEntityVatRegistrationResolution => {
  const [systemOfRecord, ...competing] = authoritiesCoveringInstant(completeState.authorities, evaluationTime);
  if (systemOfRecord === undefined) {
    return {
      authority: { outcome: 'AUTHORITY_MISSING', systemOfRecord: Option.none() },
      basisAssertionIds: [],
      evidenceDisagreementIds: [],
      reason: 'AUTHORITY_MISSING',
      state: 'UNKNOWN',
    };
  }
  if (competing.length > 0) {
    return {
      authority: { outcome: 'AUTHORITY_CONFLICT', systemOfRecord: Option.none() },
      basisAssertionIds: [],
      evidenceDisagreementIds: [],
      reason: 'AUTHORITY_CONFIGURATION_CONFLICT',
      state: 'UNRESOLVED',
    };
  }
  const authority = { outcome: 'AUTHORITY_ESTABLISHED' as const, systemOfRecord: Option.some(systemOfRecord) };
  // Roles come from the revision covering E, whatever the role was when an assertion was recorded (#959 F8, F25).
  const withRoleAtE = (role: 'EVIDENCE' | 'SYSTEM_OF_RECORD') =>
    claimed(
      completeState.eligibleAssertions.filter((assertion) => roleUnder(systemOfRecord, assertion.sourceRef) === role),
    );
  const authoritative = withRoleAtE('SYSTEM_OF_RECORD');
  const coveringClaims = authoritative.filter(({ claim }) => periodCoversInstant(claim.from, claim.to, evaluationTime));
  const withPolarity = (polarity: TaxSourceClaim['polarity']) =>
    coveringClaims.flatMap(({ assertion, claim }) => (claim.polarity === polarity ? [assertion] : []));
  const positive = withPolarity('POSITIVE');
  const negative = withPolarity('NEGATIVE');
  // Only sources listed as evidence at E can disagree at E; a former System of Record or delisted source cannot.
  const evidence = withRoleAtE('EVIDENCE');
  const disagreeing = (polarity: TaxSourceClaim['polarity']) =>
    ids(
      evidence.flatMap(({ assertion, claim }) =>
        claim.polarity === polarity && periodCoversInstant(claim.from, claim.to, evaluationTime) ? [assertion] : [],
      ),
    );
  if (positive.length > 0 && negative.length > 0) {
    return {
      authority,
      basisAssertionIds: ids([...positive, ...negative]),
      evidenceDisagreementIds: [],
      reason: 'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS',
      state: 'UNRESOLVED',
    };
  }
  if (positive.length > 0) {
    return {
      authority,
      basisAssertionIds: ids(positive),
      evidenceDisagreementIds: disagreeing('NEGATIVE'),
      reason: 'AUTHORITATIVE_POSITIVE',
      state: 'CURRENT_POSITIVE',
    };
  }
  if (negative.length > 0) {
    return {
      authority,
      basisAssertionIds: ids(negative),
      evidenceDisagreementIds: disagreeing('POSITIVE'),
      reason: 'AUTHORITATIVE_NEGATIVE',
      state: 'KNOWN_ENDED_OR_NON_REGISTERED',
    };
  }
  const elapsed = authoritative.flatMap(({ assertion, claim }) =>
    claim.polarity === 'POSITIVE' &&
    Option.isSome(claim.to) &&
    DateTime.isLessThanOrEqualTo(claim.to.value, evaluationTime)
      ? [assertion]
      : [],
  );
  if (elapsed.length > 0) {
    return {
      authority,
      basisAssertionIds: ids(elapsed),
      evidenceDisagreementIds: [],
      reason: 'VALIDITY_ELAPSED',
      state: 'STALE',
    };
  }
  return {
    authority,
    basisAssertionIds: [],
    evidenceDisagreementIds: [],
    reason: authoritative.length === 0 ? 'NO_AUTHORITATIVE_ASSERTION' : 'NO_COVERING_ASSERTION',
    state: 'UNKNOWN',
  };
};
