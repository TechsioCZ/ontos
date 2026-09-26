import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import type { Option } from 'effect';

import { InventoryBackendConfigurationPersistenceUnavailable } from '../../shared/domain/inventory-backend-configuration-persistence-unavailable.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export interface InventoryBackendConfigurationPersistence {
  readonly findCurrent: (
    customerConfigurationId: string,
  ) => Effect.Effect<Option.Option<InventoryBackendConfiguration>, InventoryBackendConfigurationPersistenceUnavailable>;
  readonly insertInitial: (
    configuration: InventoryBackendConfiguration,
  ) => Effect.Effect<
    { readonly configuration: InventoryBackendConfiguration; readonly outcome: 'EXISTING' | 'INSERTED' },
    InventoryBackendConfigurationPersistenceUnavailable
  >;
}

const unavailable = (cause?: unknown) => {
  const failure = new InventoryBackendConfigurationPersistenceUnavailable({
    code: 'inventory_backend_configuration_persistence_unavailable',
    reason: 'Inventory Backend configuration persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const decodeConfiguration = Schema.decodeUnknownEffect(InventoryBackendConfigurationSchema);

const toDomain = (row: typeof inventoryBackendConfigurations.$inferSelect) =>
  decodeConfiguration({
    configurationId: row.configurationId,
    customerConfigurationId: row.customerConfigurationId,
    revision: row.revision,
    selectedAt: row.selectedAt.toISOString(),
    selection: {
      backend: row.backendKind,
      backendId: row.backendId,
      exactReservationCapability: row.exactReservationCapability,
      stockCorrectionCapability: row.stockCorrectionCapability,
    },
    tenantId: row.tenantId,
  }).pipe(Effect.mapError(unavailable));

export const inventoryBackendConfigurationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): InventoryBackendConfigurationPersistence => {
  const readRows = (customerConfigurationId: string) =>
    transaction
      .select()
      .from(inventoryBackendConfigurations)
      .where(
        and(
          eq(inventoryBackendConfigurations.tenantId, scope.tenantId),
          eq(inventoryBackendConfigurations.customerConfigurationId, customerConfigurationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));

  const findCurrent: InventoryBackendConfigurationPersistence['findCurrent'] = (customerConfigurationId) =>
    readRows(customerConfigurationId).pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : toDomain(row).pipe(Effect.asSome))),
    );

  const insertInitial: InventoryBackendConfigurationPersistence['insertInitial'] = Effect.fn(
    'InventoryBackendConfigurationPersistence.insertInitial',
  )(function* insertInitialConfiguration(configuration) {
    if (configuration.tenantId !== scope.tenantId) {
      return yield* unavailable('Inventory Backend configuration tenant does not match trusted scope');
    }
    const [inserted] = yield* transaction
      .insert(inventoryBackendConfigurations)
      .values({
        backendId: configuration.selection.backendId,
        backendKind: configuration.selection.backend,
        configurationId: configuration.configurationId,
        customerConfigurationId: configuration.customerConfigurationId,
        exactReservationCapability: configuration.selection.exactReservationCapability,
        revision: configuration.revision,
        selectedAt: DateTime.toDateUtc(DateTime.makeUnsafe(configuration.selectedAt)),
        stockCorrectionCapability: configuration.selection.stockCorrectionCapability,
        tenantId: scope.tenantId,
      })
      .onConflictDoNothing({
        target: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.customerConfigurationId],
      })
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (inserted !== undefined) {
      return { configuration: yield* toDomain(inserted), outcome: 'INSERTED' as const };
    }
    const [existing] = yield* readRows(configuration.customerConfigurationId);
    if (existing === undefined) {
      return yield* unavailable('Conflicting Inventory Backend configuration could not be read');
    }
    return { configuration: yield* toDomain(existing), outcome: 'EXISTING' as const };
  });

  return Object.freeze({ findCurrent, insertInitial });
};
