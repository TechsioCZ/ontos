import { SymmyInternalCustomersProjectionSchema } from './read-projection-contracts.ts';
import type { SymmyInternalCustomersProjection } from './read-projection-contracts.ts';
import { Schema, Struct } from 'effect';

const projectionFields = SymmyInternalCustomersProjectionSchema.fields;
const customerFields = projectionFields.customers.value.fields;

/**
 * The public body of `GET /admin/customers`: camelCase, no internal markers and no nullable field of its own.
 * `partyRef` and `profile` are owner references that the customer revision and the group assignment copy back.
 * The nested `party`, `businessName` and `ico` keep their owner shapes; an unselected or unreadable part is absent.
 */
export const SymmyCustomersResponseSchema = Schema.Struct({
  count: projectionFields.count,
  customers: Schema.Array(
    Schema.Struct({
      ...Struct.pick(customerFields, ['ico', 'id', 'party', 'partyRef', 'profile']),
      businessName: customerFields.business_name,
      sourceRecordId: customerFields.source_record_id,
    }),
  ),
  limit: projectionFields.limit,
  offset: projectionFields.offset,
});
type SymmyCustomersResponse = typeof SymmyCustomersResponseSchema.Type;

const mapCustomer = (customer: SymmyInternalCustomersProjection['customers'][number]) => {
  const { business_name: businessName, source_record_id: sourceRecordId, ...shared } = customer;
  return businessName === undefined ? { ...shared, sourceRecordId } : { ...shared, businessName, sourceRecordId };
};

/** `unsupported_fields` is still computed by the projection and is deliberately not exposed. */
export const mapSymmyCustomersProjection = (projection: SymmyInternalCustomersProjection): SymmyCustomersResponse => ({
  count: projection.count,
  customers: projection.customers.map(mapCustomer),
  limit: projection.limit,
  offset: projection.offset,
});
