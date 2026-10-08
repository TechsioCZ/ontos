import { Match, Result, Schema } from 'effect';

import { TaxRuleRevisionContentSchema } from '../../shared/actions/tax-governance.ts';
import { RecordTaxSourceAssertionPayloadSchema } from '../../shared/actions/tax-source-assertion.ts';
import {
  TaxMigrationCompleteSchema,
  TaxMigrationConflictingSchema,
  TaxMigrationIncompleteSchema,
  TaxMigrationMappedAcceptedSchema,
  TaxMigrationNotCompleteSchema,
  TaxMigrationRejectedUnmappedSchema,
  TaxMigrationReviewRequiredSchema,
  TaxMigrationTargetMeaningKeySchema,
  TaxMigrationUnverifiableSchema,
} from '../../shared/domain/tax-migration-contracts.ts';
import type {
  TaxMigrationCandidate,
  TaxMigrationCompleteness,
  TaxMigrationCompletenessClaim,
  TaxMigrationFamily,
  TaxMigrationOutcome,
  TaxMigrationTargetDifference,
  TaxMigrationTargetFact,
} from '../../shared/domain/tax-migration-contracts.ts';

export const TAX_OWNER_CAPABILITY = 'commerce.tax';

export const taxMigrationFamilies = [
  'TAX_RULE',
  'SELLING_LEGAL_ENTITY_VAT_REGISTRATION',
] as const satisfies readonly TaxMigrationFamily[];

type TargetMeaning = Readonly<Record<string, string>>;

/** Launch scope literals: anything else in legacy is future breadth and never activates TAX behaviour (#960 F9). */
const launchScope = {
  compositionKind: 'EXCLUSIVE',
  jurisdiction: 'CZ_DOMESTIC',
  treatmentCategory: 'TAXABLE',
} as const;

const requiredKeys = {
  SELLING_LEGAL_ENTITY_VAT_REGISTRATION: [
    'factFamily',
    'jurisdiction',
    'provenanceRef',
    'reason',
    'registrationMeaning',
    'sourceAssertionKey',
    'sourceRecordRef',
    'sourceRef',
  ],
  TAX_RULE: [
    'compositionKind',
    'effectiveFrom',
    'jurisdiction',
    'ratePercent',
    'taxClassificationCode',
    'treatmentCategory',
  ],
} as const satisfies Record<TaxMigrationFamily, readonly string[]>;

const TaxRuleTargetTextSchema = Schema.fromJsonString(TaxRuleRevisionContentSchema);
const VatRegistrationTargetTextSchema = Schema.fromJsonString(RecordTaxSourceAssertionPayloadSchema);

/**
 * Canonical target meaning: decoded with the governed TAX Action schema and re-encoded in schema field order, so the
 * same business meaning always yields the same key whatever its legacy representation (#960 F2, F15).
 */
export const taxMigrationTargetMeaningKey = (
  family: TaxMigrationFamily,
  targetMeaning: TargetMeaning,
): Result.Result<typeof TaxMigrationTargetMeaningKeySchema.Type, Schema.SchemaError> =>
  (family === 'TAX_RULE'
    ? Schema.decodeUnknownResult(TaxRuleRevisionContentSchema)(targetMeaning).pipe(
        Result.flatMap(Schema.encodeResult(TaxRuleTargetTextSchema)),
      )
    : Schema.decodeUnknownResult(RecordTaxSourceAssertionPayloadSchema)(targetMeaning).pipe(
        Result.flatMap(Schema.encodeResult(VatRegistrationTargetTextSchema)),
      )
  ).pipe(Result.map((text) => TaxMigrationTargetMeaningKeySchema.make(text)));

const outsideLaunchScope = (targetMeaning: TargetMeaning): boolean =>
  Object.entries(launchScope).some(
    ([key, launchValue]) => targetMeaning[key] !== undefined && targetMeaning[key] !== launchValue,
  );

const evaluateTaxOwned = (
  sourceRecordRef: string,
  family: TaxMigrationFamily,
  targetMeaning: TargetMeaning,
): TaxMigrationOutcome => {
  if (outsideLaunchScope(targetMeaning)) {
    return TaxMigrationRejectedUnmappedSchema.make({
      reason: 'UNSUPPORTED_BREADTH',
      sourceRecordRef,
      targetOwner: TAX_OWNER_CAPABILITY,
    });
  }
  const missing = requiredKeys[family].filter((key) => targetMeaning[key] === undefined);
  if (missing.length > 0) {
    return TaxMigrationIncompleteSchema.make({ missing, sourceRecordRef });
  }
  return Result.match(taxMigrationTargetMeaningKey(family, targetMeaning), {
    onFailure: (): TaxMigrationOutcome =>
      TaxMigrationReviewRequiredSchema.make({ reason: 'TARGET_MEANING_INVALID', sourceRecordRef }),
    onSuccess: (targetMeaningKey): TaxMigrationOutcome =>
      TaxMigrationMappedAcceptedSchema.make({ family, sourceRecordRef, targetMeaningKey }),
  });
};

/** Outcome of one candidate on its own, before duplicate source identities are reconciled. */
const evaluateCandidate = ({ mapping, provenance }: TaxMigrationCandidate): TaxMigrationOutcome => {
  const { sourceRecordRef } = provenance;
  return Match.value(mapping).pipe(
    Match.tag('FOREIGN_OWNER', ({ targetOwner }) =>
      TaxMigrationRejectedUnmappedSchema.make({ reason: 'FOREIGN_OWNER', sourceRecordRef, targetOwner }),
    ),
    Match.tag('HISTORICAL_ACCEPTED_VALUE', ({ historicalOwner }) =>
      TaxMigrationRejectedUnmappedSchema.make({
        reason: 'HISTORICAL_ACCEPTED_VALUE',
        sourceRecordRef,
        targetOwner: historicalOwner,
      }),
    ),
    Match.tag('UNESTABLISHED', () =>
      TaxMigrationReviewRequiredSchema.make({ reason: 'MEANING_NOT_ESTABLISHED', sourceRecordRef }),
    ),
    Match.tag('TAX_OWNED', ({ family, targetMeaning }) => evaluateTaxOwned(sourceRecordRef, family, targetMeaning)),
    Match.exhaustive,
  );
};

const byText = (left: string, right: string) => left.localeCompare(right, 'en');

/** Comparable business meaning of an outcome: the mapped target meaning, otherwise the outcome kind itself. */
const meaningOf = (outcome: TaxMigrationOutcome): string =>
  Match.value(outcome).pipe(
    Match.tag('MAPPED_ACCEPTED', ({ targetMeaningKey }) => targetMeaningKey),
    Match.orElse(({ _tag }) => _tag),
  );

const sourceIdentity = ({ provenance }: TaxMigrationCandidate) =>
  `${provenance.sourceSystemRef} ${provenance.sourceRecordRef}`;

/**
 * Evaluates one NON_PRODUCTION dataset deterministically, independent of input order. One source record identity is
 * one record: identical meanings keep one outcome and reject the copies as duplicates; different meanings are
 * CONFLICTING and none is chosen by order or arrival (#960 G duplicate legacy records, F26-F27).
 */
export const evaluateTaxMigrationCandidates = (
  candidates: readonly TaxMigrationCandidate[],
): readonly TaxMigrationOutcome[] => {
  const evaluated = candidates
    .map((candidate) => {
      const outcome = evaluateCandidate(candidate);
      return { identity: sourceIdentity(candidate), meaning: meaningOf(outcome), outcome };
    })
    .toSorted((left, right) => byText(left.identity, right.identity) || byText(left.meaning, right.meaning));
  return evaluated.map((entry) => {
    const sameRecord = evaluated.filter(({ identity }) => identity === entry.identity);
    if (sameRecord.length === 1) {
      return entry.outcome;
    }
    if (new Set(sameRecord.map(({ meaning }) => meaning)).size > 1) {
      return TaxMigrationConflictingSchema.make({
        counterpartRecordRefs: sameRecord.flatMap((other) => (other === entry ? [] : [other.outcome.sourceRecordRef])),
        sourceRecordRef: entry.outcome.sourceRecordRef,
      });
    }
    return sameRecord[0] === entry
      ? entry.outcome
      : TaxMigrationRejectedUnmappedSchema.make({
          reason: 'DUPLICATE_SOURCE_RECORD',
          sourceRecordRef: entry.outcome.sourceRecordRef,
          targetOwner: TAX_OWNER_CAPABILITY,
        });
  });
};

/** Outcomes that still need business work; a family holding any of them is never complete (#960 F16-F18). */
const isOpenOutcome = (outcome: TaxMigrationOutcome): boolean =>
  Match.value(outcome).pipe(
    Match.tags({ CONFLICTING: () => true, INCOMPLETE: () => true, REVIEW_REQUIRED: () => true }),
    Match.orElse(() => false),
  );

/**
 * Verifies completeness as a business claim. Every declared record must have an outcome, no outcome may stay open
 * and no unexpected record may appear. The row count is reported for information and never decides (#960 F14, F18).
 */
export const verifyTaxMigrationCompleteness = (
  family: TaxMigrationFamily,
  claim: TaxMigrationCompletenessClaim | undefined,
  outcomes: readonly TaxMigrationOutcome[],
): TaxMigrationCompleteness => {
  const rowCount = outcomes.length;
  if (claim === undefined || claim.family !== family) {
    return TaxMigrationUnverifiableSchema.make({ family, rowCount });
  }
  const observed = new Set(outcomes.map(({ sourceRecordRef }) => sourceRecordRef));
  const expected = new Set(claim.expectedSourceRecordRefs);
  const missingRecordRefs = [...expected].filter((ref) => !observed.has(ref)).toSorted(byText);
  const unexpectedRecordRefs = [...observed].filter((ref) => !expected.has(ref)).toSorted(byText);
  const openRecordRefs = outcomes
    .flatMap((outcome) => (isOpenOutcome(outcome) ? [outcome.sourceRecordRef] : []))
    .toSorted(byText);
  if (missingRecordRefs.length === 0 && unexpectedRecordRefs.length === 0 && openRecordRefs.length === 0) {
    return TaxMigrationCompleteSchema.make({ family, rowCount });
  }
  return TaxMigrationNotCompleteSchema.make({
    family,
    missingRecordRefs,
    openRecordRefs,
    rowCount,
    unexpectedRecordRefs,
  });
};

const mappedMeaning = (outcome: TaxMigrationOutcome): readonly (readonly [string, string])[] =>
  Match.value(outcome).pipe(
    Match.tag('MAPPED_ACCEPTED', ({ sourceRecordRef, targetMeaningKey }) => [
      [sourceRecordRef, targetMeaningKey] as const,
    ]),
    Match.orElse(() => []),
  );

/**
 * Tax Reconciliation of mapped meaning against the TAX target: equal record counts with a different meaning are a
 * difference, never a pass (#960 F14-F15, BDD "Row counts match but semantics differ"). It only reports; it never
 * rewrites the target or committed historical facts (F31).
 */
export const reconcileTaxMigrationTarget = (
  outcomes: readonly TaxMigrationOutcome[],
  targetFacts: readonly TaxMigrationTargetFact[],
): readonly TaxMigrationTargetDifference[] => {
  const mapped = new Map(outcomes.flatMap(mappedMeaning));
  const target = new Map(
    targetFacts.map(({ sourceRecordRef, targetMeaningKey }) => [sourceRecordRef, targetMeaningKey]),
  );
  const differences: TaxMigrationTargetDifference[] = [];
  for (const [sourceRecordRef, meaning] of mapped) {
    const held = target.get(sourceRecordRef);
    if (held === undefined) {
      differences.push({ difference: 'MISSING_IN_TARGET', sourceRecordRef });
    } else if (held !== meaning) {
      differences.push({ difference: 'MEANING_DIFFERS', sourceRecordRef });
    }
  }
  for (const sourceRecordRef of target.keys()) {
    if (!mapped.has(sourceRecordRef)) {
      differences.push({ difference: 'UNEXPECTED_IN_TARGET', sourceRecordRef });
    }
  }
  return differences.toSorted((left, right) => byText(left.sourceRecordRef, right.sourceRecordRef));
};
