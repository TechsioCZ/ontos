import { CustomerProfileSourceItemSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import { SymmyGroupCustomerRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import type { SymmyGroupCustomerRows } from '@app/symmy-integration/symmy-internal-contracts';
import { Array as EffectArray, Schema } from 'effect';

import { SymmyInternalPlanPayloadSchema } from './contract.ts';

/** The profile reference `GET /admin/customers` returns for a customer, copied back unchanged. */
const SymmyGroupCustomerSchema = Schema.Struct({
  profileRef: CustomerProfileSourceItemSchema.fields.profile.fields.profileRef,
});
type SymmyGroupCustomer = typeof SymmyGroupCustomerSchema.Type;

/** The customer as the owner names it in a membership: the profile kind beside the exact profile reference. */
const toGroupCustomerRow = ({ profileRef }: SymmyGroupCustomer): SymmyGroupCustomerRows[number] => {
  if (profileRef.kind === 'RETAIL') {
    const { kind, ...retail } = profileRef;
    return { profile: { profileKind: kind, profileRef: retail } };
  }
  const { kind, ...counterparty } = profileRef;
  return { profile: { profileKind: kind, profileRef: counterparty } };
};

/**
 * The public body of `POST /customer-groups/{code}/customers/batch`: one to sixteen customers to assign to the group
 * the path code selects, each named by its profile reference. Assignment only: the body names no group, no removal,
 * no replacement set, no order, time, plan, fixture or source fact, and two spellings of one profile are refused.
 */
export const SymmyGroupCustomersBatchRequestSchema = Schema.Struct({
  customers: Schema.NonEmptyArray(SymmyGroupCustomerSchema).check(
    Schema.makeFilter(
      (customers) =>
        Schema.is(SymmyGroupCustomerRowsSchema)(customers.map(toGroupCustomerRow)) ||
        'One to sixteen distinct customer profiles, each referenced by its UUID',
    ),
  ),
});
export type SymmyGroupCustomersBatchRequest = typeof SymmyGroupCustomersBatchRequestSchema.Type;

/**
 * What the route accepts: the public customers, or an internal plan of owner intents no public body states. A plan
 * that states a customer group definition or membership is refused with 400.
 */
export const SymmyGroupCustomersBatchPayloadSchema = Schema.Union([
  SymmyGroupCustomersBatchRequestSchema,
  SymmyInternalPlanPayloadSchema,
]);

/** The customers as the owner admission receives them. The route enrollment names the group and the source. */
export const mapSymmyGroupCustomersBatchRequest = ({
  customers,
}: SymmyGroupCustomersBatchRequest): SymmyGroupCustomerRows =>
  EffectArray.map<SymmyGroupCustomersBatchRequest['customers'], SymmyGroupCustomerRows[number]>(toGroupCustomerRow)(
    customers,
  );
