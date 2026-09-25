import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  InventorySourceAssertionRejected,
  InventorySourceAssertionSchema,
  InventorySourceAssertionUnavailable,
  SourceCoverageEvidenceSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import type {
  InventorySourceAssertion,
  InventorySourceAssertionId,
  InventorySourceAssertionPersistence,
} from '../../shared/domain/inventory-source-assertion.ts';
import { inventorySourceAssertionCoverage, inventorySourceAssertions } from './inventory-source-assertion-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (assertionId?: InventorySourceAssertionId, cause?: unknown) => {
  const failure =
    assertionId === undefined
      ? new InventorySourceAssertionUnavailable({
          code: 'inventory_source_assertion_unavailable',
          reason: 'Inventory Source Assertion dependency is temporarily unavailable',
          retryable: true,
        })
      : new InventorySourceAssertionUnavailable({
          assertionId,
          code: 'inventory_source_assertion_unavailable',
          reason: 'Inventory Source Assertion dependency is temporarily unavailable',
          retryable: true,
        });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const rejected = (
  assertionId: InventorySourceAssertionId,
  reason: InventorySourceAssertionRejected['reason'],
  cause?: unknown,
) => {
  const failure = new InventorySourceAssertionRejected({
    assertionId,
    code: 'inventory_source_assertion_rejected',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const mapWriteError = (assertionId: InventorySourceAssertionId, cause: unknown) => {
  const uniqueViolationSqlState = ['23', '505'].join('');
  const identityConflict = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      [
        'source_assertions_pkey',
        'inventory_source_assertions_tenant_id_uk',
        'inventory_source_assertion_coverage_pk',
      ].includes(constraint ?? ''),
  );
  return Option.isSome(identityConflict)
    ? rejected(assertionId, 'ASSERTION_ID_CONFLICT', cause)
    : unavailable(assertionId, cause);
};

const orderingValue = (assertion: InventorySourceAssertion) =>
  Match.value(assertion.orderingEvidence).pipe(
    Match.tag('SOURCE_REVISION', ({ revision }) => revision),
    Match.tag('OWNER_ORDER_KEY', ({ key }) => key),
    Match.exhaustive,
  );

const assertionValues = (assertion: InventorySourceAssertion) => ({
  assertionId: assertion.assertionId,
  assertionJson: assertion,
  authorityConfigurationId: assertion.authorityConfiguration.configurationId,
  businessObservedAt: DateTime.toDateUtc(DateTime.makeUnsafe(assertion.businessObservedAt)),
  customerConfigurationId: assertion.customerConfigurationId,
  factMeaning: assertion.factMeaning,
  issuerAuthority: assertion.issuerAuthority,
  issuerBackendId: assertion.issuer.backendId,
  issuerBackendKind: assertion.issuer.backendKind,
  itemCorrelationId: assertion.itemCorrelationRef.resourceId,
  locationCorrelationId: assertion.locationCorrelationRef.resourceId,
  orderingEvidenceKind: assertion.orderingEvidence._tag,
  orderingEvidenceValue: orderingValue(assertion),
  ownerEvidenceRef: assertion.ownerEvidenceRef,
  positionId: assertion.positionRef.resourceId,
  quantityAmount: assertion.quantity.amount,
  receivedAt: DateTime.toDateUtc(DateTime.makeUnsafe(assertion.receivedAt)),
  sourceReference: assertion.sourceReference,
  stockItemId: assertion.stockItemRef.resourceId,
  stockLocationId: assertion.stockLocationRef.resourceId,
  tenantId: assertion.positionRef.tenantId,
  unitModuleId: assertion.quantity.unitRef.moduleId,
  unitResourceId: assertion.quantity.unitRef.resourceId,
  unitResourceType: assertion.quantity.unitRef.resourceType,
  unitTenantId: assertion.quantity.unitRef.tenantId,
});

const coverageMatches = (
  expected: InventorySourceAssertion['coverage'],
  actual: readonly (typeof inventorySourceAssertionCoverage.$inferSelect)[],
) =>
  expected.length === actual.length &&
  expected.every((evidence) =>
    actual.some(
      (row) =>
        row.assertionId === evidence.assertionId &&
        row.effectId === evidence.effectId &&
        row.ownerEvidenceRef === evidence.ownerEvidenceRef &&
        row.relation === evidence.relation,
    ),
  );

export const inventorySourceAssertionPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'tenantId'>,
): InventorySourceAssertionPersistence => {
  const findById: InventorySourceAssertionPersistence['findById'] = Effect.fn(
    'InventorySourceAssertionPersistence.findById',
  )(function* findSourceAssertionById(assertionId) {
    return yield* Effect.gen(function* readSourceAssertion() {
      const [row] = yield* transaction
        .select()
        .from(inventorySourceAssertions)
        .where(
          and(
            eq(inventorySourceAssertions.tenantId, scope.tenantId),
            eq(inventorySourceAssertions.assertionId, assertionId),
          ),
        )
        .limit(1);
      if (row === undefined) {
        return Option.none();
      }
      const coverage = yield* transaction
        .select()
        .from(inventorySourceAssertionCoverage)
        .where(
          and(
            eq(inventorySourceAssertionCoverage.tenantId, scope.tenantId),
            eq(inventorySourceAssertionCoverage.assertionId, assertionId),
          ),
        );
      if (!coverageMatches(row.assertionJson.coverage, coverage)) {
        return yield* unavailable(assertionId);
      }
      const decodedCoverage = yield* Schema.decodeUnknownEffect(Schema.Array(SourceCoverageEvidenceSchema))(
        coverage.map((entry) => ({
          assertionId: entry.assertionId,
          effectId: entry.effectId,
          ownerEvidenceRef: entry.ownerEvidenceRef,
          relation: entry.relation,
        })),
      );
      const decoded = yield* Schema.decodeEffect(InventorySourceAssertionSchema)({
        ...row.assertionJson,
        coverage: decodedCoverage,
      });
      return Option.some(decoded);
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(InventorySourceAssertionUnavailable)(cause) ? cause : unavailable(assertionId, cause),
      ),
    );
  });

  const append: InventorySourceAssertionPersistence['append'] = Effect.fn('InventorySourceAssertionPersistence.append')(
    function* appendSourceAssertion(assertion) {
      if (assertion.positionRef.tenantId !== scope.tenantId || !Schema.is(InventorySourceAssertionSchema)(assertion)) {
        return yield* rejected(assertion.assertionId, 'INVALID_ASSERTION');
      }
      const [inserted] = yield* transaction
        .insert(inventorySourceAssertions)
        .values(assertionValues(assertion))
        .returning()
        .pipe(Effect.mapError((cause) => mapWriteError(assertion.assertionId, cause)));
      if (inserted === undefined) {
        return yield* unavailable(assertion.assertionId);
      }
      if (assertion.coverage.length > 0) {
        yield* transaction
          .insert(inventorySourceAssertionCoverage)
          .values(
            assertion.coverage.map((coverage) => ({
              assertionId: coverage.assertionId,
              effectId: coverage.effectId,
              ownerEvidenceRef: coverage.ownerEvidenceRef,
              relation: coverage.relation,
              tenantId: scope.tenantId,
            })),
          )
          .pipe(Effect.mapError((cause) => mapWriteError(assertion.assertionId, cause)));
      }
      return yield* Schema.decodeEffect(InventorySourceAssertionSchema)(inserted.assertionJson).pipe(
        Effect.mapError((cause) => unavailable(assertion.assertionId, cause)),
      );
    },
  );

  return Object.freeze({ append, findById });
};
