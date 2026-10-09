import { DateTime, Match, Option, Result, Schema } from 'effect';

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
  TaxMigrationProvenance,
  TaxMigrationSourceRecord,
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
const strict = { onExcessProperty: 'error' } as const;

/** Exact decimal text without insignificant trailing zeros: `21.00` and `21` are the same rate (#938, #960 F15). */
const canonicalRate = (ratePercent: string): string =>
  // Only a well-formed decimal is normalized; anything else reaches the governed schema unchanged and is rejected.
  /^\d+(?:\.\d+)?$/u.test(ratePercent)
    ? ratePercent.replace(/(?<significant>\.\d*?[1-9])0+$/u, '$<significant>').replace(/\.0+$/u, '')
    : ratePercent;

/** Unambiguous composite key: each part is length-prefixed, so no part content can imitate a separator (#960 F11). */
const tupleKey = (parts: readonly string[]): string => parts.map((part) => `${part.length}:${part}`).join('|');

const withCanonicalRate = (targetMeaning: TargetMeaning) =>
  Object.fromEntries(
    Object.entries(targetMeaning).map(([key, value]) => [key, key === 'ratePercent' ? canonicalRate(value) : value]),
  );

interface CanonicalTarget {
  /** Identity of the one exact target fact this meaning would be for, independent of its value. */
  readonly factKey: string;
  readonly targetMeaningKey: typeof TaxMigrationTargetMeaningKeySchema.Type;
}

/**
 * Canonical target meaning: decoded strictly with the governed TAX Action schema (an unknown legacy key is never
 * silently dropped) and re-encoded in schema field order, so the same business meaning always yields the same key
 * whatever its legacy representation (#960 F1-F2, F15, F34).
 */
const canonicalTarget = (
  family: TaxMigrationFamily,
  targetMeaning: TargetMeaning,
): Result.Result<CanonicalTarget, Schema.SchemaError> =>
  family === 'TAX_RULE'
    ? Schema.decodeUnknownResult(
        TaxRuleRevisionContentSchema,
        strict,
      )(withCanonicalRate(targetMeaning)).pipe(
        Result.flatMap((content) =>
          Schema.encodeResult(TaxRuleTargetTextSchema)(content).pipe(
            Result.map((text) => ({
              factKey: tupleKey([
                'TAX_RULE',
                content.jurisdiction,
                content.taxClassificationCode,
                DateTime.formatIso(content.effectiveFrom),
              ]),
              targetMeaningKey: TaxMigrationTargetMeaningKeySchema.make(text),
            })),
          ),
        ),
      )
    : Schema.decodeUnknownResult(
        RecordTaxSourceAssertionPayloadSchema,
        strict,
      )(targetMeaning).pipe(
        Result.flatMap((payload) =>
          Schema.encodeResult(VatRegistrationTargetTextSchema)(payload).pipe(
            Result.map((text) => ({
              factKey: tupleKey([
                'SELLING_LEGAL_ENTITY_VAT_REGISTRATION',
                payload.sourceRef,
                payload.sourceAssertionKey,
              ]),
              targetMeaningKey: TaxMigrationTargetMeaningKeySchema.make(text),
            })),
          ),
        ),
      );

/** Canonical meaning key of a TAX target fact, computed exactly as for a mapped candidate. */
export const taxMigrationTargetMeaningKey = (
  family: TaxMigrationFamily,
  targetMeaning: TargetMeaning,
): Result.Result<typeof TaxMigrationTargetMeaningKeySchema.Type, Schema.SchemaError> =>
  canonicalTarget(family, targetMeaning).pipe(Result.map(({ targetMeaningKey }) => targetMeaningKey));

const outsideLaunchScope = (targetMeaning: TargetMeaning): boolean =>
  Object.entries(launchScope).some(
    ([key, launchValue]) => targetMeaning[key] !== undefined && targetMeaning[key] !== launchValue,
  );

/** A source assertion's own source and record identity must be the record it was migrated from (#960 F11). */
const contradictsProvenance = (
  family: TaxMigrationFamily,
  targetMeaning: TargetMeaning,
  provenance: TaxMigrationProvenance,
): boolean =>
  family === 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION' &&
  (targetMeaning['sourceRef'] !== provenance.sourceSystemRef ||
    targetMeaning['sourceRecordRef'] !== provenance.sourceRecordRef);

interface EvaluatedCandidate {
  readonly factKey: Option.Option<string>;
  readonly outcome: TaxMigrationOutcome;
  /** Raw legacy content of a Tax-owned record, so differing copies are never taken for duplicates (#960 G). */
  readonly rawMeaning: string;
}

/** Readable English collation with a code-point tie-break, so distinct references never compare equal. */
const byText = (left: string, right: string) => {
  const collated = left.localeCompare(right, 'en');
  if (collated !== 0) {
    return collated;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/**
 * A source assertion without the business validity its meaning needs cannot establish VAT registration state, so it is
 * INCOMPLETE rather than mapped: REGISTERED / NON_REGISTERED need `validFrom`, ENDED needs `validTo` (#958 F26).
 */
const requiredValidityKeys = (family: TaxMigrationFamily, targetMeaning: TargetMeaning): readonly string[] => {
  if (family !== 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION') {
    return [];
  }
  return targetMeaning['registrationMeaning'] === 'ENDED' ? ['validTo'] : ['validFrom'];
};

const rawMeaningOf = (family: TaxMigrationFamily, targetMeaning: TargetMeaning): string =>
  tupleKey([
    family,
    ...Object.entries(targetMeaning)
      .toSorted(([left], [right]) => byText(left, right))
      .flatMap(([key, value]) => [key, value]),
  ]);

const evaluateTaxOwned = (
  provenance: TaxMigrationProvenance,
  family: TaxMigrationFamily,
  targetMeaning: TargetMeaning,
): EvaluatedCandidate => {
  const rawMeaning = rawMeaningOf(family, targetMeaning);
  if (outsideLaunchScope(targetMeaning)) {
    return {
      factKey: Option.none(),
      outcome: TaxMigrationRejectedUnmappedSchema.make({
        provenance,
        reason: 'UNSUPPORTED_BREADTH',
        sourceFamily: Option.some(family),
        targetOwner: TAX_OWNER_CAPABILITY,
      }),
      rawMeaning,
    };
  }
  const missing = [...requiredKeys[family], ...requiredValidityKeys(family, targetMeaning)].filter(
    (key) => targetMeaning[key] === undefined,
  );
  if (missing.length > 0) {
    return {
      factKey: Option.none(),
      outcome: TaxMigrationIncompleteSchema.make({ missing, provenance, sourceFamily: Option.some(family) }),
      rawMeaning,
    };
  }
  if (contradictsProvenance(family, targetMeaning, provenance)) {
    return {
      factKey: Option.none(),
      outcome: TaxMigrationReviewRequiredSchema.make({
        provenance,
        reason: 'PROVENANCE_MISMATCH',
        sourceFamily: Option.some(family),
      }),
      rawMeaning,
    };
  }
  return Result.match(canonicalTarget(family, targetMeaning), {
    onFailure: (): EvaluatedCandidate => ({
      factKey: Option.none(),
      outcome: TaxMigrationReviewRequiredSchema.make({
        provenance,
        reason: 'TARGET_MEANING_INVALID',
        sourceFamily: Option.some(family),
      }),
      rawMeaning,
    }),
    onSuccess: ({ factKey, targetMeaningKey }): EvaluatedCandidate => ({
      factKey: Option.some(factKey),
      // A mapped record is compared by its canonical meaning, so `21` and `21.00` remain duplicates.
      outcome: TaxMigrationMappedAcceptedSchema.make({ family, provenance, targetMeaningKey }),
      rawMeaning: '',
    }),
  });
};

/** Outcome of one candidate on its own, before duplicate records and facts are reconciled. */
const evaluateCandidate = ({ mapping, provenance }: TaxMigrationCandidate): EvaluatedCandidate =>
  Match.value(mapping).pipe(
    Match.tag('FOREIGN_OWNER', ({ targetOwner }) => ({
      factKey: Option.none(),
      outcome: TaxMigrationRejectedUnmappedSchema.make({
        provenance,
        reason: 'FOREIGN_OWNER',
        sourceFamily: Option.none(),
        targetOwner,
      }),
      rawMeaning: '',
    })),
    Match.tag('HISTORICAL_ACCEPTED_VALUE', ({ historicalOwner }) => ({
      factKey: Option.none(),
      outcome: TaxMigrationRejectedUnmappedSchema.make({
        provenance,
        reason: 'HISTORICAL_ACCEPTED_VALUE',
        sourceFamily: Option.none(),
        targetOwner: historicalOwner,
      }),
      rawMeaning: '',
    })),
    Match.tag('UNESTABLISHED', () => ({
      factKey: Option.none(),
      outcome: TaxMigrationReviewRequiredSchema.make({
        provenance,
        reason: 'MEANING_NOT_ESTABLISHED',
        sourceFamily: Option.none(),
      }),
      rawMeaning: '',
    })),
    Match.tag('TAX_OWNED', ({ family, targetMeaning }) => evaluateTaxOwned(provenance, family, targetMeaning)),
    Match.exhaustive,
  );

/** Full business meaning of an outcome, provenance aside: kind, reason, owner, missing meaning or target meaning. */
const meaningOf = (outcome: TaxMigrationOutcome): string =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      CONFLICTING: () => 'CONFLICTING',
      INCOMPLETE: ({ missing }) => `INCOMPLETE ${missing.join(',')}`,
      MAPPED_ACCEPTED: ({ family, targetMeaningKey }) => `MAPPED_ACCEPTED ${family} ${targetMeaningKey}`,
      REJECTED_UNMAPPED: ({ reason, targetOwner }) => `REJECTED_UNMAPPED ${reason} ${targetOwner}`,
      REVIEW_REQUIRED: ({ reason }) => `REVIEW_REQUIRED ${reason}`,
    }),
  );

/** One source record identity: source system plus record, never the record ref alone (#960 F11). */
const sourceKey = ({ sourceRecordRef, sourceSystemRef }: TaxMigrationSourceRecord): string =>
  tupleKey([sourceSystemRef, sourceRecordRef]);

const sourceOf = ({ sourceRecordRef, sourceSystemRef }: TaxMigrationSourceRecord): TaxMigrationSourceRecord => ({
  sourceRecordRef,
  sourceSystemRef,
});

const provenanceKey = (provenance: TaxMigrationProvenance) =>
  tupleKey([provenance.sourceSystemRef, provenance.sourceRecordRef, provenance.datasetRef]);

/** Stable, readable presentation order by source system, record and dataset; it never picks a winner. */
const byProvenance = (left: TaxMigrationProvenance, right: TaxMigrationProvenance): number =>
  byText(left.sourceSystemRef, right.sourceSystemRef) ||
  byText(left.sourceRecordRef, right.sourceRecordRef) ||
  byText(left.datasetRef, right.datasetRef);

interface Entry extends EvaluatedCandidate {
  readonly groupKey: string;
  readonly meaning: string;
}

/** Family of the source record behind an outcome; None when it is owned elsewhere or its meaning is unknown. */
export const taxMigrationOutcomeFamily = (outcome: TaxMigrationOutcome): Option.Option<TaxMigrationFamily> =>
  Match.value(outcome).pipe(
    Match.tag('MAPPED_ACCEPTED', ({ family }) => Option.some(family)),
    Match.orElse(({ sourceFamily }) => sourceFamily),
  );

/** Owner of a duplicated record when it is actually known; otherwise the copy keeps the original's open outcome. */
const knownOwner = (original: TaxMigrationOutcome): Option.Option<string> =>
  Match.value(original).pipe(
    Match.tag('MAPPED_ACCEPTED', () => Option.some(TAX_OWNER_CAPABILITY)),
    Match.tag('REJECTED_UNMAPPED', ({ targetOwner }) => Option.some(targetOwner)),
    Match.orElse(() => Option.none()),
  );

const duplicateOf = (entry: Entry, original: TaxMigrationOutcome): TaxMigrationOutcome =>
  Option.match(knownOwner(original), {
    onNone: () => ({ ...original, provenance: entry.outcome.provenance }),
    onSome: (targetOwner) =>
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: entry.outcome.provenance,
        reason: 'DUPLICATE_SOURCE_RECORD',
        sourceFamily: taxMigrationOutcomeFamily(original),
        targetOwner,
      }),
  });

/**
 * Within each group, identical meanings keep the first outcome (in a stable order) and reject the copies as
 * duplicates; different meanings are all CONFLICTING, naming every counterpart, and none is chosen by order.
 */
const reconcileGroups = (entries: readonly Entry[]): readonly Entry[] => {
  const ordered = entries.toSorted(
    (left, right) =>
      byProvenance(left.outcome.provenance, right.outcome.provenance) || byText(left.meaning, right.meaning),
  );
  return ordered.map((entry) => {
    const group = ordered.filter(({ groupKey }) => groupKey === entry.groupKey);
    const [first] = group;
    if (group.length === 1 || first === undefined) {
      return entry;
    }
    if (new Set(group.map(({ meaning }) => meaning)).size > 1) {
      const outcome = TaxMigrationConflictingSchema.make({
        counterparts: group.flatMap((other) => (other === entry ? [] : [other.outcome.provenance])),
        provenance: entry.outcome.provenance,
        sourceFamily: taxMigrationOutcomeFamily(entry.outcome),
      });
      return { ...entry, factKey: Option.none(), meaning: meaningOf(outcome), outcome };
    }
    return first === entry ? entry : { ...entry, factKey: Option.none(), outcome: duplicateOf(entry, first.outcome) };
  });
};

/**
 * Evaluates one NON_PRODUCTION dataset deterministically, independent of input order (#960 G duplicate legacy
 * records, F16, F26-F27). One source record identity is one record; and two records mapped to the same exact target
 * fact (Tax Rule predicate and start, or source assertion identity) must agree, otherwise both are CONFLICTING.
 */
export const evaluateTaxMigrationCandidates = (
  candidates: readonly TaxMigrationCandidate[],
): readonly TaxMigrationOutcome[] => {
  const byRecord = reconcileGroups(
    candidates.map((candidate) => {
      const evaluated = evaluateCandidate(candidate);
      return {
        ...evaluated,
        groupKey: sourceKey(candidate.provenance),
        meaning: `${meaningOf(evaluated.outcome)} ${evaluated.rawMeaning}`,
      };
    }),
  );
  const factEntries = byRecord.flatMap((entry) =>
    Option.match(entry.factKey, { onNone: () => [], onSome: (factKey) => [{ ...entry, groupKey: factKey }] }),
  );
  const reconciledFacts = new Map(
    reconcileGroups(factEntries).map((entry) => [provenanceKey(entry.outcome.provenance), entry.outcome]),
  );
  return byRecord.map(({ outcome }) =>
    Match.value(outcome).pipe(
      Match.tag('MAPPED_ACCEPTED', (mapped) => reconciledFacts.get(provenanceKey(mapped.provenance)) ?? mapped),
      Match.orElse((other) => other),
    ),
  );
};

/** Outcomes that still need business work; a family holding any of them is never complete (#960 F16-F18). */
export const isOpenTaxMigrationOutcome = (outcome: TaxMigrationOutcome): boolean =>
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
  // A record mapped into another family does not count for this family's claim (#960 F17).
  // A record of another family, or one resolved as owned elsewhere, is not part of this family's claim; a record of
  // unknown family that is still open could be, so it stays visible (#960 F3, F17).
  const familyOutcomes = outcomes.filter((outcome) =>
    Option.match(taxMigrationOutcomeFamily(outcome), {
      onNone: () => isOpenTaxMigrationOutcome(outcome),
      onSome: (own) => own === family,
    }),
  );
  const observed = new Map(familyOutcomes.map(({ provenance }) => [sourceKey(provenance), sourceOf(provenance)]));
  const expected = new Map(claim.expectedSourceRecords.map((record) => [sourceKey(record), sourceOf(record)]));
  const bySource = (left: TaxMigrationSourceRecord, right: TaxMigrationSourceRecord) =>
    byText(left.sourceSystemRef, right.sourceSystemRef) || byText(left.sourceRecordRef, right.sourceRecordRef);
  const missingSourceRecords = [...expected]
    .flatMap(([key, record]) => (observed.has(key) ? [] : [record]))
    .toSorted(bySource);
  const unexpectedSourceRecords = [...observed]
    .flatMap(([key, record]) => (expected.has(key) ? [] : [record]))
    .toSorted(bySource);
  // One entry per open source record, however many copies of it are open.
  const openSourceRecords = [
    ...new Map(
      familyOutcomes.flatMap((outcome) =>
        isOpenTaxMigrationOutcome(outcome)
          ? [[sourceKey(outcome.provenance), sourceOf(outcome.provenance)] as const]
          : [],
      ),
    ).values(),
  ].toSorted(bySource);
  if (missingSourceRecords.length === 0 && unexpectedSourceRecords.length === 0 && openSourceRecords.length === 0) {
    return TaxMigrationCompleteSchema.make({ family, rowCount });
  }
  return TaxMigrationNotCompleteSchema.make({
    family,
    missingSourceRecords,
    openSourceRecords,
    rowCount,
    unexpectedSourceRecords,
  });
};

const mappedMeaning = (outcome: TaxMigrationOutcome): readonly (readonly [string, string])[] =>
  Match.value(outcome).pipe(
    Match.tag('MAPPED_ACCEPTED', ({ provenance, targetMeaningKey }) => [
      [sourceKey(provenance), targetMeaningKey] as const,
    ]),
    Match.orElse(() => []),
  );

/**
 * Tax Reconciliation of mapped meaning against the TAX target: equal record counts with a different meaning are a
 * difference, never a pass (#960 F14-F15, BDD "Row counts match but semantics differ"); a target holding several
 * meanings for one source record is a conflict whatever the order (F16). It only reports; it never rewrites the
 * target or committed historical facts (F31).
 */
export const reconcileTaxMigrationTarget = (
  outcomes: readonly TaxMigrationOutcome[],
  targetFacts: readonly TaxMigrationTargetFact[],
): readonly TaxMigrationTargetDifference[] => {
  const mapped = new Map(outcomes.flatMap(mappedMeaning));
  const sources = new Map(
    [...outcomes.map(({ provenance }) => provenance), ...targetFacts.map(({ source }) => source)].map((record) => [
      sourceKey(record),
      sourceOf(record),
    ]),
  );
  const held = new Map<string, Set<string>>();
  for (const { source, targetMeaningKey } of targetFacts) {
    const meanings = held.get(sourceKey(source)) ?? new Set<string>();
    meanings.add(targetMeaningKey);
    held.set(sourceKey(source), meanings);
  }
  const differences: TaxMigrationTargetDifference[] = [];
  for (const [key, source] of sources) {
    const expectedMeaning = mapped.get(key);
    const heldMeanings = held.get(key);
    if (heldMeanings !== undefined && heldMeanings.size > 1) {
      differences.push({ difference: 'TARGET_CONFLICT', source });
    } else if (expectedMeaning !== undefined && heldMeanings === undefined) {
      differences.push({ difference: 'MISSING_IN_TARGET', source });
    } else if (expectedMeaning === undefined && heldMeanings !== undefined) {
      differences.push({ difference: 'UNEXPECTED_IN_TARGET', source });
    } else if (expectedMeaning !== undefined && heldMeanings !== undefined && !heldMeanings.has(expectedMeaning)) {
      differences.push({ difference: 'MEANING_DIFFERS', source });
    }
  }
  return differences.toSorted(
    (left, right) =>
      byText(left.source.sourceSystemRef, right.source.sourceSystemRef) ||
      byText(left.source.sourceRecordRef, right.source.sourceRecordRef),
  );
};
