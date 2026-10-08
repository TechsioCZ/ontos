import { Option } from 'effect';
import type { DateTime } from 'effect';

import type {
  TaxSourceAcceptanceOutcome,
  TaxSourceAcceptanceReason,
  TaxSourceAuthorityRole,
  TaxSourceEligibility,
  TaxSourceRegistrationMeaning,
} from '../../shared/actions/tax-source-assertion.ts';

/** One Tax Fact Authority Contract revision covering the instant an acceptance is evaluated at. */
export interface TaxSourceAuthority {
  readonly contractId: string;
  readonly contractRevisionId: string;
  readonly evidenceSourceRefs: readonly string[];
  readonly systemOfRecordRef: string;
}

/** Value and declared validity of one delivered source assertion; transport identity is not meaning. */
export interface TaxSourceAssertionProposal {
  readonly registrationMeaning: TaxSourceRegistrationMeaning;
  readonly validFrom: Option.Option<DateTime.Utc>;
  readonly validTo: Option.Option<DateTime.Utc>;
}

/** A #957 source acceptance outcome with its stable reason. */
export interface TaxSourceAcceptance {
  readonly outcome: TaxSourceAcceptanceOutcome;
  readonly reason: TaxSourceAcceptanceReason;
}

/** Authority acceptance of one source under the contract revisions covering one business instant. */
export interface TaxSourceAuthorityAcceptance extends TaxSourceAcceptance {
  readonly contractRevisionId: Option.Option<string>;
  readonly role: TaxSourceAuthorityRole;
}

/**
 * Stored eligibility (#957 F14-F26): the only check that holds at every instant once the payload schema has fixed
 * the exact subject and scope, namely the declared business validity the meaning needs. A positive or non-registered
 * claim needs its start, an ended claim needs the instant the registration ended; it is never derived from
 * observed/issued/received time (#957 F21, #958 F14-F16, F26). Eligibility admits the assertion into resolution
 * input; authority is NOT part of it, because contracts change over business time (#959 F1, F8, F25).
 */
export const evaluateTaxSourceEligibility = (proposal: TaxSourceAssertionProposal): TaxSourceEligibility =>
  (proposal.registrationMeaning === 'ENDED' ? Option.isSome(proposal.validTo) : Option.isSome(proposal.validFrom))
    ? 'ELIGIBLE'
    : 'VALIDITY_UNKNOWN';

const authorityDecided = (
  outcome: TaxSourceAcceptanceOutcome,
  reason: TaxSourceAcceptanceReason,
  role: TaxSourceAuthorityRole = 'NONE',
  contractRevisionId: Option.Option<string> = Option.none(),
): TaxSourceAuthorityAcceptance => ({ contractRevisionId, outcome, reason, role });

/**
 * Evaluated authority acceptance of a source at ONE business instant, from the contract revisions covering it
 * (#957 F1-F13, #959 F1-F3, F28): none covering is `UNVERIFIABLE`/`AUTHORITY_MISSING`; competing revisions are
 * `NEEDS_REVIEW`/`AUTHORITY_CONFIGURATION_CONFLICT` with no technical winner for a source with a role under at least
 * one of them, and `REJECTED`/`SOURCE_NOT_PERMITTED` for any other source; the covering System of Record decides;
 * a listed evidence source only provides evidence; any other source is `REJECTED`/`SOURCE_NOT_PERMITTED` there. The
 * same source may be authoritative at one instant and not permitted at another (authority handoff).
 */
export const evaluateTaxSourceAuthority = ({
  authoritiesAtInstant,
  sourceRef,
}: Readonly<{
  authoritiesAtInstant: readonly TaxSourceAuthority[];
  sourceRef: string;
}>): TaxSourceAuthorityAcceptance => {
  const [authority, ...competing] = authoritiesAtInstant;
  if (authority === undefined) {
    return authorityDecided('UNVERIFIABLE', 'AUTHORITY_MISSING');
  }
  if (competing.length > 0) {
    // Undecidable only for a source with a role under some competing revision; any other source is not permitted
    // under any of them (#957 F27-F28).
    const hasRole = authoritiesAtInstant.some(
      (candidate) => sourceRef === candidate.systemOfRecordRef || candidate.evidenceSourceRefs.includes(sourceRef),
    );
    return hasRole
      ? authorityDecided('NEEDS_REVIEW', 'AUTHORITY_CONFIGURATION_CONFLICT')
      : authorityDecided('REJECTED', 'SOURCE_NOT_PERMITTED');
  }
  const contractRevisionId = Option.some(authority.contractRevisionId);
  if (sourceRef === authority.systemOfRecordRef) {
    return authorityDecided('ACCEPTED', 'ACCEPTED', 'SYSTEM_OF_RECORD', contractRevisionId);
  }
  return authority.evidenceSourceRefs.includes(sourceRef)
    ? authorityDecided('ACCEPTED', 'ACCEPTED', 'EVIDENCE', contractRevisionId)
    : authorityDecided('REJECTED', 'SOURCE_NOT_PERMITTED', 'NONE', contractRevisionId);
};
