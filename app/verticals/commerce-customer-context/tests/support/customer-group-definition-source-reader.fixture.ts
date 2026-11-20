import { makeOperationalScopeRepository } from '@app/core-runtime';
import { makeDrizzleAccessPrincipalKinds } from '@app/core-runtime/access/enforcement';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { CustomerGroupDefinitionSourceSchema } from '../../shared/domain/group-contract.ts';
import type { CustomerGroupDefinitionSource } from '../../shared/domain/group-contract.ts';
import { customerGroupDefinitionSourceRoutes } from '../../src/database/schema.ts';
import {
  CustomerContextOwnedFixtureUnavailable,
  withVerifiedCustomerContextFixture,
} from './customer-context-owned-fixture.ts';
import type { CustomerContextOwnedFixtureInput } from './customer-context-owned-fixture.ts';

const { issuer, mappingRevision, namespace, route } = CustomerGroupDefinitionSourceSchema.fields;
const AuthoritySchema = Schema.Struct({ issuer, mappingRevision, namespace, route });

export interface CustomerGroupDefinitionSourceReaderFixtureInput extends CustomerContextOwnedFixtureInput {
  readonly authority: Pick<CustomerGroupDefinitionSource, 'issuer' | 'mappingRevision' | 'namespace' | 'route'>;
  readonly readerPrincipalId: string;
}
const unavailable = () =>
  new CustomerContextOwnedFixtureUnavailable({
    reason: 'The exact active Group definition source route and Integration reader must be explicitly configured',
  });
/**
 * Names one Integration principal as a current-definition reader of one active Group definition route; it grants
 * no Core permission, no receipt recovery and no write right. The changed route is a new generation, so a route
 * decision taken against the route before this enrollment is an expectation mismatch.
 */
export const enrollCustomerGroupDefinitionSourceReaderNativeFixture = Effect.fn(
  'CustomerGroupDefinitionSourceReaderFixture.enroll',
)(function* enrollCustomerGroupDefinitionSourceReaderNativeFixture(
  input: CustomerGroupDefinitionSourceReaderFixtureInput,
) {
  const authority = yield* Schema.decodeUnknownEffect(AuthoritySchema, { onExcessProperty: 'error' })(input.authority);
  const tenantId = yield* Schema.decodeUnknownEffect(TenantIdSchema)(input.tenantId);
  const readerId = yield* Schema.decodeUnknownEffect(PrincipalIdSchema)(input.readerPrincipalId);
  return yield* withVerifiedCustomerContextFixture(input, (transaction, database, operatorScope) =>
    Effect.gen(function* enrollReader() {
      const readerScope = yield* stageScopeOf({
        legalEntityId: input.legalEntityId,
        principalId: readerId,
        tenantId: input.tenantId,
      });
      const reader = yield* makeOperationalScopeRepository({ executor: transaction }).load(readerScope);
      const kind = yield* makeDrizzleAccessPrincipalKinds({ executor: database }).readKind(
        {
          principalId: readerId,
          scope: readerScope,
          tenantId,
        },
        transaction,
      );
      yield* installOperationalScope(transaction, operatorScope);
      if (
        Option.isNone(kind) ||
        kind.value !== 'integration' ||
        reader.principalStatus !== 'active' ||
        reader.principalTenantId !== input.tenantId ||
        reader.tenantStatus !== 'active' ||
        reader.legalEntityStatus !== 'active' ||
        reader.legalEntityTenantId !== input.tenantId
      ) {
        return yield* unavailable();
      }
      const where = and(
        eq(customerGroupDefinitionSourceRoutes.tenantId, input.tenantId),
        eq(customerGroupDefinitionSourceRoutes.legalEntityId, input.legalEntityId),
        eq(customerGroupDefinitionSourceRoutes.routeId, authority.route.id),
        eq(customerGroupDefinitionSourceRoutes.routeRevision, authority.route.revision),
        eq(customerGroupDefinitionSourceRoutes.mappingRevision, authority.mappingRevision),
        eq(customerGroupDefinitionSourceRoutes.issuer, authority.issuer),
        eq(customerGroupDefinitionSourceRoutes.namespace, authority.namespace),
        eq(customerGroupDefinitionSourceRoutes.active, true),
      );
      const [stored] = yield* transaction
        .select({ readers: customerGroupDefinitionSourceRoutes.sourceReaderPrincipalIds })
        .from(customerGroupDefinitionSourceRoutes)
        .where(where)
        .for('update');
      if (stored === undefined) {
        return yield* unavailable();
      }
      if (!stored.readers.includes(readerId)) {
        if (stored.readers.length >= 32) {
          return yield* unavailable();
        }
        yield* transaction
          .update(customerGroupDefinitionSourceRoutes)
          .set({
            generation: sql`${customerGroupDefinitionSourceRoutes.generation} + 1`,
            sourceReaderPrincipalIds: [...stored.readers, readerId],
          })
          .where(where);
      }
      return { readerPrincipalId: readerId, routeId: authority.route.id, routeRevision: authority.route.revision };
    }),
  );
});
