import { DateTime, Option } from 'effect';

import {
  TaxAuthorityConflictSchema,
  TaxAuthorityGapSchema,
  TaxAuthorityHandoffIndeterminateSchema,
  TaxAuthorityHandoffValidSchema,
  TaxMigrationAuthorityContractIdSchema,
} from '../../shared/domain/tax-migration-contracts.ts';
import type {
  TaxAuthorityBoundary,
  TaxAuthorityHandoffEvaluation,
  TaxMigrationAssertionPlacement,
} from '../../shared/domain/tax-migration-contracts.ts';
import { authoritiesCoveringInstant } from './selling-legal-entity-vat-registration-resolution.ts';
import type { TaxSourceAuthorityPeriod } from './selling-legal-entity-vat-registration-resolution.ts';
import { byTaxMigrationText } from './tax-fact-migration.ts';

/**
 * One fact-level authority period for one exact fact family and Selling Legal Entity, in the shape of a step-3 Tax
 * Fact Authority Contract revision: half-open `[authorityFrom, authorityTo)`. An unknown start is None and is never
 * guessed (#960 F29).
 */
export interface TaxAuthorityHandoffPeriod extends Omit<TaxSourceAuthorityPeriod, 'authorityFrom'> {
  readonly authorityFrom: Option.Option<DateTime.Utc>;
}

const knownStart = (period: TaxAuthorityHandoffPeriod): readonly TaxSourceAuthorityPeriod[] =>
  Option.match(period.authorityFrom, {
    onNone: () => [],
    onSome: (authorityFrom) => [{ ...period, authorityFrom }],
  });

const byStart = (left: TaxSourceAuthorityPeriod, right: TaxSourceAuthorityPeriod) =>
  DateTime.toEpochMillis(left.authorityFrom) - DateTime.toEpochMillis(right.authorityFrom) ||
  byTaxMigrationText(left.contractId, right.contractId);

/**
 * Evaluates the fact-level authority handoff for one exact fact family and seller (#960 F19-F29). Exactly one System
 * of Record is Current at every instant from the first authority start onward: overlapping periods are a migration
 * authority configuration conflict with no winner by order or arrival (F21, F27); a gap, including authority that
 * simply ends, blocks (F28); an unknown boundary is INDETERMINATE (F29). Dual running never means dual authority (F22).
 */
export const evaluateTaxAuthorityHandoff = (
  periods: readonly TaxAuthorityHandoffPeriod[],
): TaxAuthorityHandoffEvaluation => {
  if (periods.length === 0) {
    return TaxAuthorityHandoffIndeterminateSchema.make({ reason: 'NO_AUTHORITY_CONFIGURED' });
  }
  const knownPeriods = periods.flatMap(knownStart);
  if (knownPeriods.length !== periods.length) {
    return TaxAuthorityHandoffIndeterminateSchema.make({ reason: 'AUTHORITY_BOUNDARY_UNKNOWN' });
  }
  const ordered = knownPeriods.toSorted(byStart);
  // Two half-open periods overlap exactly when one of them covers the other's start; every party is named.
  const conflicting = [
    ...new Set(
      ordered.flatMap((period) => {
        const covering = authoritiesCoveringInstant(ordered, period.authorityFrom);
        return covering.length > 1 ? covering.map(({ contractId }) => contractId) : [];
      }),
    ),
  ].toSorted(byTaxMigrationText);
  if (conflicting.length > 0) {
    return TaxAuthorityConflictSchema.make({
      contractIds: conflicting.map((contractId) => TaxMigrationAuthorityContractIdSchema.make(contractId)),
    });
  }
  const boundaries: TaxAuthorityBoundary[] = [];
  for (const [index, period] of ordered.entries()) {
    const next = ordered[index + 1];
    if (Option.isSome(period.authorityTo)) {
      const end = period.authorityTo.value;
      if (next === undefined || DateTime.isLessThan(end, next.authorityFrom)) {
        return TaxAuthorityGapSchema.make({
          from: end,
          to: next === undefined ? Option.none() : Option.some(next.authorityFrom),
        });
      }
      // Only a change of System of Record hands authority over; contiguous periods of one source do not (F23, F25).
      if (period.systemOfRecordRef !== next.systemOfRecordRef) {
        boundaries.push({
          at: end,
          fromSystemOfRecordRef: period.systemOfRecordRef,
          toSystemOfRecordRef: next.systemOfRecordRef,
        });
      }
    }
  }
  // A handoff is an explicit boundary changing authority; a single unbounded authority hands nothing over (F23).
  const [firstBoundary, ...laterBoundaries] = boundaries;
  return firstBoundary === undefined
    ? TaxAuthorityHandoffIndeterminateSchema.make({ reason: 'NO_AUTHORITY_BOUNDARY_DECLARED' })
    : TaxAuthorityHandoffValidSchema.make({ boundaries: [firstBoundary, ...laterBoundaries] });
};

/**
 * Whether one System of Record held authority without a gap from `from` to `until`: an assertion cannot regain
 * Current status after its authority lapsed (#960 F28-F30). Each step moves to the end of a covering period.
 */
const heldContinuously = (
  periods: readonly TaxSourceAuthorityPeriod[],
  systemOfRecordRef: string,
  from: DateTime.Utc,
  until: DateTime.Utc,
): boolean => {
  const own = periods.filter((period) => period.systemOfRecordRef === systemOfRecordRef);
  let at = from;
  for (const _ of own) {
    const [covering] = authoritiesCoveringInstant(own, at);
    if (covering === undefined) {
      return false;
    }
    if (Option.isNone(covering.authorityTo) || DateTime.isGreaterThan(covering.authorityTo.value, until)) {
      return true;
    }
    at = covering.authorityTo.value;
  }
  return false;
};

/**
 * Places a delayed pre-cutover assertion by its own business instant and source, never by arrival (#960 F30, BDD
 * "Pre-cutover assertion arrives after handoff"). An assertion from the System of Record of its business instant keeps
 * that meaning; once a later boundary has moved Current authority elsewhere it is historical or reconciliation
 * evidence only, not post-cutover Current truth.
 */
export const placeTaxMigrationAssertion = (input: {
  readonly businessInstant: DateTime.Utc;
  readonly evaluationInstant: DateTime.Utc;
  readonly periods: readonly TaxSourceAuthorityPeriod[];
  readonly sourceRef: string;
}): TaxMigrationAssertionPlacement => {
  const [authorityThen, ...competingThen] = authoritiesCoveringInstant(input.periods, input.businessInstant);
  if (authorityThen === undefined || competingThen.length > 0) {
    return { placement: 'NO_SINGLE_AUTHORITY', systemOfRecordRef: Option.none() };
  }
  const systemOfRecordRef = Option.some(authorityThen.systemOfRecordRef);
  if (authorityThen.systemOfRecordRef !== input.sourceRef) {
    return { placement: 'NOT_FROM_SYSTEM_OF_RECORD', systemOfRecordRef };
  }
  // Placement needs exactly one System of Record at the evaluation instant too: a gap or an overlap there is never
  // guessed (#960 F21-F22, F27-F29). The assertion stays Current while that same source is still the authority.
  const [authorityNow, ...competingNow] = authoritiesCoveringInstant(input.periods, input.evaluationInstant);
  if (authorityNow === undefined || competingNow.length > 0) {
    return { placement: 'NO_SINGLE_AUTHORITY', systemOfRecordRef: Option.none() };
  }
  // Once any other System of Record held authority after the business instant, the assertion became historical and a
  // later hand-back does not make it Current again (#960 F24-F26, F30).
  const handedAway = input.periods.some(
    (period) =>
      period.systemOfRecordRef !== authorityThen.systemOfRecordRef &&
      DateTime.isLessThan(period.authorityFrom, input.evaluationInstant) &&
      Option.match(period.authorityTo, {
        onNone: () => true,
        onSome: (to) => DateTime.isGreaterThan(to, input.businessInstant),
      }),
  );
  return {
    placement:
      !handedAway &&
      authorityNow.systemOfRecordRef === authorityThen.systemOfRecordRef &&
      heldContinuously(input.periods, authorityThen.systemOfRecordRef, input.businessInstant, input.evaluationInstant)
        ? 'CURRENT_UNDER_ITS_AUTHORITY'
        : 'HISTORICAL_OR_RECONCILIATION_ONLY',
    systemOfRecordRef,
  };
};
