import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import type {
  CatalogFactScope,
  CatalogLocalOverride,
  CatalogSourceAssertion,
} from '../domain/catalog-source-resolution.ts';
import {
  catalogAcceptedSourceAssertions,
  catalogLocalOverrideHeads,
  catalogLocalOverrideRevisions,
} from '../database/schema.ts';
import { CatalogSourceResolutionUnavailable } from './catalog-source-resolution-ports.ts';

const unavailable = (cause?: unknown) => {
  const error = new CatalogSourceResolutionUnavailable({
    code: 'catalog_source_resolution_unavailable',
    reason: 'Catalog source resolution persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};
const CatalogPersistedTextValueSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);
const CatalogPersistedDecimalSchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
  Schema.isMaxLength(100),
);
const CatalogPersistedSourceFactValueSchema = Schema.Union([
  CatalogPersistedTextValueSchema,
  Schema.Struct({
    amount: CatalogPersistedDecimalSchema,
    unitId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CatalogSourceUnitId')),
  }),
]);
const CatalogFactTargetKindSchema = Schema.Literals(['PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION']);
const CatalogLocalOverrideLifecycleSchema = Schema.Literals(['ACTIVE', 'RELEASED']);
const decodeSourceFactValue = Schema.decodeUnknownEffect(CatalogPersistedSourceFactValueSchema);
const decodeTargetKind = Schema.decodeUnknownEffect(CatalogFactTargetKindSchema);
const decodeOverrideLifecycle = Schema.decodeUnknownEffect(CatalogLocalOverrideLifecycleSchema);
const scopeWhere = (scope: CatalogFactScope) =>
  and(
    eq(catalogLocalOverrideHeads.tenantId, scope.tenantId),
    eq(catalogLocalOverrideHeads.targetKind, scope.targetKind),
    eq(catalogLocalOverrideHeads.targetId, scope.targetId),
    eq(catalogLocalOverrideHeads.factKey, scope.factKey),
  );
const acceptedScopeWhere = (scope: CatalogFactScope) =>
  and(
    eq(catalogAcceptedSourceAssertions.tenantId, scope.tenantId),
    eq(catalogAcceptedSourceAssertions.targetKind, scope.targetKind),
    eq(catalogAcceptedSourceAssertions.targetId, scope.targetId),
    eq(catalogAcceptedSourceAssertions.factKey, scope.factKey),
  );

/** Read-only source evidence projection. Override history is joined through its latest CAS head. */
export const catalogSourceResolutionReadStoreForScope = (
  transaction: ScopedTransactionExecutor,
  operationalScope: OperationalScope,
) => ({
  readAcceptedBases: Effect.fn('CatalogSourceResolutionReadStore.readAcceptedBases')(function* readAcceptedBases(
    scope: CatalogFactScope,
  ) {
    if (scope.tenantId !== operationalScope.tenantId) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select()
      .from(catalogAcceptedSourceAssertions)
      .where(acceptedScopeWhere(scope))
      .pipe(Effect.mapError(unavailable));
    return yield* Effect.forEach(
      rows,
      Effect.fn('CatalogSourceResolutionReadStore.decodeAcceptedBase')(function* decodeAcceptedBase(row) {
        const [targetKind, value] = yield* Effect.all(
          [decodeTargetKind(row.targetKind), decodeSourceFactValue(row.value)],
          { concurrency: 2 },
        );
        const assertion: CatalogSourceAssertion<Schema.Json> = {
          assertionId: row.assertionId,
          effectiveFrom: row.effectiveFrom,
          evidencedAt: row.evidencedAt,
          issuerSystemId: row.issuerSystemId,
          scope: {
            factKey: row.factKey,
            targetId: row.targetId,
            targetKind,
            tenantId: row.tenantId,
          },
          sourceRecordId: row.sourceRecordId,
          sourceRevision: row.sourceRevision,
          value,
          valueFingerprint: row.valueFingerprint,
        };
        return row.effectiveTo === null ? assertion : { ...assertion, effectiveTo: row.effectiveTo };
      }),
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
  }),
  readOverrides: Effect.fn('CatalogSourceResolutionReadStore.readOverrides')(function* readOverrides(
    scope: CatalogFactScope,
  ) {
    if (scope.tenantId !== operationalScope.tenantId) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select({ revision: catalogLocalOverrideRevisions })
      .from(catalogLocalOverrideHeads)
      .innerJoin(
        catalogLocalOverrideRevisions,
        and(
          eq(catalogLocalOverrideRevisions.tenantId, catalogLocalOverrideHeads.tenantId),
          eq(catalogLocalOverrideRevisions.targetKind, catalogLocalOverrideHeads.targetKind),
          eq(catalogLocalOverrideRevisions.targetId, catalogLocalOverrideHeads.targetId),
          eq(catalogLocalOverrideRevisions.factKey, catalogLocalOverrideHeads.factKey),
          eq(catalogLocalOverrideRevisions.revision, catalogLocalOverrideHeads.latestRevision),
        ),
      )
      .where(scopeWhere(scope))
      .pipe(Effect.mapError(unavailable));
    if (rows.length > 1) {
      return yield* unavailable();
    }
    return yield* Effect.forEach(
      rows,
      Effect.fn('CatalogSourceResolutionReadStore.decodeOverride')(function* decodeOverride({ revision: row }) {
        const [lifecycle, targetKind, value] = yield* Effect.all(
          [decodeOverrideLifecycle(row.lifecycle), decodeTargetKind(row.targetKind), decodeSourceFactValue(row.value)],
          { concurrency: 3 },
        );
        return {
          actorPrincipalId: row.actorPrincipalId,
          evidenceRef: row.evidenceRef,
          lifecycle,
          reason: row.reason,
          revision: row.revision,
          scope: {
            factKey: row.factKey,
            targetId: row.targetId,
            targetKind,
            tenantId: row.tenantId,
          },
          value,
        } satisfies CatalogLocalOverride<Schema.Json>;
      }),
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
  }),
});
