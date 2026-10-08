import type { OperationalScope } from '@app/core-runtime';
import { and, eq, inArray, max } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';

import type {
  CorrectTaxRuleRevisionPayload,
  CreateTaxRulePayload,
  CreateTaxRuleRevisionPayload,
  EndTaxRuleRevisionPayload,
  TaxRuleRevisionContent,
} from '../../shared/actions/tax-governance.ts';
import { taxRuleCorrections, taxRuleRevisionEndFacts, taxRuleRevisions, taxRules } from '../database/schema.ts';
import { optionalIsoInstant, taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import {
  conflict,
  isOwnerId,
  mutation,
  notFound,
  query,
  sameInstant,
  staleBasis,
  trustedInvocation,
  unavailable,
} from './tax-governance-persistence.ts';
import type {
  GovernanceConflict,
  GovernanceNotFound,
  GovernanceStale,
  GovernedInvocation,
  PersistenceUnavailable,
  ScopedTransaction,
} from './tax-governance-persistence.ts';

const MODULE_KEY = 'commerce.tax' as const;
const TAX_RULE_TYPE = 'commerce.tax.tax-rule' as const;
const TAX_RULE_REVISION_TYPE = 'commerce.tax.tax-rule-revision' as const;

export const taxRuleRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: TAX_RULE_TYPE,
  tenantId,
});
export const taxRuleRevisionRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: TAX_RULE_REVISION_TYPE,
  tenantId,
});

/** Semantic fingerprint of immutable revision content (#929 F2-F3). */
export const taxRuleRevisionContentFingerprint = (content: TaxRuleRevisionContent): string =>
  taxMeaningFingerprint({
    compositionKind: content.compositionKind,
    effectiveFrom: DateTime.formatIso(content.effectiveFrom),
    effectiveTo: content.effectiveTo === undefined ? null : DateTime.formatIso(content.effectiveTo),
    jurisdiction: content.jurisdiction,
    ratePercent: content.ratePercent,
    taxClassificationCode: content.taxClassificationCode,
    treatmentCategory: content.treatmentCategory,
  });

/** Lifecycle-aware basis of one revision: its immutable meaning plus its end fact and confirmed corrections. */
export interface TaxRuleRevisionBasis {
  readonly correctedBy: readonly string[];
  readonly endedEffectiveTo: Date | null;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly semanticFingerprint: string;
}

const revisionBasisMeaning = (basis: TaxRuleRevisionBasis) => ({
  correctedBy: basis.correctedBy.toSorted((left, right) => left.localeCompare(right, 'en')),
  endedEffectiveTo: optionalIsoInstant(basis.endedEffectiveTo),
  revisionId: basis.revisionId,
  revisionNumber: basis.revisionNumber,
  semanticFingerprint: basis.semanticFingerprint,
});

/** Expected-current basis for ending or correcting one revision (#949 F20, #955). */
export const taxRuleRevisionBasisFingerprint = (basis: TaxRuleRevisionBasis): string =>
  taxMeaningFingerprint(revisionBasisMeaning(basis));

/** Expected-current basis of the complete governing revision set of one Tax Rule (#949 F20, #955). */
export const taxRuleBasisFingerprint = (taxRuleId: string, bases: readonly TaxRuleRevisionBasis[]): string =>
  taxMeaningFingerprint({
    revisions: bases.toSorted((left, right) => left.revisionNumber - right.revisionNumber).map(revisionBasisMeaning),
    taxRuleId,
  });

type Invocation<Payload> = Payload & GovernedInvocation;
type RevisionRow = typeof taxRuleRevisions.$inferSelect;

export type CreateTaxRuleOutcome =
  | Readonly<{
      created: boolean;
      initialRevisionId: string;
      meaningFingerprint: string;
      revisionNumber: number;
      taxRuleId: string;
    }>
  | GovernanceConflict;
export type CreateTaxRuleRevisionOutcome =
  | Readonly<{ created: boolean; meaningFingerprint: string; revisionId: string; revisionNumber: number }>
  | GovernanceConflict
  | GovernanceNotFound
  | GovernanceStale;
export type EndTaxRuleRevisionOutcome =
  | Readonly<{ ended: boolean; meaningFingerprint: string; revisionId: string }>
  | GovernanceConflict
  | GovernanceNotFound
  | GovernanceStale;
export type CorrectTaxRuleRevisionOutcome =
  | Readonly<{
      correctingRevisionId: string;
      created: boolean;
      meaningFingerprint: string;
      wrongRevisionId: string;
    }>
  | GovernanceConflict
  | GovernanceNotFound
  | GovernanceStale;

export interface TaxRuleGovernancePersistence {
  readonly correctTaxRuleRevision: (
    input: Invocation<CorrectTaxRuleRevisionPayload>,
  ) => Effect.Effect<CorrectTaxRuleRevisionOutcome, PersistenceUnavailable>;
  readonly createTaxRule: (
    input: Invocation<CreateTaxRulePayload>,
  ) => Effect.Effect<CreateTaxRuleOutcome, PersistenceUnavailable>;
  readonly createTaxRuleRevision: (
    input: Invocation<CreateTaxRuleRevisionPayload>,
  ) => Effect.Effect<CreateTaxRuleRevisionOutcome, PersistenceUnavailable>;
  readonly endTaxRuleRevision: (
    input: Invocation<EndTaxRuleRevisionPayload>,
  ) => Effect.Effect<EndTaxRuleRevisionOutcome, PersistenceUnavailable>;
}

const sameAttribution = (
  row: Pick<RevisionRow, 'actionInvocationId' | 'actorPrincipalId' | 'idempotencyKey' | 'provenanceRef' | 'reason'>,
  input: GovernedInvocation & Readonly<{ provenanceRef: string; reason: string }>,
): boolean =>
  [
    row.actionInvocationId === input.actionInvocationId,
    row.actorPrincipalId === input.actorPrincipalId,
    row.idempotencyKey === input.actionInvocationId,
    row.provenanceRef === input.provenanceRef,
    row.reason === input.reason,
  ].every(Boolean);

const revisionValues = (
  input: GovernedInvocation & Readonly<{ provenanceRef: string; reason: string }>,
  revision: Readonly<{
    content: TaxRuleRevisionContent;
    revisionNumber: number;
    supersedesRevisionId: string | null;
    taxRuleId: string;
  }>,
) => ({
  actionInvocationId: input.actionInvocationId,
  actorPrincipalId: input.actorPrincipalId,
  compositionKind: revision.content.compositionKind,
  effectiveFrom: DateTime.toDateUtc(revision.content.effectiveFrom),
  effectiveTo: revision.content.effectiveTo === undefined ? null : DateTime.toDateUtc(revision.content.effectiveTo),
  idempotencyKey: input.actionInvocationId,
  jurisdiction: revision.content.jurisdiction,
  legalEntityId: input.legalEntityId,
  provenanceRef: input.provenanceRef,
  ratePercent: revision.content.ratePercent,
  reason: input.reason,
  revisionNumber: revision.revisionNumber,
  semanticFingerprint: taxRuleRevisionContentFingerprint(revision.content),
  supersedesRevisionId: revision.supersedesRevisionId,
  taxClassificationCode: revision.content.taxClassificationCode,
  taxRuleId: revision.taxRuleId,
  tenantId: input.tenantId,
  treatmentCategory: revision.content.treatmentCategory,
});

/** A revision keeps the stable rule meaning: same Tax Classification and Jurisdiction (#929 F1-F3). */
const keepsRuleMeaning = (
  revisions: readonly RevisionRow[],
  content: Pick<TaxRuleRevisionContent, 'jurisdiction' | 'taxClassificationCode'>,
): boolean =>
  revisions.every(
    (revision) =>
      revision.taxClassificationCode === content.taxClassificationCode &&
      revision.jurisdiction === content.jurisdiction,
  );

const scoped = (table: typeof taxRuleRevisions | typeof taxRules, input: GovernedInvocation) =>
  and(eq(table.tenantId, input.tenantId), eq(table.legalEntityId, input.legalEntityId));

type CorrectionRow = typeof taxRuleCorrections.$inferSelect;

/** Same invocation and same semantic content replays; anything else reuses the key (#955). */
const matchesCorrectionReplay = (
  replay: CorrectionRow,
  replayRevision: RevisionRow | undefined,
  input: Invocation<CorrectTaxRuleRevisionPayload>,
): boolean =>
  replayRevision !== undefined &&
  [
    sameAttribution(replay, input),
    sameAttribution(replayRevision, input),
    replay.legalEntityId === input.legalEntityId,
    replay.wrongRevisionId === input.wrongRevisionRef.resourceId,
    replay.correctingRevisionId === replayRevision.taxRuleRevisionId,
    sameInstant(replay.confirmedAt, DateTime.toDateUtc(input.confirmedAt)),
    replayRevision.supersedesRevisionId === input.wrongRevisionRef.resourceId,
    replayRevision.semanticFingerprint === taxRuleRevisionContentFingerprint(input.correctingContent),
  ].every(Boolean);

export const taxRuleGovernancePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): TaxRuleGovernancePersistence => {
  const revisionByInvocation = (input: GovernedInvocation) =>
    query(
      transaction
        .select()
        .from(taxRuleRevisions)
        .where(
          and(
            eq(taxRuleRevisions.tenantId, input.tenantId),
            eq(taxRuleRevisions.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );

  const revisionById = (input: GovernedInvocation, revisionId: string) =>
    query(
      transaction
        .select()
        .from(taxRuleRevisions)
        .where(and(scoped(taxRuleRevisions, input), eq(taxRuleRevisions.taxRuleRevisionId, revisionId)))
        .limit(1),
    );

  /** Serializes every governed change of one Tax Rule; the rule row itself is never updated. */
  const lockRule = (input: GovernedInvocation, taxRuleId: string) =>
    query(
      transaction
        .select({ taxRuleId: taxRules.taxRuleId })
        .from(taxRules)
        .where(and(scoped(taxRules, input), eq(taxRules.taxRuleId, taxRuleId)))
        .for('update')
        .limit(1),
    );

  /** Complete owner state of one Tax Rule: every revision, end fact and confirmed correction. */
  const loadRuleState = Effect.fn('taxRuleGovernancePersistence.loadRuleState')(function* loadRuleStateEffect(
    input: GovernedInvocation,
    taxRuleId: string,
  ) {
    const revisions = yield* query(
      transaction
        .select()
        .from(taxRuleRevisions)
        .where(and(scoped(taxRuleRevisions, input), eq(taxRuleRevisions.taxRuleId, taxRuleId))),
    );
    const revisionIds = revisions.map((revision) => revision.taxRuleRevisionId);
    if (revisionIds.length === 0) {
      return { bases: [], revisions };
    }
    const { corrections, endFacts } = yield* Effect.all(
      {
        corrections: query(
          transaction
            .select({
              correctingRevisionId: taxRuleCorrections.correctingRevisionId,
              wrongRevisionId: taxRuleCorrections.wrongRevisionId,
            })
            .from(taxRuleCorrections)
            .where(
              and(
                eq(taxRuleCorrections.tenantId, input.tenantId),
                eq(taxRuleCorrections.legalEntityId, input.legalEntityId),
                inArray(taxRuleCorrections.wrongRevisionId, revisionIds),
              ),
            ),
        ),
        endFacts: query(
          transaction
            .select({
              endedEffectiveTo: taxRuleRevisionEndFacts.endedEffectiveTo,
              taxRuleRevisionId: taxRuleRevisionEndFacts.taxRuleRevisionId,
            })
            .from(taxRuleRevisionEndFacts)
            .where(
              and(
                eq(taxRuleRevisionEndFacts.tenantId, input.tenantId),
                eq(taxRuleRevisionEndFacts.legalEntityId, input.legalEntityId),
                inArray(taxRuleRevisionEndFacts.taxRuleRevisionId, revisionIds),
              ),
            ),
        ),
      },
      { concurrency: 1 },
    );
    const bases: TaxRuleRevisionBasis[] = revisions.map((revision) => ({
      correctedBy: corrections.flatMap((correction) =>
        correction.wrongRevisionId === revision.taxRuleRevisionId ? [correction.correctingRevisionId] : [],
      ),
      endedEffectiveTo:
        endFacts.find((endFact) => endFact.taxRuleRevisionId === revision.taxRuleRevisionId)?.endedEffectiveTo ?? null,
      revisionId: revision.taxRuleRevisionId,
      revisionNumber: revision.revisionNumber,
      semanticFingerprint: revision.semanticFingerprint,
    }));
    return { bases, revisions };
  });

  const nextRevisionNumber = (input: GovernedInvocation, taxRuleId: string) =>
    query(
      transaction
        .select({ latest: max(taxRuleRevisions.revisionNumber) })
        .from(taxRuleRevisions)
        .where(and(scoped(taxRuleRevisions, input), eq(taxRuleRevisions.taxRuleId, taxRuleId))),
    ).pipe(Effect.map((rows) => (rows[0]?.latest ?? 0) + 1));

  const createTaxRule: TaxRuleGovernancePersistence['createTaxRule'] = Effect.fn(
    'taxRuleGovernancePersistence.createTaxRule',
  )(function* createTaxRuleEffect(input) {
    if (!trustedInvocation(scope, input, [])) {
      return yield* unavailable();
    }
    const meaningFingerprint = taxRuleRevisionContentFingerprint(input.initialRevision);
    const [replayRule] = yield* query(
      transaction
        .select()
        .from(taxRules)
        .where(and(eq(taxRules.tenantId, input.tenantId), eq(taxRules.idempotencyKey, input.actionInvocationId)))
        .limit(1),
    );
    if (replayRule !== undefined) {
      const [replayRevision] = yield* revisionByInvocation(input);
      const matches =
        replayRevision !== undefined &&
        sameAttribution(replayRule, input) &&
        sameAttribution(replayRevision, input) &&
        replayRule.legalEntityId === input.legalEntityId &&
        replayRule.stableCode === input.stableCode &&
        replayRule.meaningKind === input.meaningKind &&
        replayRevision.taxRuleId === replayRule.taxRuleId &&
        replayRevision.revisionNumber === 1 &&
        replayRevision.semanticFingerprint === meaningFingerprint;
      if (!matches) {
        return conflict('IDEMPOTENCY_REUSED');
      }
      return {
        created: false,
        initialRevisionId: replayRevision.taxRuleRevisionId,
        meaningFingerprint,
        revisionNumber: 1,
        taxRuleId: replayRule.taxRuleId,
      };
    }
    const [duplicate] = yield* query(
      transaction
        .select({ taxRuleId: taxRules.taxRuleId })
        .from(taxRules)
        .where(and(scoped(taxRules, input), eq(taxRules.stableCode, input.stableCode)))
        .limit(1),
    );
    if (duplicate !== undefined) {
      return conflict('STABLE_CODE');
    }
    const rules = yield* mutation(
      transaction
        .insert(taxRules)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          meaningKind: input.meaningKind,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          stableCode: input.stableCode,
          tenantId: input.tenantId,
        })
        .returning({ taxRuleId: taxRules.taxRuleId }),
    );
    if ('kind' in rules) {
      return rules;
    }
    const [rule] = rules;
    if (rule === undefined) {
      return yield* unavailable();
    }
    const revisions = yield* mutation(
      transaction
        .insert(taxRuleRevisions)
        .values(
          revisionValues(input, {
            content: input.initialRevision,
            revisionNumber: 1,
            supersedesRevisionId: null,
            taxRuleId: rule.taxRuleId,
          }),
        )
        .returning({ taxRuleRevisionId: taxRuleRevisions.taxRuleRevisionId }),
    );
    if ('kind' in revisions) {
      return revisions;
    }
    const [revision] = revisions;
    return revision === undefined
      ? yield* unavailable()
      : {
          created: true,
          initialRevisionId: revision.taxRuleRevisionId,
          meaningFingerprint,
          revisionNumber: 1,
          taxRuleId: rule.taxRuleId,
        };
  });

  const createTaxRuleRevision: TaxRuleGovernancePersistence['createTaxRuleRevision'] = Effect.fn(
    'taxRuleGovernancePersistence.createTaxRuleRevision',
  )(function* createTaxRuleRevisionEffect(input) {
    if (!trustedInvocation(scope, input, [input.taxRuleRef.tenantId])) {
      return yield* unavailable();
    }
    const meaningFingerprint = taxRuleRevisionContentFingerprint(input.content);
    const [replay] = yield* revisionByInvocation(input);
    if (replay !== undefined) {
      const matches =
        sameAttribution(replay, input) &&
        replay.legalEntityId === input.legalEntityId &&
        replay.taxRuleId === input.taxRuleRef.resourceId &&
        replay.supersedesRevisionId === null &&
        replay.semanticFingerprint === meaningFingerprint;
      return matches
        ? {
            created: false,
            meaningFingerprint,
            revisionId: replay.taxRuleRevisionId,
            revisionNumber: replay.revisionNumber,
          }
        : conflict('IDEMPOTENCY_REUSED');
    }
    const taxRuleId = input.taxRuleRef.resourceId;
    if (!isOwnerId(taxRuleId)) {
      return notFound;
    }
    const [locked] = yield* lockRule(input, taxRuleId);
    if (locked === undefined) {
      return notFound;
    }
    const state = yield* loadRuleState(input, taxRuleId);
    if (input.expectedBasisFingerprint !== taxRuleBasisFingerprint(taxRuleId, state.bases)) {
      return staleBasis;
    }
    if (!keepsRuleMeaning(state.revisions, input.content)) {
      return conflict('MEANING_CHANGED');
    }
    const revisionNumber = yield* nextRevisionNumber(input, taxRuleId);
    const rows = yield* mutation(
      transaction
        .insert(taxRuleRevisions)
        .values(
          revisionValues(input, { content: input.content, revisionNumber, supersedesRevisionId: null, taxRuleId }),
        )
        .returning({ taxRuleRevisionId: taxRuleRevisions.taxRuleRevisionId }),
    );
    if ('kind' in rows) {
      return rows;
    }
    const [row] = rows;
    return row === undefined
      ? yield* unavailable()
      : { created: true, meaningFingerprint, revisionId: row.taxRuleRevisionId, revisionNumber };
  });

  const endTaxRuleRevision: TaxRuleGovernancePersistence['endTaxRuleRevision'] = Effect.fn(
    'taxRuleGovernancePersistence.endTaxRuleRevision',
  )(function* endTaxRuleRevisionEffect(input) {
    if (!trustedInvocation(scope, input, [input.taxRuleRevisionRef.tenantId])) {
      return yield* unavailable();
    }
    const revisionId = input.taxRuleRevisionRef.resourceId;
    const endedEffectiveTo = DateTime.toDateUtc(input.endedEffectiveTo);
    const meaningFingerprint = taxMeaningFingerprint({
      endedEffectiveTo: DateTime.formatIso(input.endedEffectiveTo),
      revisionId,
    });
    const [replay] = yield* query(
      transaction
        .select()
        .from(taxRuleRevisionEndFacts)
        .where(
          and(
            eq(taxRuleRevisionEndFacts.tenantId, input.tenantId),
            eq(taxRuleRevisionEndFacts.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    if (replay !== undefined) {
      const matches =
        sameAttribution(replay, input) &&
        replay.legalEntityId === input.legalEntityId &&
        replay.taxRuleRevisionId === revisionId &&
        sameInstant(replay.endedEffectiveTo, endedEffectiveTo);
      return matches ? { ended: false, meaningFingerprint, revisionId } : conflict('IDEMPOTENCY_REUSED');
    }
    if (!isOwnerId(revisionId)) {
      return notFound;
    }
    const [revision] = yield* revisionById(input, revisionId);
    if (revision === undefined) {
      return notFound;
    }
    yield* lockRule(input, revision.taxRuleId);
    const state = yield* loadRuleState(input, revision.taxRuleId);
    const basis = state.bases.find((candidate) => candidate.revisionId === revisionId);
    if (basis === undefined) {
      return yield* unavailable();
    }
    if (input.expectedBasisFingerprint !== taxRuleRevisionBasisFingerprint(basis)) {
      return staleBasis;
    }
    // Ending only shortens a revision that is not ended yet: the end lies inside (effective_from, effective_to).
    const shortens =
      basis.endedEffectiveTo === null &&
      endedEffectiveTo.getTime() > revision.effectiveFrom.getTime() &&
      (revision.effectiveTo === null || endedEffectiveTo.getTime() < revision.effectiveTo.getTime());
    if (!shortens) {
      return conflict('LIFECYCLE');
    }
    const inserted = yield* mutation(
      transaction
        .insert(taxRuleRevisionEndFacts)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          endedEffectiveTo,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          taxRuleRevisionId: revisionId,
          tenantId: input.tenantId,
        })
        .returning({ endFactId: taxRuleRevisionEndFacts.taxRuleRevisionEndFactId }),
    );
    if ('kind' in inserted) {
      return inserted;
    }
    return { ended: true, meaningFingerprint, revisionId };
  });

  const correctTaxRuleRevision: TaxRuleGovernancePersistence['correctTaxRuleRevision'] = Effect.fn(
    'taxRuleGovernancePersistence.correctTaxRuleRevision',
  )(function* correctTaxRuleRevisionEffect(input) {
    if (!trustedInvocation(scope, input, [input.wrongRevisionRef.tenantId])) {
      return yield* unavailable();
    }
    const wrongRevisionId = input.wrongRevisionRef.resourceId;
    const meaningFingerprint = taxRuleRevisionContentFingerprint(input.correctingContent);
    const [replay] = yield* query(
      transaction
        .select()
        .from(taxRuleCorrections)
        .where(
          and(
            eq(taxRuleCorrections.tenantId, input.tenantId),
            eq(taxRuleCorrections.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    if (replay !== undefined) {
      const [replayRevision] = yield* revisionByInvocation(input);
      return matchesCorrectionReplay(replay, replayRevision, input)
        ? {
            correctingRevisionId: replay.correctingRevisionId,
            created: false,
            meaningFingerprint,
            wrongRevisionId,
          }
        : conflict('IDEMPOTENCY_REUSED');
    }
    if (!isOwnerId(wrongRevisionId)) {
      return notFound;
    }
    const [wrong] = yield* revisionById(input, wrongRevisionId);
    if (wrong === undefined) {
      return notFound;
    }
    yield* lockRule(input, wrong.taxRuleId);
    const state = yield* loadRuleState(input, wrong.taxRuleId);
    const basis = state.bases.find((candidate) => candidate.revisionId === wrongRevisionId);
    if (basis === undefined) {
      return yield* unavailable();
    }
    if (input.expectedBasisFingerprint !== taxRuleRevisionBasisFingerprint(basis)) {
      return staleBasis;
    }
    if (!keepsRuleMeaning(state.revisions, input.correctingContent)) {
      return conflict('MEANING_CHANGED');
    }
    const revisionNumber = yield* nextRevisionNumber(input, wrong.taxRuleId);
    // The correcting revision and its provenance row commit atomically; the wrong revision is never mutated.
    const rows = yield* mutation(
      transaction
        .insert(taxRuleRevisions)
        .values(
          revisionValues(input, {
            content: input.correctingContent,
            revisionNumber,
            supersedesRevisionId: wrongRevisionId,
            taxRuleId: wrong.taxRuleId,
          }),
        )
        .returning({ taxRuleRevisionId: taxRuleRevisions.taxRuleRevisionId }),
    );
    if ('kind' in rows) {
      return rows;
    }
    const [correcting] = rows;
    if (correcting === undefined) {
      return yield* unavailable();
    }
    const correction = yield* mutation(
      transaction
        .insert(taxRuleCorrections)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          confirmedAt: DateTime.toDateUtc(input.confirmedAt),
          correctingRevisionId: correcting.taxRuleRevisionId,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          tenantId: input.tenantId,
          wrongRevisionId,
        })
        .returning({ correctionId: taxRuleCorrections.taxRuleCorrectionId }),
    );
    if ('kind' in correction) {
      return correction;
    }
    return {
      correctingRevisionId: correcting.taxRuleRevisionId,
      created: true,
      meaningFingerprint,
      wrongRevisionId,
    };
  });

  return Object.freeze({ correctTaxRuleRevision, createTaxRule, createTaxRuleRevision, endTaxRuleRevision });
};

export const taxRuleGovernanceServiceFactory = (transaction: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(taxRuleGovernancePersistenceForScope(transaction, scope));
