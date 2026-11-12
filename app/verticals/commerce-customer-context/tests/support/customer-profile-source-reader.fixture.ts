import { makeOperationalScopeRepository } from '@app/core-runtime';
import { makeDrizzleAccessPrincipalKinds } from '@app/core-runtime/access/enforcement';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { CustomerProfileSourceAuthoritySchema } from '../../shared/domain/customer-profile-source.ts';
import type { CustomerProfileSourceAuthoritySchema as Authority } from '../../shared/domain/customer-profile-source.ts';
import { customerProfileSourceRoutes } from '../../src/database/schema.ts';
import {
  CustomerContextOwnedFixtureUnavailable,
  withVerifiedCustomerContextFixture,
} from './customer-context-owned-fixture.ts';
import type { CustomerContextOwnedFixtureInput } from './customer-context-owned-fixture.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

export interface CustomerProfileSourceReaderFixtureInput extends CustomerContextOwnedFixtureInput {
  readonly authority: typeof Authority.Type;
  readonly readerPrincipalId: string;
}
const unavailable = () =>
  new CustomerContextOwnedFixtureUnavailable({
    reason: 'The exact active source route and Integration reader must be explicitly configured',
  });
/** Configures one qualified-source recipient; it grants no Core permission, Privacy or write right. */
export const enrollCustomerProfileSourceReaderNativeFixture = Effect.fn('CustomerProfileSourceReaderFixture.enroll')(
  function* enrollCustomerProfileSourceReaderNativeFixture(input: CustomerProfileSourceReaderFixtureInput) {
    const authority = yield* Schema.decodeUnknownEffect(CustomerProfileSourceAuthoritySchema, {
      onExcessProperty: 'error',
    })(input.authority);
    const tenantId = yield* Schema.decodeUnknownEffect(TenantIdSchema)(input.tenantId);
    const readerId = yield* Schema.decodeUnknownEffect(PrincipalIdSchema)(input.readerPrincipalId);
    return yield* withVerifiedCustomerContextFixture(input, (transaction, database, operatorScope) =>
      Effect.gen(function* enrollReader() {
        const readerScope = yield* stageScopeOf({
          legalEntityId: input.legalEntityId,
          principalId: readerId,
          tenantId: input.tenantId,
        });
        const reader = yield* makeOperationalScopeRepository(
          { executor: transaction },
          FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
        ).load(readerScope);
        const kind = yield* makeDrizzleAccessPrincipalKinds({
          enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          executor: database,
        }).readKind(
          {
            principalId: readerId,
            scope: readerScope,
            tenantId,
          },
          transaction,
        );
        yield* installOperationalScope(transaction, operatorScope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
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
          eq(customerProfileSourceRoutes.tenantId, input.tenantId),
          eq(customerProfileSourceRoutes.legalEntityId, input.legalEntityId),
          eq(customerProfileSourceRoutes.routeId, authority.route.id),
          eq(customerProfileSourceRoutes.routeRevision, authority.route.revision),
          eq(customerProfileSourceRoutes.mappingRevision, authority.mappingRevision),
          eq(customerProfileSourceRoutes.issuer, authority.issuer),
          eq(customerProfileSourceRoutes.namespace, authority.namespace),
          eq(customerProfileSourceRoutes.recordType, authority.recordType),
          eq(customerProfileSourceRoutes.active, true),
        );
        const [route] = yield* transaction
          .select({ readers: customerProfileSourceRoutes.sourceReaderPrincipalIds })
          .from(customerProfileSourceRoutes)
          .where(where)
          .for('update');
        if (route === undefined) {
          return yield* unavailable();
        }
        if (!route.readers.includes(readerId)) {
          if (route.readers.length >= 32) {
            return yield* unavailable();
          }
          yield* transaction
            .update(customerProfileSourceRoutes)
            .set({ sourceReaderPrincipalIds: [...route.readers, readerId] })
            .where(where);
        }
        return { readerPrincipalId: readerId, routeId: authority.route.id, routeRevision: authority.route.revision };
      }),
    );
  },
);
