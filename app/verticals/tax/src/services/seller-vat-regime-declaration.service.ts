import type { OperationalScope } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import type {
  DeclareSellerVatRegimePayload,
  DeclareSellerVatRegimeResult,
  ImportSellerVatRegimeDeclarationsPayload,
  ImportSellerVatRegimeDeclarationsResult,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import {
  ReplacedScheduledSellerVatRegimeDeclarationSchema,
  SellerVatRegimeDeclarationProvenanceSchema,
  SellerVatRegimeEffectiveFromOriginSchema,
  SellerVatRegimeSchema,
} from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
import type {
  SellerVatRegimeAtInstantRequestContract,
  SellerVatRegimeAtInstantResponseContract,
  SellerVatRegimeHistoryResponseContract,
} from '../../shared/domain/seller-vat-regime-contracts.ts';
import { taxSellerVatRegimeDeclarations } from '../database/schema.ts';
import {
  evaluateSellerVatRegimeDeclaration,
  sellerVatRegimeAt,
  sellerVatRegimeHead,
} from '../domain/seller-vat-regime-timeline.ts';
import type { SellerVatRegimeDeclarationRevision } from '../domain/seller-vat-regime-timeline.ts';
import { planSellerVatRegimeImport, sellerVatRegimeImportDisposition } from '../domain/seller-vat-regime-import.ts';
import type {
  ImportedSellerVatRegimeRevision,
  StoredSellerVatRegimeRevision,
} from '../domain/seller-vat-regime-import.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import {
  conflict,
  lockTaxScopeKey,
  mutation,
  query,
  staleBasis,
  trustedInvocation,
  unavailable,
} from './tax-governance-persistence.ts';
import type {
  GovernanceConflict,
  GovernanceStale,
  GovernedInvocation,
  PersistenceUnavailable,
  ScopedTransaction,
} from './tax-governance-persistence.ts';

const MODULE_KEY = 'commerce.tax' as const;
const DECLARATION_RESOURCE_TYPE = 'commerce.tax.seller-vat-regime-declaration' as const;

export const sellerVatRegimeDeclarationRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: DECLARATION_RESOURCE_TYPE,
  tenantId,
});

type DeclarationRow = typeof taxSellerVatRegimeDeclarations.$inferSelect;
type Invocation<Payload> = Payload & GovernedInvocation;

/** What the Action audits besides the typed result. */
export interface SellerVatRegimeDeclarationOutcome {
  readonly audit: Readonly<{ changed: boolean; meaningFingerprint: string; resourceId: string; resourceType: string }>;
  readonly result: DeclareSellerVatRegimeResult;
}

/** What the import Action audits besides the typed result. */
export interface SellerVatRegimeImportOutcome {
  readonly audit: SellerVatRegimeDeclarationOutcome['audit'];
  readonly result: ImportSellerVatRegimeDeclarationsResult;
}

export interface SellerVatRegimeDeclarations {
  readonly atInstant: (
    request: SellerVatRegimeAtInstantRequestContract,
  ) => Effect.Effect<Option.Option<SellerVatRegimeAtInstantResponseContract>, PersistenceUnavailable>;
  readonly declare: (
    input: Invocation<DeclareSellerVatRegimePayload>,
  ) => Effect.Effect<SellerVatRegimeDeclarationOutcome | GovernanceConflict | GovernanceStale, PersistenceUnavailable>;
  readonly history: Effect.Effect<Option.Option<SellerVatRegimeHistoryResponseContract>, PersistenceUnavailable>;
  readonly importDeclarations: (
    input: Invocation<ImportSellerVatRegimeDeclarationsPayload>,
  ) => Effect.Effect<SellerVatRegimeImportOutcome | GovernanceConflict, PersistenceUnavailable>;
}

const decodeRegime = Schema.decodeUnknownEffect(SellerVatRegimeSchema);
const decodeProvenance = Schema.decodeUnknownEffect(SellerVatRegimeDeclarationProvenanceSchema);
const decodeEffectiveFromOrigin = Schema.decodeUnknownEffect(SellerVatRegimeEffectiveFromOriginSchema);
const decodeReplacedScheduled = Schema.decodeUnknownEffect(
  Schema.Array(ReplacedScheduledSellerVatRegimeDeclarationSchema),
);

/** The row's `regime`/`provenance` are DB-check-constrained to this vocabulary; decoded, never cast. A row outside
 * it is an unavailable read, never a guessed value. */
const toRevision = (row: DeclarationRow): Effect.Effect<SellerVatRegimeDeclarationRevision, PersistenceUnavailable> =>
  Effect.all(
    { provenance: decodeProvenance(row.provenance), regime: decodeRegime(row.regime) },
    { concurrency: 2 },
  ).pipe(
    Effect.map(({ provenance, regime }) => ({
      effectiveFrom: DateTime.makeUnsafe(row.effectiveFrom),
      provenance,
      regime,
      revision: row.revision,
    })),
    Effect.mapError(unavailable),
  );

const toRevisions = (rows: readonly DeclarationRow[]) => Effect.forEach(rows, toRevision, { concurrency: 1 });

/** How the row was obtained and where its effect comes from; the run and source refs exist only on MIGRATED rows
 * (DB check `_migration_ck`). Decoded, never cast (907-Q08). */
const originOf = (row: DeclarationRow) =>
  Effect.all(
    {
      effectiveFromOrigin: decodeEffectiveFromOrigin(row.effectiveFromOrigin),
      provenance: decodeProvenance(row.provenance),
    },
    { concurrency: 2 },
  ).pipe(
    Effect.map((origin) =>
      row.migrationRunRef === null || row.sourceRecordRef === null
        ? origin
        : { ...origin, migrationRunRef: row.migrationRunRef, sourceRecordRef: row.sourceRecordRef },
    ),
    Effect.mapError(unavailable),
  );

const intentFingerprint = (input: DeclareSellerVatRegimePayload): string =>
  taxMeaningFingerprint({
    confirmReplacesScheduled: input.confirmReplacesScheduled ?? false,
    effectiveFrom: DateTime.formatIso(input.effectiveFrom),
    expectedCurrentRevision: input.expectedCurrentRevision,
    reason: input.reason ?? null,
    regime: input.regime,
  });

const declarationRef = (row: DeclarationRow) =>
  sellerVatRegimeDeclarationRef(row.tenantId, row.taxSellerVatRegimeDeclarationId);

/** The replaced revisions' own refs, resolved once at insert time and replayed verbatim (#943/#955 F-replay). The
 * jsonb column is decoded through its Effect Schema, never trusted as the drizzle `$type<>` cast alone; a row
 * outside the vocabulary is an unavailable read, never a guessed value. */
const replacedScheduledRevisionsOf = (row: DeclarationRow) =>
  decodeReplacedScheduled(row.replacedScheduledDeclarations).pipe(
    Effect.map((replaced) =>
      replaced.map(({ revision, taxSellerVatRegimeDeclarationId }) => ({
        declarationRef: sellerVatRegimeDeclarationRef(row.tenantId, taxSellerVatRegimeDeclarationId),
        revision,
      })),
    ),
    Effect.mapError(unavailable),
  );

const declared = (
  row: DeclarationRow,
  created: boolean,
): Effect.Effect<SellerVatRegimeDeclarationOutcome, PersistenceUnavailable> =>
  replacedScheduledRevisionsOf(row).pipe(
    Effect.map((replacedScheduledRevisions) => ({
      audit: {
        changed: created,
        meaningFingerprint: row.intentFingerprint,
        resourceId: row.taxSellerVatRegimeDeclarationId,
        resourceType: DECLARATION_RESOURCE_TYPE,
      },
      result: {
        _tag: 'DECLARED' as const,
        created,
        declarationRef: declarationRef(row),
        replacedScheduledRevisions,
        revision: row.revision,
      },
    })),
  );

const setCompleteness = (rows: readonly DeclarationRow[]) => ({
  rowCount: rows.length,
  setFingerprint: taxMeaningFingerprint({
    rows: rows
      .toSorted((left, right) => left.revision - right.revision)
      .map((row) => `${row.revision}:${row.intentFingerprint}`),
  }),
});

const declarationRequestFields = (input: DeclareSellerVatRegimePayload) => {
  const base = {
    confirmReplacesScheduled: input.confirmReplacesScheduled ?? false,
    effectiveFrom: input.effectiveFrom,
    expectedCurrentRevision: input.expectedCurrentRevision,
    regime: input.regime,
  };
  return input.reason === undefined ? base : { ...base, reason: input.reason };
};

const insertDeclaration = Effect.fn('sellerVatRegimeDeclaration.insert')(function* insertDeclarationEffect(
  transaction: ScopedTransaction,
  input: Invocation<DeclareSellerVatRegimePayload>,
  fingerprint: string,
  replacesScheduled: readonly { readonly revision: number }[],
  revision: number,
  priorRows: readonly DeclarationRow[],
) {
  // Each replaced revision keeps its own row's identity, never the row this call is about to insert (#943/#955
  // F-replay): a replaced revision's declarationRef must resolve to the row that revision actually is. The
  // evaluation that produced `replacesScheduled` derived it from this same `priorRows` set, so a missing match
  // means the two have drifted; nothing is guessed in that case.
  const priorRowByRevision = new Map(priorRows.map((row) => [row.revision, row]));
  const resolvedPriorRows: DeclarationRow[] = [];
  for (const { revision: scheduledRevision } of replacesScheduled) {
    const priorRow = priorRowByRevision.get(scheduledRevision);
    if (priorRow === undefined) {
      return yield* unavailable();
    }
    resolvedPriorRows.push(priorRow);
  }
  const replacedScheduledDeclarations = resolvedPriorRows.map((priorRow) => ({
    revision: priorRow.revision,
    taxSellerVatRegimeDeclarationId: priorRow.taxSellerVatRegimeDeclarationId,
  }));
  const inserted = yield* mutation(
    transaction
      .insert(taxSellerVatRegimeDeclarations)
      .values({
        actionInvocationId: input.actionInvocationId,
        actorPrincipalId: input.actorPrincipalId,
        effectiveFrom: DateTime.toDateUtc(input.effectiveFrom),
        idempotencyKey: input.actionInvocationId,
        intentFingerprint: fingerprint,
        legalEntityId: input.legalEntityId,
        provenance: 'MERCHANT_DECLARED',
        reason: input.reason ?? null,
        recordedAt: input.operationTime,
        regime: input.regime,
        replacedScheduledDeclarations,
        replacesScheduled: replacesScheduled.length > 0,
        revision,
        tenantId: input.tenantId,
      })
      .returning(),
  );
  if ('kind' in inserted) {
    return inserted;
  }
  const [row] = inserted;
  if (row === undefined) {
    return yield* unavailable();
  }
  return yield* declared(row, true);
});

/** One imported row's content, the replay and completeness identity of that row (907-Q08). */
const importedRowFingerprint = (migrationRunRef: string, revision: ImportedSellerVatRegimeRevision): string =>
  taxMeaningFingerprint({
    effectiveFrom: DateTime.formatIso(revision.effectiveFrom),
    effectiveFromOrigin: revision.effectiveFromOrigin,
    migrationRunRef,
    reason: revision.reason ?? null,
    regime: revision.regime,
    sourceRecordRef: revision.sourceRecordRef,
  });

const importFingerprint = (input: ImportSellerVatRegimeDeclarationsPayload): string =>
  taxMeaningFingerprint({
    declarations: input.declarations.map((entry) => ({
      effectiveFrom: entry.effectiveFrom === undefined ? null : DateTime.formatIso(entry.effectiveFrom),
      reason: entry.reason ?? null,
      regime: entry.regime,
      sourceRecordRef: entry.sourceRecordRef,
    })),
    migrationRunRef: input.migrationRunRef,
    migrationStartedAt: DateTime.formatIso(input.migrationStartedAt),
  });

/** A stored row as the import compares it; only imported rows carry a run (DB check `_migration_ck`). */
const toStoredImportRevision = (row: DeclarationRow) =>
  Effect.all(
    { origin: originOf(row), regime: decodeRegime(row.regime).pipe(Effect.mapError(unavailable)) },
    { concurrency: 2 },
  ).pipe(
    Effect.map(({ origin, regime }): StoredSellerVatRegimeRevision => {
      const revision = {
        effectiveFrom: DateTime.makeUnsafe(row.effectiveFrom),
        effectiveFromOrigin: origin.effectiveFromOrigin,
        regime,
        revision: row.revision,
        sourceRecordRef: row.sourceRecordRef ?? '',
      };
      const withReason = row.reason === null ? revision : { ...revision, reason: row.reason };
      return row.migrationRunRef === null ? withReason : { ...withReason, migrationRunRef: row.migrationRunRef };
    }),
  );

/** One imported row as the result reports it; an imported row without its source record is unavailable. */
const importedRevision = Effect.fn('sellerVatRegimeDeclaration.importedRevision')(function* importedRevisionEffect(
  row: DeclarationRow,
) {
  const { effectiveFromOrigin } = yield* originOf(row);
  if (row.sourceRecordRef === null) {
    return yield* unavailable();
  }
  return {
    declarationRef: declarationRef(row),
    effectiveFrom: DateTime.makeUnsafe(row.effectiveFrom),
    effectiveFromOrigin,
    revision: row.revision,
    sourceRecordRef: row.sourceRecordRef,
  };
});

/** The seller's imported revisions in revision order (907-Q08). */
const imported = Effect.fn('sellerVatRegimeDeclaration.imported')(function* importedEffect(
  rows: readonly DeclarationRow[],
  created: boolean,
  fingerprint: string,
  legalEntityId: string,
) {
  const revisions = yield* Effect.forEach(
    rows.toSorted((left, right) => left.revision - right.revision),
    (row) => importedRevision(row),
    { concurrency: 1 },
  );
  const [first, ...rest] = revisions;
  if (first === undefined) {
    return yield* unavailable();
  }
  return {
    audit: {
      changed: created,
      meaningFingerprint: fingerprint,
      resourceId: legalEntityId,
      resourceType: DECLARATION_RESOURCE_TYPE,
    },
    result: { _tag: 'IMPORTED', created, revisions: [first, ...rest] },
  } satisfies SellerVatRegimeImportOutcome;
});

/** A typed import rejection; nothing is stored. The audit names the seller the rejection is about. */
const importRejected = (
  reason: 'AMBIGUOUS_SOURCE_HISTORY' | 'MIGRATION_RUN_CONFLICT' | 'SELLER_ALREADY_DECLARED',
  fingerprint: string,
  legalEntityId: string,
): SellerVatRegimeImportOutcome => ({
  audit: {
    changed: false,
    meaningFingerprint: fingerprint,
    resourceId: legalEntityId,
    resourceType: DECLARATION_RESOURCE_TYPE,
  },
  result: { _tag: 'IMPORT_REJECTED', reason },
});

const insertImport = Effect.fn('sellerVatRegimeDeclaration.insertImport')(function* insertImportEffect(
  transaction: ScopedTransaction,
  input: Invocation<ImportSellerVatRegimeDeclarationsPayload>,
  revisions: readonly ImportedSellerVatRegimeRevision[],
  fingerprint: string,
) {
  const inserted = yield* mutation(
    transaction
      .insert(taxSellerVatRegimeDeclarations)
      .values(
        revisions.map((revision) => ({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          effectiveFrom: DateTime.toDateUtc(revision.effectiveFrom),
          effectiveFromOrigin: revision.effectiveFromOrigin,
          // One invocation stores n rows; each needs its own tenant-unique key, never a bare invocation id that a
          // declare could replay against.
          idempotencyKey: `${input.actionInvocationId}:${revision.revision}`,
          intentFingerprint: importedRowFingerprint(input.migrationRunRef, revision),
          legalEntityId: input.legalEntityId,
          migrationRunRef: input.migrationRunRef,
          provenance: 'MIGRATED',
          reason: revision.reason ?? null,
          recordedAt: input.operationTime,
          regime: revision.regime,
          replacesScheduled: false,
          revision: revision.revision,
          sourceRecordRef: revision.sourceRecordRef,
          tenantId: input.tenantId,
        })),
      )
      .returning(),
  );
  if ('kind' in inserted) {
    return inserted;
  }
  return yield* imported(inserted, true, fingerprint, input.legalEntityId);
});

export const sellerVatRegimeDeclarationsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): SellerVatRegimeDeclarations => {
  const { tenantId } = scope;
  const legalEntityId = scope.legalEntityId ?? '';

  const byInvocation = (input: GovernedInvocation) =>
    query(
      transaction
        .select()
        .from(taxSellerVatRegimeDeclarations)
        .where(
          and(
            eq(taxSellerVatRegimeDeclarations.tenantId, input.tenantId),
            eq(taxSellerVatRegimeDeclarations.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );

  const allRevisions = () =>
    legalEntityId === ''
      ? Effect.succeed([])
      : query(
          transaction
            .select()
            .from(taxSellerVatRegimeDeclarations)
            .where(
              and(
                eq(taxSellerVatRegimeDeclarations.tenantId, tenantId),
                eq(taxSellerVatRegimeDeclarations.legalEntityId, legalEntityId),
              ),
            ),
        );

  // The audit resourceId names the seller the rejection is about, never the action invocation (the established
  // rejection-audit pattern: compare `order-tax-finalization.service.ts`'s `unstored`, which audits its stable
  // domain reference, not the invocation id). No declaration row exists on rejection, so the Selling Legal Entity
  // scope reference is the resource this audit is about.
  const rejected = (reason: 'REASON_REQUIRED_FOR_BACKDATED_EFFECT', fingerprint: string, sellerLegalEntityId: string) =>
    Effect.succeed<SellerVatRegimeDeclarationOutcome>({
      audit: {
        changed: false,
        meaningFingerprint: fingerprint,
        resourceId: sellerLegalEntityId,
        resourceType: DECLARATION_RESOURCE_TYPE,
      },
      result: { _tag: 'DECLARATION_REJECTED', reason, scheduledRevisions: [] },
    });

  const scheduledConfirmationRequired = Effect.fn('sellerVatRegimeDeclaration.scheduledConfirmationRequired')(
    function* scheduledConfirmationRequiredEffect(
      scheduled: readonly { readonly revision: number }[],
      fingerprint: string,
      input: GovernedInvocation,
      rows: readonly DeclarationRow[],
    ) {
      // Each scheduled revision keeps its own row's ref (#943/#955 F-replay); the evaluation that produced
      // `scheduled` derived it from this same `rows` set, so a missing match means the two have drifted and this
      // must fail closed, never silently drop the revision from the audited result.
      const rowByRevision = new Map(rows.map((row) => [row.revision, row]));
      const scheduledRevisions: { declarationRef: ReturnType<typeof declarationRef>; revision: number }[] = [];
      for (const { revision } of scheduled) {
        const scheduledRow = rowByRevision.get(revision);
        if (scheduledRow === undefined) {
          return yield* unavailable();
        }
        scheduledRevisions.push({ declarationRef: declarationRef(scheduledRow), revision });
      }
      return {
        audit: {
          changed: false,
          meaningFingerprint: fingerprint,
          resourceId: input.legalEntityId,
          resourceType: DECLARATION_RESOURCE_TYPE,
        },
        result: {
          _tag: 'DECLARATION_REJECTED',
          reason: 'SCHEDULED_REVISION_CONFIRMATION_REQUIRED',
          scheduledRevisions,
        },
      } satisfies SellerVatRegimeDeclarationOutcome;
    },
  );

  const declare: SellerVatRegimeDeclarations['declare'] = Effect.fn('sellerVatRegimeDeclaration.declare')(
    function* declareEffect(input) {
      if (!trustedInvocation(scope, input, [])) {
        return yield* unavailable();
      }
      const fingerprint = intentFingerprint(input);
      const [byInvocationRow] = yield* byInvocation(input);
      if (byInvocationRow !== undefined) {
        // A Core-invocation replay must carry the identical attribution and intent (#955 G); the Action has no
        // provenanceRef, so the match is over the attribution columns the row actually carries.
        const matches =
          byInvocationRow.actorPrincipalId === input.actorPrincipalId &&
          byInvocationRow.legalEntityId === input.legalEntityId &&
          byInvocationRow.idempotencyKey === input.actionInvocationId &&
          byInvocationRow.intentFingerprint === fingerprint;
        return matches ? yield* declared(byInvocationRow, false) : conflict('IDEMPOTENCY_REUSED');
      }
      // Serializes every declare for this seller so the CAS basis and the timeline rule can't race (F6).
      yield* lockTaxScopeKey(transaction, input, 'SELLER_VAT_REGIME_DECLARATION', 'exclusive');
      const rows = yield* allRevisions();
      const revisions = yield* toRevisions(rows);
      const evaluation = evaluateSellerVatRegimeDeclaration({
        operationTime: DateTime.makeUnsafe(input.operationTime),
        request: declarationRequestFields(input),
        revisions,
      });
      return yield* Match.value(evaluation).pipe(
        Match.tag('STALE_BASIS', () => Effect.succeed(staleBasis)),
        Match.tag('REASON_REQUIRED_FOR_BACKDATED_EFFECT', () =>
          rejected('REASON_REQUIRED_FOR_BACKDATED_EFFECT', fingerprint, input.legalEntityId),
        ),
        Match.tag('SCHEDULED_REVISION_CONFIRMATION_REQUIRED', ({ scheduled }) =>
          scheduledConfirmationRequired(scheduled, fingerprint, input, rows),
        ),
        Match.tag('ACCEPTED', ({ replacesScheduled, revision }) =>
          insertDeclaration(transaction, input, fingerprint, replacesScheduled, revision, rows),
        ),
        Match.exhaustive,
      );
    },
  );

  const history: SellerVatRegimeDeclarations['history'] = Effect.gen(function* historyEffect() {
    if (scope.legalEntityId === undefined) {
      return Option.none();
    }
    const rows = yield* allRevisions();
    const ordered = rows.toSorted((left, right) => left.revision - right.revision);
    const revisionRows = yield* Effect.forEach(
      ordered,
      (row) =>
        Effect.all({ origin: originOf(row), regime: decodeRegime(row.regime) }, { concurrency: 2 }).pipe(
          Effect.map(({ origin, regime }) => ({
            declarationRef: declarationRef(row),
            declaredBy: row.actorPrincipalId,
            effectiveFrom: DateTime.makeUnsafe(row.effectiveFrom),
            ...origin,
            reason: Option.fromNullOr(row.reason),
            recordedAt: DateTime.makeUnsafe(row.recordedAt),
            regime,
            replacesScheduled: row.replacesScheduled,
            revision: row.revision,
          })),
        ),
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    return Option.some({ completeness: setCompleteness(rows), revisions: revisionRows });
  });

  const atInstant: SellerVatRegimeDeclarations['atInstant'] = Effect.fn('sellerVatRegimeDeclaration.atInstant')(
    function* atInstantEffect(request) {
      if (scope.legalEntityId === undefined) {
        return Option.none();
      }
      const rows = yield* allRevisions();
      const revisions = yield* toRevisions(rows);
      const selection = sellerVatRegimeAt(revisions, request.instant);
      const atInstantSelection = yield* Match.value(selection).pipe(
        Match.tag('DECLARED', (declaredSelection) => {
          const selectionRow = rows.find((row) => row.revision === declaredSelection.declarationRevisionRef.revision);
          // The evaluation that selected this revision derived it from this same `rows` set, so a missing match
          // means the two have drifted; this must fail closed (never silently report NOT_DECLARED for a seller
          // that does, in truth, have a declared regime).
          return selectionRow === undefined
            ? Effect.fail(unavailable())
            : originOf(selectionRow).pipe(
                Effect.map((origin) => ({
                  _tag: 'DECLARED' as const,
                  declarationRevisionRef: declaredSelection.declarationRevisionRef,
                  effectiveFrom: DateTime.makeUnsafe(selectionRow.effectiveFrom),
                  ...origin,
                  regime: declaredSelection.regime,
                })),
              );
        }),
        Match.tag('NOT_DECLARED', () => Effect.succeed({ _tag: 'NOT_DECLARED' as const })),
        Match.exhaustive,
      );
      return Option.some({
        completeness: setCompleteness(rows),
        headRevision: sellerVatRegimeHead(revisions),
        instant: request.instant,
        selection: atInstantSelection,
      });
    },
  );

  /** Stores, replays or rejects one planned import under the same exclusive seller lock as declare (907-Q08). */
  const importPlanned = Effect.fn('sellerVatRegimeDeclaration.importPlanned')(function* importPlannedEffect(
    input: Invocation<ImportSellerVatRegimeDeclarationsPayload>,
    planned: readonly ImportedSellerVatRegimeRevision[],
    fingerprint: string,
  ) {
    yield* lockTaxScopeKey(transaction, input, 'SELLER_VAT_REGIME_DECLARATION', 'exclusive');
    const rows = yield* allRevisions();
    const stored = yield* Effect.forEach(rows, toStoredImportRevision, { concurrency: 1 });
    const disposition = sellerVatRegimeImportDisposition({ migrationRunRef: input.migrationRunRef, planned, stored });
    return yield* Match.value(disposition).pipe(
      Match.tag('INSERT', () => insertImport(transaction, input, planned, fingerprint)),
      Match.tag('REPLAY', () => imported(rows, false, fingerprint, input.legalEntityId)),
      Match.tag('MIGRATION_RUN_CONFLICT', () =>
        Effect.succeed(importRejected('MIGRATION_RUN_CONFLICT', fingerprint, input.legalEntityId)),
      ),
      Match.tag('SELLER_ALREADY_DECLARED', () =>
        Effect.succeed(importRejected('SELLER_ALREADY_DECLARED', fingerprint, input.legalEntityId)),
      ),
      Match.exhaustive,
    );
  });

  /**
   * Imports the seller's existing source declarations as MIGRATED revisions, under the same seller lock as declare
   * and finalization (907-Q08). No merchant confirmation and no verification: only the mapping, the format and the
   * replay are checked. Stored rows are compared, never re-derived, so a replay keeps the same start.
   */
  const importDeclarations: SellerVatRegimeDeclarations['importDeclarations'] = Effect.fn(
    'sellerVatRegimeDeclaration.importDeclarations',
  )(function* importDeclarationsEffect(input) {
    if (!trustedInvocation(scope, input, [])) {
      return yield* unavailable();
    }
    const fingerprint = importFingerprint(input);
    return yield* Match.value(planSellerVatRegimeImport(input)).pipe(
      Match.tag('AMBIGUOUS_SOURCE_HISTORY', () =>
        Effect.succeed(importRejected('AMBIGUOUS_SOURCE_HISTORY', fingerprint, input.legalEntityId)),
      ),
      Match.tag('PLANNED', ({ revisions }) => importPlanned(input, revisions, fingerprint)),
      Match.exhaustive,
    );
  });

  return Object.freeze({ atInstant, declare, history, importDeclarations });
};

export const sellerVatRegimeDeclarationServiceFactory = (transaction: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(sellerVatRegimeDeclarationsForScope(transaction, scope));
