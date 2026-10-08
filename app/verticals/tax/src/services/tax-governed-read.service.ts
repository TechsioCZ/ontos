import type { OperationalScope } from '@app/core-runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

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

const toSelectionState = (basis: TaxRuleRevisionBasis, revision: RevisionRow): TaxRuleRevisionState => ({
  compositionKind: 'EXCLUSIVE',
  correctedBy: basis.correctedBy,
  effectiveFrom: instant(revision.effectiveFrom),
  effectiveTo: optionalInstant(revision.effectiveTo),
  endedEffectiveTo: optionalInstant(basis.endedEffectiveTo),
  ratePercent: revision.ratePercent,
  revisionId: revision.taxRuleRevisionId,
  revisionNumber: revision.revisionNumber,
  taxRuleId: revision.taxRuleId,
  treatmentCategory: 'TAXABLE',
});

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

  /** End facts and corrections of the given revisions; empty input never reaches the database. */
  const lifecycleOf = (revisionIds: readonly string[]) =>
    revisionIds.length === 0
      ? Effect.succeed({ corrections: [], endFacts: [] })
      : Effect.all(
          {
            corrections: query(
              transaction
                .select()
                .from(taxRuleCorrections)
                .where(
                  and(
                    eq(taxRuleCorrections.tenantId, tenantId),
                    eq(taxRuleCorrections.legalEntityId, legalEntityId),
                    inArray(taxRuleCorrections.wrongRevisionId, revisionIds),
                  ),
                ),
            ),
            endFacts: query(
              transaction
                .select()
                .from(taxRuleRevisionEndFacts)
                .where(
                  and(
                    eq(taxRuleRevisionEndFacts.tenantId, tenantId),
                    eq(taxRuleRevisionEndFacts.legalEntityId, legalEntityId),
                    inArray(taxRuleRevisionEndFacts.taxRuleRevisionId, revisionIds),
                  ),
                ),
            ),
          },
          { concurrency: 1 },
        );

  const applicableTaxRuleSet: TaxGovernedReads['applicableTaxRuleSet'] = Effect.fn(
    'taxGovernedReads.applicableTaxRuleSet',
  )(function* applicableTaxRuleSetEffect(request) {
    if (scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    const predicate = { jurisdiction: request.jurisdiction, taxClassificationCode: request.taxClassificationCode };
    // The complete predicate state in one owner transaction; no pagination or partial query (#942 F9-F12).
    const revisions = yield* query(
      transaction
        .select()
        .from(taxRuleRevisions)
        .where(
          and(
            eq(taxRuleRevisions.tenantId, tenantId),
            eq(taxRuleRevisions.legalEntityId, legalEntityId),
            eq(taxRuleRevisions.jurisdiction, request.jurisdiction),
            eq(taxRuleRevisions.taxClassificationCode, request.taxClassificationCode),
          ),
        ),
    );
    const { corrections, endFacts } = yield* lifecycleOf(revisions.map((revision) => revision.taxRuleRevisionId));
    const bases = revisions.map((revision) => basisOf(revision, endFacts, corrections));
    const predicateFingerprint = taxMeaningFingerprint({ ...predicate, legalEntityId });
    const selection = selectApplicableTaxRuleRevision({
      completeState: {
        predicateFingerprint,
        revisions: revisions.map((revision) => toSelectionState(basisOf(revision, endFacts, corrections), revision)),
      },
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
      const revisions = yield* query(
        transaction
          .select()
          .from(taxRuleRevisions)
          .where(
            and(
              eq(taxRuleRevisions.tenantId, tenantId),
              eq(taxRuleRevisions.legalEntityId, legalEntityId),
              eq(taxRuleRevisions.taxRuleId, taxRuleId),
            ),
          ),
      );
      const { corrections, endFacts } = yield* lifecycleOf(revisions.map((revision) => revision.taxRuleRevisionId));
      const ordered = revisions.toSorted((left, right) => left.revisionNumber - right.revisionNumber);
      const bases = ordered.map((revision) => basisOf(revision, endFacts, corrections));
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
        meaningKind: 'VAT_RATE' as const,
        revisions: ordered.map((revision) => {
          const endFact = endFacts.find((candidate) => candidate.taxRuleRevisionId === revision.taxRuleRevisionId);
          return {
            basisFingerprint: taxRuleRevisionBasisFingerprint(basisOf(revision, endFacts, corrections)),
            compositionKind: 'EXCLUSIVE' as const,
            effectiveFrom: instant(revision.effectiveFrom),
            effectiveTo: optionalInstant(revision.effectiveTo),
            endFact: Option.map(Option.fromUndefinedOr(endFact), (fact) => ({
              endedEffectiveTo: instant(fact.endedEffectiveTo),
              provenanceRef: fact.provenanceRef,
              reason: fact.reason,
              recordedAt: instant(fact.recordedAt),
            })),
            jurisdiction: 'CZ_DOMESTIC' as const,
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
            treatmentCategory: 'TAXABLE' as const,
          };
        }),
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
    const contracts = yield* query(
      transaction
        .select()
        .from(taxFactAuthorityContracts)
        .where(
          and(
            eq(taxFactAuthorityContracts.tenantId, tenantId),
            eq(taxFactAuthorityContracts.legalEntityId, legalEntityId),
            eq(taxFactAuthorityContracts.factFamily, request.factFamily),
          ),
        ),
    );
    const contractIds = contracts.map((contract) => contract.taxFactAuthorityContractId);
    const revisions =
      contractIds.length === 0
        ? []
        : yield* query(
            transaction
              .select()
              .from(taxFactAuthorityContractRevisions)
              .where(
                and(
                  eq(taxFactAuthorityContractRevisions.tenantId, tenantId),
                  eq(taxFactAuthorityContractRevisions.legalEntityId, legalEntityId),
                  inArray(taxFactAuthorityContractRevisions.taxFactAuthorityContractId, contractIds),
                ),
              ),
          );
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
