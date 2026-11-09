import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { UpdateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/update-customer-group-action';
import { ImportSourceAssertionPayloadSchema } from '@app/inventory/source-import';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Schema } from 'effect';

export const internalSyncSource = {
  issuerId: 'INTERNAL_C14_SYNC_ISSUER',
  mappingVersion: 'INTERNAL_C14_SYNC_MAPPING_1',
  namespace: 'INTERNAL_C14_SYNC',
  routeRevision: 'INTERNAL_C14_SYNC_ROUTE_1',
} as const;

interface InternalSyncOccurrence {
  readonly occurrenceId: string;
  readonly recordId: string;
}

const groupOperation = {
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
} as const;

/** Every source and business fact is explicit; these fixtures never infer a Group's meaning. */
export const makeInternalGroupCreatePlan = (
  occurrence: InternalSyncOccurrence,
  payload: typeof CreateCustomerGroupPayloadSchema.Encoded,
) =>
  Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)(payload).pipe(
    Effect.flatMap(Schema.encodeEffect(CreateCustomerGroupPayloadSchema)),
    Effect.flatMap((normalized) =>
      Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
        items: [
          {
            effects: [
              {
                effectKey: 'customer-group-create',
                intent: { _tag: 'CustomerGroupCreate', payload: normalized },
                operation: { ...groupOperation, entrypointKey: 'commerce.customer-context.create-customer-group' },
              },
            ],
            itemKey: 'customer-group',
            source: {
              entityKind: 'CUSTOMER_GROUP',
              issuerId: internalSyncSource.issuerId,
              sourceNamespace: internalSyncSource.namespace,
              sourceRecordId: occurrence.recordId,
            },
            sourceOccurrenceId: occurrence.occurrenceId,
          },
        ],
      }),
    ),
  );

export const makeInternalGroupUpdatePlan = (
  occurrence: InternalSyncOccurrence,
  payload: typeof UpdateCustomerGroupPayloadSchema.Encoded,
) =>
  Schema.decodeUnknownEffect(UpdateCustomerGroupPayloadSchema)(payload).pipe(
    Effect.flatMap(Schema.encodeEffect(UpdateCustomerGroupPayloadSchema)),
    Effect.flatMap((normalized) =>
      Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
        items: [
          {
            effects: [
              {
                effectKey: 'customer-group-update',
                intent: { _tag: 'CustomerGroupUpdate', payload: normalized },
                operation: { ...groupOperation, entrypointKey: 'commerce.customer-context.update-customer-group' },
                originalTarget: normalized.groupRef,
              },
            ],
            itemKey: 'customer-group',
            source: {
              entityKind: 'CUSTOMER_GROUP',
              issuerId: internalSyncSource.issuerId,
              sourceNamespace: internalSyncSource.namespace,
              sourceRecordId: occurrence.recordId,
            },
            sourceOccurrenceId: occurrence.occurrenceId,
          },
        ],
      }),
    ),
  );

/** Absolute physical on-hand is the only declared Stock meaning; reservations stay unsupported. */
export const makeInternalStockPlan = (
  occurrence: InternalSyncOccurrence,
  payload: typeof ImportSourceAssertionPayloadSchema.Encoded,
  reservedQuantityHint: boolean,
) =>
  Schema.decodeUnknownEffect(ImportSourceAssertionPayloadSchema)(payload).pipe(
    Effect.flatMap(Schema.encodeEffect(ImportSourceAssertionPayloadSchema)),
    Effect.flatMap((normalized) =>
      Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
        items: [
          {
            effects: [
              {
                effectKey: 'inventory-absolute-on-hand',
                intent: { _tag: 'InventoryImport', payload: normalized },
                operation: {
                  entrypointKey: 'commerce.inventory.import-source-assertion',
                  moduleId: 'commerce.inventory',
                  schemaVersion: '1',
                },
                originalTarget: normalized.authorizationTargetRef,
              },
            ],
            itemKey: 'stock',
            source: {
              entityKind: 'STOCK',
              issuerId: internalSyncSource.issuerId,
              sourceNamespace: internalSyncSource.namespace,
              sourceRecordId: occurrence.recordId,
            },
            sourceOccurrenceId: occurrence.occurrenceId,
            unsupportedBranches: reservedQuantityHint
              ? [{ branchKey: 'reserved-quantity', kind: 'ReservedQuantityHint' }]
              : [],
          },
        ],
      }),
    ),
  );
