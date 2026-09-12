// Canonical schema-only contract extracted from the generated update-customer-group Action.
import { Schema } from 'effect';

import {
  CommerceCustomerGroupSchema,
  CustomerGroupDefinitionTextSchema,
  CustomerGroupRevisionSchema,
  CustomerGroupTextSchema,
} from '../domain/group-contract.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';

export const UpdateCustomerGroupPayloadSchema = Schema.Struct({
  description: CustomerGroupDefinitionTextSchema,
  expectedRevision: CustomerGroupRevisionSchema,
  groupRef: CustomerGroupRefSchema,
  membershipCriteria: CustomerGroupDefinitionTextSchema,
  name: CustomerGroupTextSchema,
  purpose: CustomerGroupDefinitionTextSchema,
  reason: CustomerGroupTextSchema,
});
export type UpdateCustomerGroupPayload = typeof UpdateCustomerGroupPayloadSchema.Type;

export const UpdateCustomerGroupResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  group: CommerceCustomerGroupSchema,
});
