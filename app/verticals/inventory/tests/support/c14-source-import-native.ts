import { makeOperationalScopeRepository, makePrincipalResolver, parseDatabaseConfig } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { ActiveLifecycleSchema, StockLocationSchema } from '../../shared/domain/stock-location.ts';
import { StockPositionSchema, UnknownOnHandEvidenceSchema } from '../../shared/domain/stock-position.ts';
import {
  ExternalStockCorrelationSchema,
  ExternalStockItemTargetSchema,
  ExternalStockLocationTargetSchema,
} from '../../shared/domain/external-stock-correlation.ts';
import { inventoryBackendConfigurationPersistenceForScope } from '../../src/persistence/inventory-backend-configuration-repository.ts';
import {
  StockItemRepository,
  stockItemRepositoryLayerForTransaction,
} from '../../src/persistence/stock-item-repository.ts';
import { stockLocationPersistenceForScope } from '../../src/persistence/stock-location-repository.ts';
import { stockPositionPersistenceForScope } from '../../src/persistence/stock-position-repository.ts';
import { externalStockCorrelationPersistenceForScope } from '../../src/persistence/external-stock-correlation-repository.ts';

interface ExactReference {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const sameReference = (left: ExactReference, right: ExactReference) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** Explicit INTERNAL fixture facts. No identifier, Unit, backend, timestamp or physical quantity is inferred. */
export const C14InventorySourceImportSetupSchema = Schema.Struct({
  configuration: InventoryBackendConfigurationSchema,
  itemCorrelation: ExternalStockCorrelationSchema,
  locationCorrelation: ExternalStockCorrelationSchema,
  stockItem: StockItemSchema,
  stockLocation: StockLocationSchema,
  stockPosition: StockPositionSchema,
}).check(
  Schema.makeFilter(({ configuration, stockItem, stockLocation, stockPosition }) =>
    [stockItem.stockItemRef, stockLocation.ref, stockPosition.ref].every(
      ({ tenantId }) => tenantId === configuration.tenantId,
    ) &&
    sameReference(stockItem.stockItemRef, stockPosition.scope.stockItemRef) &&
    sameReference(stockLocation.ref, stockPosition.scope.stockLocationRef) &&
    sameReference(stockItem.unitRef, stockPosition.scope.unitRef) &&
    stockPosition.scope.customerConfigurationId === configuration.customerConfigurationId
      ? undefined
      : 'Inventory fixture Item, Location, Position, Unit and Customer Configuration must share one exact scope',
  ),
  Schema.makeFilter(({ configuration, stockItem, stockLocation, stockPosition }) =>
    configuration.selection.backend === 'external_business_system' &&
    stockItem.lifecycle === 'CURRENT' &&
    stockItem.revision === 1 &&
    Schema.is(ActiveLifecycleSchema)(stockLocation.lifecycle) &&
    stockLocation.revision === 1 &&
    stockPosition.lifecycle === 'CURRENT' &&
    stockPosition.revision === 1 &&
    Schema.is(UnknownOnHandEvidenceSchema)(stockPosition.onHand) &&
    stockPosition.onHand.ownerConfigurationRef.resourceId === configuration.configurationId &&
    stockPosition.onHand.ownerConfigurationRef.tenantId === configuration.tenantId
      ? undefined
      : 'Inventory fixture setup requires initial external authority and an UNKNOWN exact Position, never physical stock evidence',
  ),
  Schema.makeFilter(({ configuration, itemCorrelation, locationCorrelation }) =>
    [itemCorrelation, locationCorrelation].every(
      ({ externalKey, lifecycle, revision }) =>
        String(externalKey.tenantId) === String(configuration.tenantId) &&
        externalKey.customerConfigurationId === configuration.customerConfigurationId &&
        externalKey.issuer.backendKind === configuration.selection.backend &&
        externalKey.issuer.backendId === configuration.selection.backendId &&
        lifecycle === 'CURRENT' &&
        revision === 1,
    )
      ? undefined
      : 'Inventory fixture correlations must retain the exact selected external issuer and initial Current scope',
  ),
  Schema.makeFilter(({ itemCorrelation, locationCorrelation, stockItem, stockLocation }) =>
    Schema.is(ExternalStockItemTargetSchema)(itemCorrelation.target) &&
    Schema.is(ExternalStockLocationTargetSchema)(locationCorrelation.target) &&
    sameReference(itemCorrelation.target.ref, stockItem.stockItemRef) &&
    sameReference(locationCorrelation.target.ref, stockLocation.ref)
      ? undefined
      : 'Inventory fixture Item and Location correlations must target the exact explicit owner references',
  ),
);
export type C14InventorySourceImportSetup = typeof C14InventorySourceImportSetupSchema.Type;

export interface C14InventorySourceImportNativeRequest {
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
  readonly runtimeConnectionString: Redacted.Redacted;
  readonly setup: C14InventorySourceImportSetup;
  readonly tenantId: string;
}

export class C14InventorySourceImportSetupUnavailable extends Schema.TaggedError<C14InventorySourceImportSetupUnavailable>()(
  'C14InventorySourceImportSetupUnavailable',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new C14InventorySourceImportSetupUnavailable({
    cause: Redacted.make(cause),
    reason: 'The owned C14 Inventory source fixture setup could not be verified',
  });
interface ConnectionFacts extends Record<string, unknown> {
  readonly bypassRls: boolean;
  readonly database: string;
  readonly sessionUser: string;
  readonly superuser: boolean;
  readonly user: string;
}

/** Operator-only test setup; business import still requires genuine Shell/Core/Inventory authorization. */
export const prepareC14InventorySourceImportNative = Effect.fn('C14InventorySourceImportNative.prepare')(
  function* prepare(input: C14InventorySourceImportNativeRequest) {
    yield* requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
      adminConnectionString: Redacted.make(input.ownedDatabase.connections.admin.connectionString),
      purpose: 'implementation-1096-registered-workload-gateway',
      runtimeConnectionString: input.runtimeConnectionString,
    }).pipe(Effect.mapError(unavailable));
    const configuration = yield* parseDatabaseConfig({
      DATABASE_URL: Redacted.value(input.runtimeConnectionString),
    }).pipe(Effect.mapError(unavailable));
    if (!['127.0.0.1', 'localhost', '::1'].includes(configuration.host)) {
      return yield* unavailable();
    }
    const setup = yield* Schema.decodeUnknownEffect(C14InventorySourceImportSetupSchema, { onExcessProperty: 'error' })(
      input.setup,
    ).pipe(Effect.mapError(unavailable));
    if (setup.configuration.tenantId !== input.tenantId) {
      return yield* unavailable();
    }
    const scope = yield* stageScopeOf({ principalId: input.operatorPrincipalId, tenantId: input.tenantId }).pipe(
      Effect.mapError(unavailable),
    );
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: input.runtimeConnectionString }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(unavailable),
    );
    const database = yield* testCoreDatabase.pipe(
      Effect.provideService(PgClient.PgClient, client),
      Effect.mapError(unavailable),
    );
    return yield* database
      .transaction(
        Effect.fn('C14InventorySourceImportNative.store')(function* store(transaction) {
          const [connection] = yield* transaction
            .execute<ConnectionFacts>(
              sql`select current_database()::text as database, current_user::text as "user", session_user::text as "sessionUser", rolsuper as superuser, rolbypassrls as "bypassRls" from pg_roles where rolname=current_user`,
              'objects',
            )
            .pipe(Effect.mapError(unavailable));
          if (
            connection === undefined ||
            connection.database !== configuration.database ||
            connection.user !== configuration.user ||
            connection.sessionUser !== configuration.user ||
            connection.superuser ||
            connection.bypassRls
          ) {
            return yield* unavailable();
          }
          const scoped = yield* installOperationalScope(transaction, scope).pipe(Effect.mapError(unavailable));
          const identity = yield* makePrincipalResolver(
            { executor: database },
            { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
          )
            .resolveBetterAuthUserForTenant(input.operatorProviderUserId, input.tenantId)
            .pipe(Effect.mapError(unavailable));
          if (
            identity.principalId !== input.operatorPrincipalId ||
            identity.principalKind !== 'human' ||
            identity.tenantId !== input.tenantId
          ) {
            return yield* unavailable();
          }
          const persisted = yield* makeOperationalScopeRepository({ executor: transaction })
            .load(scope)
            .pipe(Effect.mapError(unavailable));
          if (
            persisted.tenantStatus !== 'active' ||
            persisted.principalStatus !== 'active' ||
            persisted.principalTenantId !== input.tenantId ||
            scope.legalEntityId !== undefined
          ) {
            return yield* unavailable();
          }
          yield* inventoryBackendConfigurationPersistenceForScope(scoped, scope).insertInitial(setup.configuration);
          const stockItemServices = yield* Layer.build(stockItemRepositoryLayerForTransaction(scoped));
          yield* Context.get(stockItemServices, StockItemRepository).insert(setup.stockItem);
          yield* stockLocationPersistenceForScope(scoped, scope).create(setup.stockLocation);
          yield* stockPositionPersistenceForScope(scoped, scope).create(setup.stockPosition);
          const correlations = externalStockCorrelationPersistenceForScope(scoped, scope);
          yield* correlations.insertCurrent(setup.itemCorrelation);
          yield* correlations.insertCurrent(setup.locationCorrelation);
          return setup;
        }),
      )
      .pipe(Effect.mapError(unavailable));
  },
  Effect.scoped,
);
