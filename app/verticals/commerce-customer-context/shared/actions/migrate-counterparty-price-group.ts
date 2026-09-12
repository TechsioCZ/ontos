import { Schema } from 'effect';
import { CounterpartyRefSchema } from '../domain/access-contract.ts';
import {
  CounterpartyPriceGroupProfileTargetSchema,
  CustomerPriceGroupAssignmentSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupReasonSchema,
  PriceGroupRefSchema,
  PriceGroupRevisionSchema,
} from '../domain/price-group-contracts.ts';
import { CustomerPriceGroupAssignmentRefSchema } from '../resources/customer-price-group-assignment.ts';

const MigrationTargetSchema = Schema.Struct({
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  expectedProfileRevision: PriceGroupRevisionSchema,
  expectedRevision: PriceGroupRevisionSchema,
  profile: CounterpartyPriceGroupProfileTargetSchema,
});

export const MigrateCounterpartyPriceGroupPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  effectiveFrom: PriceGroupInstantJsonSchema,
  reason: PriceGroupReasonSchema,
  sourcePriceGroupRef: PriceGroupRefSchema,
  targetPriceGroupRef: PriceGroupRefSchema,
  targets: Schema.Array(MigrationTargetSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type MigrateCounterpartyPriceGroupPayload = typeof MigrateCounterpartyPriceGroupPayloadSchema.Type;

const MigrationConflictItemSchema = Schema.Struct({
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  reason: Schema.Literals(['ASSIGNMENT_CHANGED', 'ASSIGNMENT_MISSING', 'OVERLAP', 'PROFILE_INELIGIBLE']),
});
export const MigrateCounterpartyPriceGroupResultSchema = Schema.Union([
  Schema.TaggedStruct('MIGRATED', {
    assignments: Schema.Array(CustomerPriceGroupAssignmentSchema).check(Schema.isMaxLength(100)),
    changed: Schema.Boolean,
  }),
  Schema.TaggedStruct('CONFLICTS', {
    conflicts: Schema.Array(MigrationConflictItemSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
]);
export type MigrateCounterpartyPriceGroupResult = typeof MigrateCounterpartyPriceGroupResultSchema.Type;
