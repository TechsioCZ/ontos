import { and, eq, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import {
  CustomerGroupDefinitionSourceSchema,
  CustomerGroupRevisionSchema,
} from '../../shared/domain/group-contract.ts';
import { CustomerGroupRefSchema } from '../../shared/resources/customer-group.ts';
import {
  customerGroupDefinitionSourceBindings,
  customerGroupDefinitionSourceRoutes,
  customerGroups,
} from '../../src/database/schema.ts';
import { withVerifiedCustomerContextFixture } from './customer-context-owned-fixture.ts';
import type { CustomerContextOwnedFixtureInput } from './customer-context-owned-fixture.ts';

export const CustomerGroupSourceObservationLocatorSchema = Schema.Struct({
  issuer: CustomerGroupDefinitionSourceSchema.fields.issuer,
  mappingRevision: CustomerGroupDefinitionSourceSchema.fields.mappingRevision,
  namespace: CustomerGroupDefinitionSourceSchema.fields.namespace,
  recordId: CustomerGroupDefinitionSourceSchema.fields.recordId,
  route: CustomerGroupDefinitionSourceSchema.fields.route,
});
export const CustomerGroupSourceNativeObservationSchema = Schema.Struct({
  groupRef: CustomerGroupRefSchema,
  revision: CustomerGroupRevisionSchema,
  state: Schema.Literals(['ACTIVE', 'ARCHIVED']),
});
export type CustomerGroupSourceNativeObservation = typeof CustomerGroupSourceNativeObservationSchema.Type;
export interface CustomerGroupSourceObservationFixtureInput extends CustomerContextOwnedFixtureInput {
  readonly source: typeof CustomerGroupSourceObservationLocatorSchema.Type;
}

/** Reads only existing native identity in a verified disposable fixture; no authority or business facts are created. */
export const observeCustomerGroupSourceNativeFixture = Effect.fn('CustomerGroupSourceObservationFixture.observe')(
  function* observeCustomerGroupSourceNativeFixture(input: CustomerGroupSourceObservationFixtureInput) {
    const source = yield* Schema.decodeUnknownEffect(CustomerGroupSourceObservationLocatorSchema, {
      onExcessProperty: 'error',
    })(input.source);
    return yield* withVerifiedCustomerContextFixture(
      input,
      Effect.fn('CustomerGroupSourceObservationFixture.select')(function* selectExistingGroup(transaction) {
        const [row] = yield* transaction
          .select({
            groupId: customerGroups.customerGroupId,
            revision: customerGroups.currentRevision,
            state: customerGroups.lifecycle,
          })
          .from(customerGroupDefinitionSourceBindings)
          .innerJoin(
            customerGroups,
            and(
              eq(customerGroups.tenantId, customerGroupDefinitionSourceBindings.tenantId),
              eq(customerGroups.legalEntityId, customerGroupDefinitionSourceBindings.legalEntityId),
              eq(customerGroups.customerGroupId, customerGroupDefinitionSourceBindings.customerGroupId),
            ),
          )
          .innerJoin(
            customerGroupDefinitionSourceRoutes,
            and(
              eq(customerGroupDefinitionSourceRoutes.tenantId, customerGroupDefinitionSourceBindings.tenantId),
              eq(
                customerGroupDefinitionSourceRoutes.legalEntityId,
                customerGroupDefinitionSourceBindings.legalEntityId,
              ),
              eq(customerGroupDefinitionSourceRoutes.issuer, customerGroupDefinitionSourceBindings.issuer),
              eq(customerGroupDefinitionSourceRoutes.namespace, customerGroupDefinitionSourceBindings.namespace),
            ),
          )
          .where(
            and(
              eq(customerGroupDefinitionSourceBindings.tenantId, input.tenantId),
              eq(customerGroupDefinitionSourceBindings.legalEntityId, input.legalEntityId),
              eq(customerGroupDefinitionSourceBindings.issuer, source.issuer),
              eq(customerGroupDefinitionSourceBindings.namespace, source.namespace),
              eq(customerGroupDefinitionSourceBindings.recordId, source.recordId),
              eq(customerGroupDefinitionSourceRoutes.active, true),
              eq(customerGroupDefinitionSourceRoutes.routeId, source.route.id),
              eq(customerGroupDefinitionSourceRoutes.routeRevision, source.route.revision),
              eq(customerGroupDefinitionSourceRoutes.mappingRevision, source.mappingRevision),
              sql`${customerGroupDefinitionSourceBindings.sourceIntent}->'payload'->'source'->'route'->>'id' = ${source.route.id}`,
              sql`${customerGroupDefinitionSourceBindings.sourceIntent}->'payload'->'source'->'route'->>'revision' = ${source.route.revision}`,
              sql`${customerGroupDefinitionSourceBindings.sourceIntent}->'payload'->'source'->>'mappingRevision' = ${source.mappingRevision}`,
            ),
          );
        if (row === undefined) {
          return Option.none<CustomerGroupSourceNativeObservation>();
        }
        const observation = yield* Schema.decodeUnknownEffect(CustomerGroupSourceNativeObservationSchema)({
          groupRef: {
            moduleId: 'commerce.customer-context',
            resourceId: row.groupId,
            resourceType: 'commerce.customer-context.customer-group',
            tenantId: input.tenantId,
          },
          revision: row.revision,
          state: row.state,
        });
        return Option.some(observation);
      }),
    );
  },
);
