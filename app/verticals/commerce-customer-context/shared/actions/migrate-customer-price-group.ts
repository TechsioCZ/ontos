import { Schema } from 'effect';
import {
  CustomerPriceGroupAssignmentSchema,
  PriceGroupInstantJsonSchema,
  PriceGroupReasonSchema,
  PriceGroupRefSchema,
  PriceGroupRevisionSchema,
  RetailPriceGroupProfileTargetSchema,
} from '../domain/price-group-contracts.ts';
import { CustomerPriceGroupAssignmentRefSchema } from '../resources/customer-price-group-assignment.ts';

const MigrationTargetSchema = Schema.Struct({
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  expectedProfileRevision: PriceGroupRevisionSchema,
  expectedRevision: PriceGroupRevisionSchema,
  profile: RetailPriceGroupProfileTargetSchema,
});
const MigrationTargetsSchema = Schema.Array(MigrationTargetSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

export const MigrateCustomerPriceGroupPayloadSchema = Schema.Struct({
  effectiveFrom: PriceGroupInstantJsonSchema,
  reason: PriceGroupReasonSchema,
  sourcePriceGroupRef: PriceGroupRefSchema,
  targetPriceGroupRef: PriceGroupRefSchema,
  targets: MigrationTargetsSchema,
});
export type MigrateCustomerPriceGroupPayload = typeof MigrateCustomerPriceGroupPayloadSchema.Type;

const MigrationConflictItemSchema = Schema.Struct({
  assignmentRef: CustomerPriceGroupAssignmentRefSchema,
  reason: Schema.Literals([
    'ASSIGNMENT_CHANGED',
    'ASSIGNMENT_MISSING',
    'OVERLAP',
    'PROFILE_INELIGIBLE',
  ]),
});
export const MigrateCustomerPriceGroupResultSchema = Schema.Union([
  Schema.TaggedStruct('MIGRATED', {
    assignments: Schema.Array(CustomerPriceGroupAssignmentSchema).check(Schema.isMaxLength(100)),
    changed: Schema.Boolean,
  }),
  Schema.TaggedStruct('CONFLICTS', {
    conflicts: Schema.Array(MigrationConflictItemSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
]);
export type MigrateCustomerPriceGroupResult = typeof MigrateCustomerPriceGroupResultSchema.Type;
