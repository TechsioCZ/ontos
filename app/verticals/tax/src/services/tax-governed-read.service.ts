import type { OperationalScope } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { TaxRuleMeaningKindSchema, TaxRuleRevisionContentSchema } from '../../shared/actions/tax-governance.ts';
import type {
  ApplicableTaxRuleSetRequest,
  ApplicableTaxRuleSetResponse,
} from '../../shared/apis/applicable-tax-rule-set.ts';
import type {
  TaxFactAuthorityCurrentRequest,
  TaxFactAuthorityCurrentResponse,
} from '../../shared/apis/tax-fact-authority-current.ts';
import type { TaxRuleHistoryRequest, TaxRuleHistoryResponse } from '../../shared/apis/tax-rule-history.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
} from '../database/schema.ts';
import { selectApplicableTaxRuleRevision } from '../domain/tax-rule-selection.ts';
import type { TaxRuleRevisionState } from '../domain/tax-rule-selection.ts';
import { TaxRelevantTimeSchema } from '../domain/tax-time.ts';
import {
  authorityCoversInstant,
  currentContractRevisions,
  taxFactAuthorityContractBasisFingerprint,
  taxFactAuthorityContractRef,
} from './tax-authority-governance.service.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import { isOwnerId, query, unavailable } from './tax-governance-persistence.ts';
import type { PersistenceUnavailable, ScopedTransaction } from './tax-governance-persistence.ts';
import {
  taxRuleBasisFingerprint,
  taxRuleRef,
  taxRuleRevisionBasisFingerprint,
  taxRuleRevisionRef,
} from './tax-rule-governance.service.ts';
import type { TaxRuleRevisionBasis } from './tax-rule-governance.service.ts';

type RevisionRow = typeof taxRuleRevisions.$inferSelect;
type EndFactRow = typeof taxRuleRevisionEndFacts.$inferSelect;
type CorrectionRow = typeof taxRuleCorrections.$inferSelect;

const instant = (value: Date) => DateTime.makeUnsafe(value);
const optionalInstant = (value: Date | null) => Option.map(Option.fromNullOr(value), instant);
const byText = (left: string, right: string) => left.localeCompare(right, 'en');

/** Owner-local governed TAX reads bound to one scoped transaction. */
export interface TaxGovernedReads {
  readonly applicableTaxRuleSet: (
    request: ApplicableTaxRuleSetRequest,
  ) => Effect.Effect<ApplicableTaxRuleSetResponse, PersistenceUnavailable>;
  readonly taxFactAuthorityCurrent: (
    request: TaxFactAuthorityCurrentRequest,
  ) => Effect.Effect<TaxFactAuthorityCurrentResponse, PersistenceUnavailable>;
  /** None when the Tax Rule is not visible in the trusted Tenant and Selling Legal Entity scope. */
  readonly taxRuleHistory: (
    request: TaxRuleHistoryRequest,
  ) => Effect.Effect<Option.Option<TaxRuleHistoryResponse>, PersistenceUnavailable>;
}

const basisOf = (
  revision: RevisionRow,
  endFacts: readonly EndFactRow[],
  corrections: readonly CorrectionRow[],
): TaxRuleRevisionBasis => ({
  correctedBy: corrections.flatMap((correction) =>
    correction.wrongRevisionId === revision.taxRuleRevisionId ? [correction.correctingRevisionId] : [],
  ),
  endedEffectiveTo:
    endFacts.find((endFact) => endFact.taxRuleRevisionId === revision.taxRuleRevisionId)?.endedEffectiveTo ?? null,
  revisionId: revision.taxRuleRevisionId,
  revisionNumber: revision.revisionNumber,
  semanticFingerprint: revision.semanticFingerprint,
});

/** Stored revision meaning echoed from the row; a value outside the owner vocabulary is never guessed. */
const StoredRevisionMeaningSchema = Schema.Struct({
  compositionKind: TaxRuleRevisionContentSchema.fields.compositionKind,
  jurisdiction: TaxRuleRevisionContentSchema.fields.jurisdiction,
  treatmentCategory: TaxRuleRevisionContentSchema.fields.treatmentCategory,
});
type StoredRevisionMeaning = typeof StoredRevisionMeaningSchema.Type;
const decodeStoredMeaning = (revision: RevisionRow) =>
  Schema.decodeUnknownEffect(StoredRevisionMeaningSchema)({
    compositionKind: revision.compositionKind,
    jurisdiction: revision.jurisdiction,
    treatmentCategory: revision.treatmentCategory,
  }).pipe(Effect.mapError(unavailable));
const decodeMeaningKind = (meaningKind: string) =>
  Schema.decodeUnknownEffect(TaxRuleMeaningKindSchema)(meaningKind).pipe(Effect.mapError(unavailable));

const toSelectionState = (
  basis: TaxRuleRevisionBasis,
  revision: RevisionRow,
  meaning: StoredRevisionMeaning,
): TaxRuleRevisionState => ({
  compositionKind: meaning.compositionKind,
  correctedBy: basis.correctedBy,
  effectiveFrom: instant(revision.effectiveFrom),
  effectiveTo: optionalInstant(revision.effectiveTo),
  endedEffectiveTo: optionalInstant(basis.endedEffectiveTo),
  ratePercent: revision.ratePercent,
  revisionId: revision.taxRuleRevisionId,
  revisionNumber: revision.revisionNumber,
  taxRuleId: revision.taxRuleId,
  treatmentCategory: meaning.treatmentCategory,
});

/** One revision of the evidence history, echoing the stored row and its separate lifecycle facts. */
const historyRevision = ({
  endFacts,
  meaning,
  revision,
  tenantId,
}: Readonly<{
  endFacts: readonly EndFactRow[];
  meaning: StoredRevisionMeaning;
  revision: RevisionRow;
  tenantId: string;
}>) => {
  const endFact = endFacts.find((candidate) => candidate.taxRuleRevisionId === revision.taxRuleRevisionId);
  return {
    ...meaning,
    effectiveFrom: instant(revision.effectiveFrom),
    effectiveTo: optionalInstant(revision.effectiveTo),
    endFact: Option.map(Option.fromUndefinedOr(endFact), (fact) => ({
      endedEffectiveTo: instant(fact.endedEffectiveTo),
      provenanceRef: fact.provenanceRef,
      reason: fact.reason,
      recordedAt: instant(fact.recordedAt),
    })),
    provenanceRef: revision.provenanceRef,
    ratePercent: revision.ratePercent,
    reason: revision.reason,
    recordedAt: instant(revision.recordedAt),
    revisionNumber: revision.revisionNumber,
    semanticFingerprint: revision.semanticFingerprint,
    supersedesRevisionRef: Option.map(Option.fromNullOr(revision.supersedesRevisionId), (revisionId) =>
      taxRuleRevisionRef(tenantId, revisionId),
    ),
    taxClassificationCode: revision.taxClassificationCode,
    taxRuleRevisionRef: taxRuleRevisionRef(tenantId, revision.taxRuleRevisionId),
  };
};

/** Zero or one covering System of Record is decisive; several are a configuration conflict (#949 F28-F32). */
const authorityOutcome = (covering: number): TaxFactAuthorityCurrentResponse['outcome'] => {
  if (covering === 0) {
    return 'AUTHORITY_MISSING';
  }
  return covering === 1 ? 'AUTHORITY_ESTABLISHED' : 'AUTHORITY_CONFLICT';
};

export const taxGovernedReadsForScope = (transaction: ScopedTransaction, scope: OperationalScope): TaxGovernedReads => {
  const { tenantId } = scope;
  const legalEntityId = scope.legalEntityId ?? '';

  /**
   * Revisions with their end facts and confirmed corrections in ONE statement, hence one snapshot even under
   * READ COMMITTED: a concurrently committed correction is either wholly visible or wholly absent, never torn
   * (#930 F6-F7, #942 F15, F18).
   */
  const revisionStates = Effect.fn('taxGovernedReads.revisionStates')(function* revisionStatesEffect(
    predicate: SQL | undefined,
  ) {
    const rows = yield* query(
      transaction
        .select({ correction: taxRuleCorrections, endFact: taxRuleRevisionEndFacts, revision: taxRuleRevisions })
        .from(taxRuleRevisions)
        .leftJoin(
          taxRuleRevisionEndFacts,
          and(
            eq(taxRuleRevisionEndFacts.tenantId, taxRuleRevisions.tenantId),
            eq(taxRuleRevisionEndFacts.legalEntityId, taxRuleRevisions.legalEntityId),
            eq(taxRuleRevisionEndFacts.taxRuleRevisionId, taxRuleRevisions.taxRuleRevisionId),
          ),
        )
        .leftJoin(
          taxRuleCorrections,
          and(
            eq(taxRuleCorrections.tenantId, taxRuleRevisions.tenantId),
            eq(taxRuleCorrections.legalEntityId, taxRuleRevisions.legalEntityId),
            eq(taxRuleCorrections.wrongRevisionId, taxRuleRevisions.taxRuleRevisionId),
          ),
        )
        .where(
          and(eq(taxRuleRevisions.tenantId, tenantId), eq(taxRuleRevisions.legalEntityId, legalEntityId), predicate),
        ),
    );
    const revisions = new Map<string, RevisionRow>();
    const endFacts = new Map<string, EndFactRow>();
    const corrections = new Map<string, CorrectionRow>();
    for (const row of rows) {
      revisions.set(row.revision.taxRuleRevisionId, row.revision);
      if (row.endFact !== null) {
        endFacts.set(row.endFact.taxRuleRevisionEndFactId, row.endFact);
      }
      if (row.correction !== null) {
        corrections.set(row.correction.taxRuleCorrectionId, row.correction);
      }
    }
    return {
      corrections: [...corrections.values()],
      endFacts: [...endFacts.values()],
      revisions: [...revisions.values()],
    };
  });

  const applicableTaxRuleSet: TaxGovernedReads['applicableTaxRuleSet'] = Effect.fn(
    'taxGovernedReads.applicableTaxRuleSet',
  )(function* applicableTaxRuleSetEffect(request) {
    if (scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    const predicate = { jurisdiction: request.jurisdiction, taxClassificationCode: request.taxClassificationCode };
    // The complete predicate state in one owner transaction; no pagination or partial query (#942 F9-F12).
    const { corrections, endFacts, revisions } = yield* revisionStates(
      and(
        eq(taxRuleRevisions.jurisdiction, request.jurisdiction),
        eq(taxRuleRevisions.taxClassificationCode, request.taxClassificationCode),
      ),
    );
    const bases = revisions.map((revision) => basisOf(revision, endFacts, corrections));
    const predicateFingerprint = taxMeaningFingerprint({ ...predicate, legalEntityId });
    const states = yield* Effect.forEach(
      revisions,
      (revision) =>
        decodeStoredMeaning(revision).pipe(
          Effect.map((meaning) => toSelectionState(basisOf(revision, endFacts, corrections), revision, meaning)),
        ),
      { concurrency: 1 },
    );
    const selection = selectApplicableTaxRuleRevision({
      completeState: { predicateFingerprint, revisions: states },
      taxRelevantTime: TaxRelevantTimeSchema.make(request.taxRelevantTime),
    });
    const applicable = selection.kind === 'SELECTED' ? [selection.revision] : selection.applicable;
    const fingerprints = new Map(
      revisions.map((revision) => [revision.taxRuleRevisionId, revision.semanticFingerprint]),
    );
    return {
      applicable: applicable.map((state) => ({
        compositionKind: state.compositionKind,
        effectiveFrom: state.effectiveFrom,
        effectiveTo: state.effectiveTo,
        endedEffectiveTo: state.endedEffectiveTo,
        ratePercent: state.ratePercent,
        revisionNumber: state.revisionNumber,
        semanticFingerprint: fingerprints.get(state.revisionId) ?? '',
        taxRuleRef: taxRuleRef(tenantId, state.taxRuleId),
        taxRuleRevisionRef: taxRuleRevisionRef(tenantId, state.revisionId),
        treatmentCategory: state.treatmentCategory,
      })),
      completeness: {
        predicate,
        predicateFingerprint,
        rowCount: revisions.length,
        setFingerprint: taxMeaningFingerprint({
          predicateFingerprint,
          revisions: bases.map(taxRuleRevisionBasisFingerprint).toSorted(byText),
        }),
      },
      excludedByCorrection: selection.excludedByCorrection.map((provenance) => ({
        correctingRevisionRef: taxRuleRevisionRef(tenantId, provenance.correctingRevisionId),
        wrongRevisionRef: taxRuleRevisionRef(tenantId, provenance.wrongRevisionId),
      })),
      outcome: selection.kind === 'SELECTED' ? 'SELECTED' : selection.outcome._tag,
      taxRelevantTime: request.taxRelevantTime,
    };
  });

  const taxRuleHistory: TaxGovernedReads['taxRuleHistory'] = Effect.fn('taxGovernedReads.taxRuleHistory')(
    function* taxRuleHistoryEffect(request) {
      const taxRuleId = request.taxRuleRef.resourceId;
      if (scope.legalEntityId === undefined || request.taxRuleRef.tenantId !== tenantId || !isOwnerId(taxRuleId)) {
        return Option.none();
      }
      const [rule] = yield* query(
        transaction
          .select()
          .from(taxRules)
          .where(
            and(
              eq(taxRules.tenantId, tenantId),
              eq(taxRules.legalEntityId, legalEntityId),
              eq(taxRules.taxRuleId, taxRuleId),
            ),
          )
          .limit(1),
      );
      if (rule === undefined) {
        return Option.none();
      }
      // The rule row is immutable; its whole lifecycle state is read in one statement.
      const { corrections, endFacts, revisions } = yield* revisionStates(eq(taxRuleRevisions.taxRuleId, taxRuleId));
      const ordered = revisions.toSorted((left, right) => left.revisionNumber - right.revisionNumber);
      const bases = ordered.map((revision) => basisOf(revision, endFacts, corrections));
      const meaningKind = yield* decodeMeaningKind(rule.meaningKind);
      const historyRevisions = yield* Effect.forEach(
        ordered,
        (revision) =>
          decodeStoredMeaning(revision).pipe(
            Effect.map((meaning) => historyRevision({ endFacts, meaning, revision, tenantId })),
          ),
        { concurrency: 1 },
      );
      return Option.some({
        basisFingerprint: taxRuleBasisFingerprint(taxRuleId, bases),
        corrections: corrections
          .toSorted((left, right) => byText(left.taxRuleCorrectionId, right.taxRuleCorrectionId))
          .map((correction) => ({
            confirmedAt: instant(correction.confirmedAt),
            correctingRevisionRef: taxRuleRevisionRef(tenantId, correction.correctingRevisionId),
            provenanceRef: correction.provenanceRef,
            reason: correction.reason,
            recordedAt: instant(correction.recordedAt),
            wrongRevisionRef: taxRuleRevisionRef(tenantId, correction.wrongRevisionId),
          })),
        meaningKind,
        revisions: historyRevisions,
        stableCode: rule.stableCode,
        taxRuleRef: taxRuleRef(tenantId, rule.taxRuleId),
      });
    },
  );

  const taxFactAuthorityCurrent: TaxGovernedReads['taxFactAuthorityCurrent'] = Effect.fn(
    'taxGovernedReads.taxFactAuthorityCurrent',
  )(function* taxFactAuthorityCurrentEffect(request) {
    if (scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    // Contracts and their revisions in one statement, hence one snapshot of the complete authority set.
    const rows = yield* query(
      transaction
        .select({ contract: taxFactAuthorityContracts, revision: taxFactAuthorityContractRevisions })
        .from(taxFactAuthorityContractRevisions)
        .innerJoin(
          taxFactAuthorityContracts,
          and(
            eq(taxFactAuthorityContracts.tenantId, taxFactAuthorityContractRevisions.tenantId),
            eq(taxFactAuthorityContracts.legalEntityId, taxFactAuthorityContractRevisions.legalEntityId),
            eq(
              taxFactAuthorityContracts.taxFactAuthorityContractId,
              taxFactAuthorityContractRevisions.taxFactAuthorityContractId,
            ),
          ),
        )
        .where(
          and(
            eq(taxFactAuthorityContractRevisions.tenantId, tenantId),
            eq(taxFactAuthorityContractRevisions.legalEntityId, legalEntityId),
            eq(taxFactAuthorityContracts.factFamily, request.factFamily),
          ),
        ),
    );
    const revisions = rows.map((row) => row.revision);
    const contracts = rows.map((row) => row.contract);
    const current = [...currentContractRevisions(revisions).values()];
    const covering = current
      .filter((revision) => authorityCoversInstant(revision, request.instant))
      .toSorted((left, right) => byText(left.taxFactAuthorityContractId, right.taxFactAuthorityContractId));
    const stableCodes = new Map(
      contracts.map((contract) => [contract.taxFactAuthorityContractId, contract.stableCode]),
    );
    return {
      authorities: covering.map((revision) => ({
        authorityFrom: instant(revision.authorityFrom),
        authorityTo: optionalInstant(revision.authorityTo),
        basisFingerprint: taxFactAuthorityContractBasisFingerprint(revision),
        contractRef: taxFactAuthorityContractRef(tenantId, revision.taxFactAuthorityContractId),
        evidenceSourceRefs: revision.evidenceSourceRefs,
        revisionNumber: revision.revisionNumber,
        stableCode: stableCodes.get(revision.taxFactAuthorityContractId) ?? '',
        systemOfRecordRef: revision.systemOfRecordRef,
      })),
      completeness: {
        rowCount: current.length,
        setFingerprint: taxMeaningFingerprint({
          contracts: current.map(taxFactAuthorityContractBasisFingerprint).toSorted(byText),
          factFamily: request.factFamily,
          legalEntityId,
        }),
      },
      factFamily: request.factFamily,
      instant: request.instant,
      outcome: authorityOutcome(covering.length),
    };
  });

  return Object.freeze({ applicableTaxRuleSet, taxFactAuthorityCurrent, taxRuleHistory });
};
