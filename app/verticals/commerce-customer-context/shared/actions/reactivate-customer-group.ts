// Canonical schema-only contract extracted from the generated reactivate-customer-group Action.
import { Schema } from 'effect';

import {
  CommerceCustomerGroupSchema,
  CustomerGroupIsoTimestampSchema,
  CustomerGroupRevisionSchema,
  CustomerGroupTextSchema,
} from '../domain/group-contract.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';

export const ReactivateCustomerGroupPayloadSchema = Schema.Struct({
  effectiveAt: CustomerGroupIsoTimestampSchema,
  expectedRevision: CustomerGroupRevisionSchema,
  groupRef: CustomerGroupRefSchema,
  reason: CustomerGroupTextSchema,
});
export type ReactivateCustomerGroupPayload = typeof ReactivateCustomerGroupPayloadSchema.Type;

export const ReactivateCustomerGroupResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  group: CommerceCustomerGroupSchema,
});
