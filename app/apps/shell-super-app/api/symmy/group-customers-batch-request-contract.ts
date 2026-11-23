import { SymmyGroupCustomerRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

import { SymmyFixtureSubmitPayloadSchema, SymmyInternalPlanPayloadSchema } from './contract.ts';

/**
 * The public body of `POST /customer-groups/{code}/customers/batch`: one to sixteen customers to assign to the group
 * the path code selects, each named once by the ERP's own customer id, the `customerId` the same source sent in
 * `POST /customers/batch`. Symmy resolves each id to the customer profile it created for that source record; a
 * customer the source has not sent yet is refused for its item alone. Assignment only: the body names no group, no
 * removal, no replacement set, no order, time, profile reference, plan, fixture or source fact.
 */
export const SymmyGroupCustomersBatchRequestSchema = Schema.Struct({ customers: SymmyGroupCustomerRowsSchema });
export type SymmyGroupCustomersBatchRequest = typeof SymmyGroupCustomersBatchRequestSchema.Type;

/** What the route accepts: the public customers, or an internal fixture or plan. */
export const SymmyGroupCustomersBatchPayloadSchema = Schema.Union([
  SymmyGroupCustomersBatchRequestSchema,
  SymmyFixtureSubmitPayloadSchema,
  SymmyInternalPlanPayloadSchema,
]);
