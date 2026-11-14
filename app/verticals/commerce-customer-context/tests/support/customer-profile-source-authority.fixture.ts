import { makeSystemPrincipalContextResolver, registerSystemWorkload } from '@app/core-runtime';
import { PrincipalIdSchema, TenantIdSchema, LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { CustomerProfileSourceAuthoritySchema } from '../../shared/domain/customer-profile-source.ts';
import { customerProfileSourceRoutes } from '../../src/database/schema.ts';
import {
  withVerifiedCustomerContextFixture,
  CustomerContextOwnedFixtureUnavailable,
} from './customer-context-owned-fixture.ts';
import type { CustomerContextOwnedFixtureInput } from './customer-context-owned-fixture.ts';

export const CustomerProfileSourceAuthorityFixtureRouteSchema = Schema.Struct({
  ...CustomerProfileSourceAuthoritySchema.fields,
  active: Schema.Boolean,
  legalEntityId: Schema.toEncoded(LegalEntityIdSchema),
  principalId: Schema.toEncoded(PrincipalIdSchema),
  tenantId: Schema.toEncoded(TenantIdSchema),
});
export interface CustomerProfileSourceAuthorityFixtureInput extends CustomerContextOwnedFixtureInput {
  readonly route: typeof CustomerProfileSourceAuthorityFixtureRouteSchema.Type;
}
const sourceWriter = registerSystemWorkload({ jobKey: 'commerce.customer-context.source-write' });
const unavailable = () =>
  new CustomerContextOwnedFixtureUnavailable({
    reason: 'The explicit source route and actual enrolled source writer must match this owned fixture',
  });
/** Configures only one exact source route; it creates no Customer Profile, permission or processing proof. */
export const seedCustomerProfileSourceAuthorityNativeFixture = Effect.fn('CustomerProfileSourceAuthorityFixture.seed')(
  function* seedCustomerProfileSourceAuthorityNativeFixture(input: CustomerProfileSourceAuthorityFixtureInput) {
    const route = yield* Schema.decodeUnknownEffect(CustomerProfileSourceAuthorityFixtureRouteSchema, {
      onExcessProperty: 'error',
    })(input.route);
    if (route.tenantId !== input.tenantId || route.legalEntityId !== input.legalEntityId) {
      return yield* unavailable();
    }
    return yield* withVerifiedCustomerContextFixture(
      input,
      Effect.fn('CustomerProfileSourceAuthorityFixture.configure')(
        function* configureSourceRoute(transaction, database) {
          const actual = yield* makeSystemPrincipalContextResolver({ executor: database }).resolveEnrolled({
            registration: sourceWriter,
            runReference: 'customer-profile-source-authority-fixture',
            tenantId: route.tenantId,
          });
          if (actual.principalId !== route.principalId || actual.tenantId !== route.tenantId) {
            return yield* unavailable();
          }
          const row = {
            active: route.active,
            issuer: route.issuer,
            legalEntityId: route.legalEntityId,
            mappingRevision: route.mappingRevision,
            namespace: route.namespace,
            principalId: route.principalId,
            recordType: route.recordType,
            routeId: route.route.id,
            routeRevision: route.route.revision,
            tenantId: route.tenantId,
          };
          yield* transaction.insert(customerProfileSourceRoutes).values(row).onConflictDoNothing();
          const [stored] = yield* transaction
            .select({ routeId: customerProfileSourceRoutes.routeId })
            .from(customerProfileSourceRoutes)
            .where(
              and(
                eq(customerProfileSourceRoutes.tenantId, row.tenantId),
                eq(customerProfileSourceRoutes.legalEntityId, row.legalEntityId),
                eq(customerProfileSourceRoutes.routeId, row.routeId),
                eq(customerProfileSourceRoutes.routeRevision, row.routeRevision),
                eq(customerProfileSourceRoutes.mappingRevision, row.mappingRevision),
                eq(customerProfileSourceRoutes.principalId, row.principalId),
                eq(customerProfileSourceRoutes.issuer, row.issuer),
                eq(customerProfileSourceRoutes.namespace, row.namespace),
                eq(customerProfileSourceRoutes.recordType, row.recordType),
                eq(customerProfileSourceRoutes.active, row.active),
              ),
            );
          if (stored === undefined) {
            return yield* unavailable();
          }
          return { routeId: stored.routeId };
        },
      ),
    );
  },
);
