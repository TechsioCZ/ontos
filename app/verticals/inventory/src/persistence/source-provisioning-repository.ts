import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  SourceProvisioningPolicySchema,
  SourceStockItemProvisioningReceiptSchema,
} from '../../shared/domain/source-provisioning.ts';
import { SourceProvisioningUnavailable } from '../../shared/domain/source-provisioning-unavailable.ts';
import type {
  SourceProvisioningPolicy,
  SourceStockItemProvisioningInvocationId,
  SourceStockItemProvisioningReceipt,
} from '../../shared/domain/source-provisioning.ts';
import type { InventoryBackendOrigin } from '../../shared/domain/external-stock-correlation.ts';
import type { SourceProvisioningPolicyRef } from '../../shared/resources/source-provisioning-policy.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import {
  inventorySourceProvisioningPolicies,
  inventorySourceProvisioningPolicyLocations,
  inventorySourceStockItemProvisionings,
} from './source-provisioning-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type PolicyRow = typeof inventorySourceProvisioningPolicies.$inferSelect;
type Failure = SourceProvisioningUnavailable;

/** The exact (customer configuration, issuer, namespace, external scope) a policy qualifies ERP keys by. */
export interface SourceProvisioningQualification {
  readonly customerConfigurationId: string;
  readonly externalScope: string;
  readonly issuer: InventoryBackendOrigin;
  readonly namespace: string;
}

export interface SourceProvisioningPolicyPersistence {
  readonly findByOwnerConfiguration: (
    ownerConfigurationId: string,
  ) => Effect.Effect<Option.Option<SourceProvisioningPolicy>, Failure>;
  readonly findByQualification: (
    qualification: SourceProvisioningQualification,
  ) => Effect.Effect<Option.Option<SourceProvisioningPolicy>, Failure>;
  readonly findByRef: (
    ref: SourceProvisioningPolicyRef,
  ) => Effect.Effect<Option.Option<SourceProvisioningPolicy>, Failure>;
  /** Inserts the policy unless its backend configuration already has one, which it then returns. */
  readonly insert: (
    policy: SourceProvisioningPolicy,
  ) => Effect.Effect<{ readonly outcome: 'EXISTING' | 'INSERTED'; readonly policy: SourceProvisioningPolicy }, Failure>;
  /** The selected owner is the existing serialization point even before its policy exists. */
  readonly lockOwnerConfiguration: (ownerConfigurationId: string) => Effect.Effect<void, Failure>;
}

export interface SourceStockItemProvisioningReceiptPersistence {
  readonly append: (
    receipt: SourceStockItemProvisioningReceipt,
  ) => Effect.Effect<SourceStockItemProvisioningReceipt, Failure>;
  readonly findByInvocation: (
    actionInvocationId: SourceStockItemProvisioningInvocationId,
  ) => Effect.Effect<Option.Option<SourceStockItemProvisioningReceipt>, Failure>;
}

export const sourceProvisioningUnavailable = (cause?: unknown): SourceProvisioningUnavailable => {
  const failure = new SourceProvisioningUnavailable({
    code: 'source_provisioning_unavailable',
    reason: 'Inventory source provisioning is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const INVENTORY_MODULE_ID = 'commerce.inventory';

const decodeReceiptRow = (row: typeof inventorySourceStockItemProvisionings.$inferSelect) =>
  Schema.decodeUnknownEffect(SourceStockItemProvisioningReceiptSchema)({
    actionInvocationId: row.actionInvocationId,
    input: row.inputJson,
    provisioning: row.provisioningJson,
    recordedAt: row.recordedAt.toISOString(),
  }).pipe(Effect.mapError(sourceProvisioningUnavailable));

export const sourceProvisioningPolicyPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): SourceProvisioningPolicyPersistence => {
  const decode = Effect.fn('SourceProvisioningPolicyPersistence.decode')(function* decodePolicy(row: PolicyRow) {
    const locations = yield* transaction
      .select()
      .from(inventorySourceProvisioningPolicyLocations)
      .where(
        and(
          eq(inventorySourceProvisioningPolicyLocations.tenantId, scope.tenantId),
          eq(inventorySourceProvisioningPolicyLocations.policyId, row.policyId),
        ),
      )
      .pipe(Effect.mapError(sourceProvisioningUnavailable));
    return yield* Schema.decodeUnknownEffect(SourceProvisioningPolicySchema)({
      customerConfigurationId: row.customerConfigurationId,
      definedAt: row.definedAt.toISOString(),
      effectiveFrom: row.effectiveFrom.toISOString(),
      externalScope: row.externalScope,
      issuer: { backendId: row.issuerBackendId, backendKind: row.issuerBackendKind },
      locations: locations
        .map((location) => ({
          locationKey: location.locationKey,
          stockLocationRef: {
            moduleId: INVENTORY_MODULE_ID,
            resourceId: location.stockLocationId,
            resourceType: 'commerce.inventory.stock-location',
            tenantId: row.tenantId,
          },
        }))
        .toSorted((left, right) => left.locationKey.localeCompare(right.locationKey)),
      namespace: row.namespace,
      ownerConfigurationRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.ownerConfigurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId: row.tenantId,
      },
      policyRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.policyId,
        resourceType: 'commerce.inventory.source-provisioning-policy',
        tenantId: row.tenantId,
      },
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: row.unitResourceId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId: row.tenantId,
      },
    }).pipe(Effect.mapError(sourceProvisioningUnavailable));
  });

  const findOne = (predicate: ReturnType<typeof and>) =>
    transaction
      .select()
      .from(inventorySourceProvisioningPolicies)
      .where(and(eq(inventorySourceProvisioningPolicies.tenantId, scope.tenantId), predicate))
      .limit(1)
      .pipe(
        Effect.mapError(sourceProvisioningUnavailable),
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decode(row).pipe(Effect.asSome))),
      );

  const lockOwnerConfiguration: SourceProvisioningPolicyPersistence['lockOwnerConfiguration'] = (ownerId) =>
    transaction
      .select({ id: inventoryBackendConfigurations.configurationId })
      .from(inventoryBackendConfigurations)
      .where(
        and(
          eq(inventoryBackendConfigurations.tenantId, scope.tenantId),
          eq(inventoryBackendConfigurations.configurationId, ownerId),
        ),
      )
      .for('update')
      .pipe(Effect.asVoid, Effect.mapError(sourceProvisioningUnavailable));

  const findByRef: SourceProvisioningPolicyPersistence['findByRef'] = (ref) =>
    ref.tenantId === scope.tenantId
      ? findOne(and(eq(inventorySourceProvisioningPolicies.policyId, ref.resourceId)))
      : Effect.succeedNone;

  const findByOwnerConfiguration: SourceProvisioningPolicyPersistence['findByOwnerConfiguration'] = (
    ownerConfigurationId,
  ) => findOne(and(eq(inventorySourceProvisioningPolicies.ownerConfigurationId, ownerConfigurationId)));

  const findByQualification: SourceProvisioningPolicyPersistence['findByQualification'] = (qualification) =>
    findOne(
      and(
        eq(inventorySourceProvisioningPolicies.customerConfigurationId, qualification.customerConfigurationId),
        eq(inventorySourceProvisioningPolicies.issuerBackendKind, qualification.issuer.backendKind),
        eq(inventorySourceProvisioningPolicies.issuerBackendId, qualification.issuer.backendId),
        eq(inventorySourceProvisioningPolicies.namespace, qualification.namespace),
        eq(inventorySourceProvisioningPolicies.externalScope, qualification.externalScope),
      ),
    );

  const insert: SourceProvisioningPolicyPersistence['insert'] = Effect.fn('SourceProvisioningPolicyPersistence.insert')(
    function* insertPolicy(policy) {
      if (policy.policyRef.tenantId !== scope.tenantId) {
        return yield* sourceProvisioningUnavailable('Source Provisioning Policy tenant does not match trusted scope');
      }
      const [inserted] = yield* transaction
        .insert(inventorySourceProvisioningPolicies)
        .values({
          customerConfigurationId: policy.customerConfigurationId,
          definedAt: instantAsDate(policy.definedAt),
          effectiveFrom: instantAsDate(policy.effectiveFrom),
          externalScope: policy.externalScope,
          issuerBackendId: policy.issuer.backendId,
          issuerBackendKind: policy.issuer.backendKind,
          namespace: policy.namespace,
          ownerConfigurationId: policy.ownerConfigurationRef.resourceId,
          policyId: policy.policyRef.resourceId,
          tenantId: scope.tenantId,
          unitResourceId: policy.unitRef.resourceId,
        })
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.mapError(sourceProvisioningUnavailable));
      if (inserted === undefined) {
        const existing = yield* findByOwnerConfiguration(policy.ownerConfigurationRef.resourceId);
        return Option.isSome(existing)
          ? { outcome: 'EXISTING' as const, policy: existing.value }
          : yield* sourceProvisioningUnavailable('A conflicting Source Provisioning Policy could not be read');
      }
      yield* transaction
        .insert(inventorySourceProvisioningPolicyLocations)
        .values(
          policy.locations.map(({ locationKey, stockLocationRef }) => ({
            locationKey,
            policyId: policy.policyRef.resourceId,
            stockLocationId: stockLocationRef.resourceId,
            tenantId: scope.tenantId,
          })),
        )
        .pipe(Effect.mapError(sourceProvisioningUnavailable));
      return { outcome: 'INSERTED' as const, policy: yield* decode(inserted) };
    },
  );

  return Object.freeze({ findByOwnerConfiguration, findByQualification, findByRef, insert, lockOwnerConfiguration });
};

export const sourceStockItemProvisioningReceiptPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): SourceStockItemProvisioningReceiptPersistence => {
  const findByInvocation: SourceStockItemProvisioningReceiptPersistence['findByInvocation'] = (actionInvocationId) =>
    transaction
      .select()
      .from(inventorySourceStockItemProvisionings)
      .where(
        and(
          eq(inventorySourceStockItemProvisionings.tenantId, scope.tenantId),
          eq(inventorySourceStockItemProvisionings.actionInvocationId, actionInvocationId),
        ),
      )
      .limit(1)
      .pipe(
        Effect.mapError(sourceProvisioningUnavailable),
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeReceiptRow(row).pipe(Effect.asSome))),
      );

  const append: SourceStockItemProvisioningReceiptPersistence['append'] = Effect.fn(
    'SourceStockItemProvisioningReceiptPersistence.append',
  )(function* appendReceipt(receipt) {
    if (receipt.provisioning.policyRef.tenantId !== scope.tenantId) {
      return yield* sourceProvisioningUnavailable('Provisioning receipt tenant does not match trusted scope');
    }
    const [row] = yield* transaction
      .insert(inventorySourceStockItemProvisionings)
      .values({
        actionInvocationId: receipt.actionInvocationId,
        inputJson: receipt.input,
        itemKey: receipt.provisioning.itemKey,
        policyId: receipt.provisioning.policyRef.resourceId,
        provisioningJson: receipt.provisioning,
        recordedAt: instantAsDate(receipt.recordedAt),
        stockItemId: receipt.provisioning.stockItem.ref.resourceId,
        tenantId: scope.tenantId,
      })
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(sourceProvisioningUnavailable));
    if (row === undefined) {
      const original = yield* findByInvocation(receipt.actionInvocationId);
      if (
        Option.isSome(original) &&
        computeCanonicalValueHash(original.value.input) === computeCanonicalValueHash(receipt.input)
      ) {
        return original.value;
      }
      return yield* sourceProvisioningUnavailable('Provisioning invocation already records different input');
    }
    return yield* decodeReceiptRow(row);
  });

  return Object.freeze({ append, findByInvocation });
};
