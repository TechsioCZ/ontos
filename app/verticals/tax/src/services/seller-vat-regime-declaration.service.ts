import type { OperationalScope } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import type {
  DeclareSellerVatRegimePayload,
  DeclareSellerVatRegimeResult,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import {
  SellerVatRegimeDeclarationProvenanceSchema,
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

export interface SellerVatRegimeDeclarations {
  readonly atInstant: (
    request: SellerVatRegimeAtInstantRequestContract,
  ) => Effect.Effect<Option.Option<SellerVatRegimeAtInstantResponseContract>, PersistenceUnavailable>;
  readonly declare: (
    input: Invocation<DeclareSellerVatRegimePayload>,
  ) => Effect.Effect<SellerVatRegimeDeclarationOutcome | GovernanceConflict | GovernanceStale, PersistenceUnavailable>;
  readonly history: Effect.Effect<Option.Option<SellerVatRegimeHistoryResponseContract>, PersistenceUnavailable>;
}

const decodeRegime = Schema.decodeUnknownEffect(SellerVatRegimeSchema);
const decodeProvenance = Schema.decodeUnknownEffect(SellerVatRegimeDeclarationProvenanceSchema);

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

const declared = (row: DeclarationRow, created: boolean): SellerVatRegimeDeclarationOutcome => ({
  audit: {
    changed: created,
    meaningFingerprint: row.intentFingerprint,
    resourceId: row.taxSellerVatRegimeDeclarationId,
    resourceType: DECLARATION_RESOURCE_TYPE,
  },
  result: {
    _tag: 'DECLARED',
    created,
    declarationRef: declarationRef(row),
    replacedScheduledRevisions: [],
    revision: row.revision,
  },
});

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
) {
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
  return {
    audit: {
      changed: true,
      meaningFingerprint: row.intentFingerprint,
      resourceId: row.taxSellerVatRegimeDeclarationId,
      resourceType: DECLARATION_RESOURCE_TYPE,
    },
    result: {
      _tag: 'DECLARED',
      created: true,
      declarationRef: declarationRef(row),
      replacedScheduledRevisions: replacesScheduled.map(({ revision: scheduledRevision }) => ({
        declarationRef: declarationRef(row),
        revision: scheduledRevision,
      })),
      revision: row.revision,
    },
  } satisfies SellerVatRegimeDeclarationOutcome;
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

  const rejected = (reason: 'REASON_REQUIRED_FOR_BACKDATED_EFFECT', fingerprint: string, actionInvocationId: string) =>
    Effect.succeed<SellerVatRegimeDeclarationOutcome>({
      audit: {
        changed: false,
        meaningFingerprint: fingerprint,
        resourceId: actionInvocationId,
        resourceType: DECLARATION_RESOURCE_TYPE,
      },
      result: { _tag: 'DECLARATION_REJECTED', reason, scheduledRevisions: [] },
    });

  const scheduledConfirmationRequired = (
    scheduled: readonly { readonly revision: number }[],
    fingerprint: string,
    input: GovernedInvocation,
  ) =>
    Effect.succeed<SellerVatRegimeDeclarationOutcome>({
      audit: {
        changed: false,
        meaningFingerprint: fingerprint,
        resourceId: input.actionInvocationId,
        resourceType: DECLARATION_RESOURCE_TYPE,
      },
      result: {
        _tag: 'DECLARATION_REJECTED',
        reason: 'SCHEDULED_REVISION_CONFIRMATION_REQUIRED',
        scheduledRevisions: scheduled.map(({ revision }) => ({
          declarationRef: sellerVatRegimeDeclarationRef(input.tenantId, input.actionInvocationId),
          revision,
        })),
      },
    });

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
        return matches ? declared(byInvocationRow, false) : conflict('IDEMPOTENCY_REUSED');
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
          rejected('REASON_REQUIRED_FOR_BACKDATED_EFFECT', fingerprint, input.actionInvocationId),
        ),
        Match.tag('SCHEDULED_REVISION_CONFIRMATION_REQUIRED', ({ scheduled }) =>
          scheduledConfirmationRequired(scheduled, fingerprint, input),
        ),
        Match.tag('ACCEPTED', ({ replacesScheduled, revision }) =>
          insertDeclaration(transaction, input, fingerprint, replacesScheduled, revision),
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
        Effect.all(
          { provenance: decodeProvenance(row.provenance), regime: decodeRegime(row.regime) },
          { concurrency: 2 },
        ).pipe(
          Effect.map(({ provenance, regime }) => ({
            declarationRef: declarationRef(row),
            declaredBy: row.actorPrincipalId,
            effectiveFrom: DateTime.makeUnsafe(row.effectiveFrom),
            provenance,
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
          return selectionRow === undefined
            ? Effect.succeed({ _tag: 'NOT_DECLARED' as const })
            : decodeProvenance(selectionRow.provenance).pipe(
                Effect.map((provenance) => ({
                  _tag: 'DECLARED' as const,
                  declarationRevisionRef: declaredSelection.declarationRevisionRef,
                  effectiveFrom: DateTime.makeUnsafe(selectionRow.effectiveFrom),
                  provenance,
                  regime: declaredSelection.regime,
                })),
                Effect.mapError(unavailable),
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

  return Object.freeze({ atInstant, declare, history });
};

export const sellerVatRegimeDeclarationServiceFactory = (transaction: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(sellerVatRegimeDeclarationsForScope(transaction, scope));
