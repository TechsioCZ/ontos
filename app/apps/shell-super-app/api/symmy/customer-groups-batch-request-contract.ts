import { SymmyCustomerGroupRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

/**
 * The public body of `POST /customer-groups/batch`: one to sixteen source-managed customer groups. Each group states
 * its stable code, its business code and its meaning in the Commerce owner's own fields, so what the owner cannot
 * store is refused with 400. No price, discount, membership, plan, fixture, source or authority field exists: a group
 * assigns nothing, and the route enrollment supplies every source and authority fact.
 */
export const SymmyCustomerGroupsBatchRequestSchema = Schema.Struct({ customerGroups: SymmyCustomerGroupRowsSchema });
