// Canonical schema-only contract extracted from the generated archive-customer-group Action.
import { Schema } from 'effect';

import {
  CommerceCustomerGroupSchema,
  CustomerGroupIsoTimestampSchema,
  CustomerGroupRevisionSchema,
  CustomerGroupTextSchema,
} from '../domain/group-contract.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';

export const ArchiveCustomerGroupPayloadSchema = Schema.Struct({
  effectiveAt: CustomerGroupIsoTimestampSchema,
  expectedRevision: CustomerGroupRevisionSchema,
  groupRef: CustomerGroupRefSchema,
  reason: CustomerGroupTextSchema,
});
export type ArchiveCustomerGroupPayload = typeof ArchiveCustomerGroupPayloadSchema.Type;

export const ArchiveCustomerGroupResultSchema = Schema.Struct({
  cancelledCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  changed: Schema.Boolean,
  endedCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  group: CommerceCustomerGroupSchema,
});
