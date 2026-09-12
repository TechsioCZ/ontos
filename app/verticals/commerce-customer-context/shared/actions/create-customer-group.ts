// Canonical schema-only contract extracted from the generated create-customer-group Action.
import { Schema } from 'effect';

import {
  CommerceCustomerGroupSchema,
  CustomerGroupBusinessCodeSchema,
  CustomerGroupDefinitionTextSchema,
  CustomerGroupMeaningKeySchema,
  CustomerGroupTextSchema,
} from '../domain/group-contract.ts';

export const CreateCustomerGroupPayloadSchema = Schema.Struct({
  businessCode: CustomerGroupBusinessCodeSchema,
  description: CustomerGroupDefinitionTextSchema,
  initialState: Schema.Literal('ACTIVE'),
  meaningKey: CustomerGroupMeaningKeySchema,
  membershipCriteria: CustomerGroupDefinitionTextSchema,
  name: CustomerGroupTextSchema,
  purpose: CustomerGroupDefinitionTextSchema,
  reason: CustomerGroupTextSchema,
});
export type CreateCustomerGroupPayload = typeof CreateCustomerGroupPayloadSchema.Type;

export const CreateCustomerGroupResultSchema = Schema.Struct({
  created: Schema.Boolean,
  group: CommerceCustomerGroupSchema,
});
