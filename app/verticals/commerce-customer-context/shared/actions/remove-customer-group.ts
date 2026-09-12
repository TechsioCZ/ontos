// Canonical schema-only contract extracted from the generated remove-customer-group Action.
import { Schema } from 'effect';

import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerProfileSubjectSchema,
  CustomerGroupIsoTimestampSchema,
  CustomerGroupTextSchema,
} from '../domain/group-contract.ts';
import { CustomerGroupMembershipRefSchema } from '../resources/customer-group-membership.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';

export const RemoveCustomerGroupPayloadSchema = Schema.Struct({
  effectiveAt: CustomerGroupIsoTimestampSchema,
  groupRef: CustomerGroupRefSchema,
  membershipRef: CustomerGroupMembershipRefSchema,
  profile: CommerceCustomerProfileSubjectSchema,
  reason: CustomerGroupTextSchema,
});
export type RemoveCustomerGroupPayload = typeof RemoveCustomerGroupPayloadSchema.Type;

export const RemoveCustomerGroupResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  membership: CommerceCustomerGroupMembershipSchema,
});
