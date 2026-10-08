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
import { authoritiesCoveringInstant, periodCoversInstant } from './selling-legal-entity-vat-registration-resolution.ts';
import type { TaxSourceAuthorityPeriod } from './selling-legal-entity-vat-registration-resolution.ts';

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
  left.contractId.localeCompare(right.contractId, 'en');

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
  ].toSorted((left, right) => left.localeCompare(right, 'en'));
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
      boundaries.push({
        at: end,
        fromSystemOfRecordRef: period.systemOfRecordRef,
        toSystemOfRecordRef: next.systemOfRecordRef,
      });
    }
  }
  return TaxAuthorityHandoffValidSchema.make({ boundaries });
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
  const stillCurrent = periodCoversInstant(
    Option.some(authorityThen.authorityFrom),
    authorityThen.authorityTo,
    input.evaluationInstant,
  );
  return {
    placement: stillCurrent ? 'CURRENT_UNDER_ITS_AUTHORITY' : 'HISTORICAL_OR_RECONCILIATION_ONLY',
    systemOfRecordRef,
  };
};
