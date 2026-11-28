import { SymmyGroupCustomerRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

import { SymmyInternalWritePayloadSchema } from './contract.ts';

/**
 * The public body of `POST /customer-groups/{code}/customers/batch`: one to sixteen customers to assign to the group
 * the path code selects, each named once by the ERP's own customer id, the `customerId` the same source sent in
 * `POST /customers/batch`. Symmy resolves each id to the customer profile the owner currently holds for that source
 * record; a customer it names none for is refused for its item alone. Assignment only: the body names no group, no
 * removal, no replacement set, no order, time, profile reference, plan, fixture or source fact.
 */
export const SymmyGroupCustomersBatchRequestSchema = Schema.Struct({ customers: SymmyGroupCustomerRowsSchema });

/**
 * What the route takes: the ERP's customers, on a route enrolled for ERP memberships, or the internal write it has
 * always taken, on a route enrolled for that. A route admits the one it is enrolled for and refuses the other.
 */
export const SymmyGroupCustomersRoutePayloadSchema = Schema.Union([
  SymmyGroupCustomersBatchRequestSchema,
  SymmyInternalWritePayloadSchema,
]);
