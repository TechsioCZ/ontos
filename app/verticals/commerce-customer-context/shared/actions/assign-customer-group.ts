// Canonical schema-only contract extracted from the generated assign-customer-group Action.
import { Schema } from 'effect';

import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerProfileSubjectSchema,
  CustomerGroupIsoTimestampSchema,
  CustomerGroupTextSchema,
} from '../domain/group-contract.ts';
import { CustomerGroupRefSchema } from '../resources/customer-group.ts';

export const AssignCustomerGroupPayloadSchema = Schema.Struct({
  effectiveFrom: CustomerGroupIsoTimestampSchema,
  effectiveTo: Schema.optionalKey(CustomerGroupIsoTimestampSchema),
  groupRef: CustomerGroupRefSchema,
  profile: CommerceCustomerProfileSubjectSchema,
  reason: CustomerGroupTextSchema,
}).check(
  Schema.makeFilter((payload) =>
    payload.effectiveTo === undefined || payload.effectiveTo > payload.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
  ),
);
export type AssignCustomerGroupPayload = typeof AssignCustomerGroupPayloadSchema.Type;

export const AssignCustomerGroupResultSchema = Schema.Struct({
  created: Schema.Boolean,
  membership: CommerceCustomerGroupMembershipSchema,
});
