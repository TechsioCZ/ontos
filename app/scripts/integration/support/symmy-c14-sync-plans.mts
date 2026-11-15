import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { UpdateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/update-customer-group-action';
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
