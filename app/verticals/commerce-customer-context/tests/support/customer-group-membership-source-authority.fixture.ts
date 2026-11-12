import {
  makeOperationalScopeRepository,
  makeSystemPrincipalContextResolver,
  registerSystemWorkload,
} from '@app/core-runtime';
import { TenantIdSchema, LegalEntityIdSchema, PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { and, eq } from 'drizzle-orm';
import { Effect, Redacted, Schema } from 'effect';
import { MembershipSnapshotCompletenessContractSchema } from '../../shared/domain/customer-group-membership-snapshot.ts';
import {
  MembershipSourceManagerSchema,
  MembershipSourceRouteSchema,
} from '../../shared/domain/customer-group-membership-source.ts';
import { customerGroupMembershipSourceRoutes } from '../../src/database/schema.ts';
import { withVerifiedCustomerContextFixture } from './customer-context-owned-fixture.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

export const CustomerGroupMembershipSourceAuthorityFixtureRouteSchema = Schema.Struct({
  active: Schema.Boolean,
  allowComplete: Schema.Boolean,
  completenessContract: Schema.toEncoded(Schema.OptionFromNullOr(MembershipSnapshotCompletenessContractSchema)),
  issuer: MembershipSourceManagerSchema.fields.issuer,
  legalEntityId: Schema.toEncoded(LegalEntityIdSchema),
  principalId: Schema.toEncoded(PrincipalIdSchema),
  routeId: MembershipSourceRouteSchema.fields.id,
  routeRevision: MembershipSourceRouteSchema.fields.revision,
  sourceNamespace: MembershipSourceManagerSchema.fields.sourceNamespace,
  tenantId: Schema.toEncoded(TenantIdSchema),
}).check(
  Schema.makeFilter((route) =>
    !route.allowComplete || route.completenessContract !== null
      ? undefined
      : 'Complete source authority requires an explicit exact completeness contract',
  ),
);
export type CustomerGroupMembershipSourceAuthorityFixtureRoute =
  typeof CustomerGroupMembershipSourceAuthorityFixtureRouteSchema.Type;
export interface CustomerGroupMembershipSourceAuthorityFixtureInput {
  readonly adminConnectionString: Redacted.Redacted;
  readonly fixture: OwnedNativeDatabaseFixture;
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly route: CustomerGroupMembershipSourceAuthorityFixtureRoute;
}
export class CustomerGroupMembershipSourceAuthorityFixtureUnavailable extends Schema.TaggedError<CustomerGroupMembershipSourceAuthorityFixtureUnavailable>()(
  'CustomerGroupMembershipSourceAuthorityFixtureUnavailable',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new CustomerGroupMembershipSourceAuthorityFixtureUnavailable({
    cause: Redacted.make(cause),
    reason: 'The owned Membership source authority fixture, human operator and enrolled system writer are required',
  });
const sourceWriter = registerSystemWorkload({ jobKey: 'commerce.customer-context.source-write' });
const sameRoute = Schema.toEquivalence(CustomerGroupMembershipSourceAuthorityFixtureRouteSchema);

/** Configures one explicit route only. It never seeds Memberships, completeness proofs or grants. */
export const seedCustomerGroupMembershipSourceAuthority = Effect.fn('MembershipSourceAuthorityFixture.seed')(
  function* seedMembershipSourceAuthority(input: CustomerGroupMembershipSourceAuthorityFixtureInput) {
    const route = yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceAuthorityFixtureRouteSchema, {
      onExcessProperty: 'error',
    })(input.route).pipe(Effect.mapError(unavailable));
    return yield* withVerifiedCustomerContextFixture(
      {
        adminConnectionString: input.adminConnectionString,
        legalEntityId: route.legalEntityId,
        operatorPrincipalId: input.operatorPrincipalId,
        operatorProviderUserId: input.operatorProviderUserId,
        ownedDatabase: input.fixture,
        tenantId: route.tenantId,
      },
      Effect.fn('MembershipSourceAuthorityFixture.store')(function* store(transaction, database, operatorScope) {
        const enrolled = yield* makeSystemPrincipalContextResolver({ executor: database }).resolveEnrolled({
          registration: sourceWriter,
          runReference: 'membership-source-authority-fixture',
          tenantId: route.tenantId,
        });
        if (enrolled.principalId !== route.principalId || enrolled.tenantId !== route.tenantId) {
          return yield* unavailable();
        }
        const target = yield* stageScopeOf({
          legalEntityId: route.legalEntityId,
          principalId: route.principalId,
          tenantId: route.tenantId,
        });
        const state = yield* makeOperationalScopeRepository(
          { executor: transaction },
          FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
        ).load(target);
        if (
          state.tenantStatus !== 'active' ||
          state.principalStatus !== 'active' ||
          state.principalTenantId !== route.tenantId ||
          state.legalEntityStatus !== 'active' ||
          state.legalEntityTenantId !== route.tenantId
        ) {
          return yield* unavailable();
        }
        yield* installOperationalScope(transaction, operatorScope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
        yield* transaction
          .insert(customerGroupMembershipSourceRoutes)
          .values({
            active: route.active,
            allowComplete: route.allowComplete,
            completenessContractCoverage: route.completenessContract?.coverage ?? null,
            completenessContractRef: route.completenessContract?.ref ?? null,
            completenessContractRevision: route.completenessContract?.revision ?? null,
            issuer: route.issuer,
            legalEntityId: route.legalEntityId,
            principalId: route.principalId,
            routeId: route.routeId,
            routeRevision: route.routeRevision,
            sourceNamespace: route.sourceNamespace,
            tenantId: route.tenantId,
          })
          .onConflictDoNothing();
        const [stored] = yield* transaction
          .select()
          .from(customerGroupMembershipSourceRoutes)
          .where(
            and(
              eq(customerGroupMembershipSourceRoutes.tenantId, route.tenantId),
              eq(customerGroupMembershipSourceRoutes.legalEntityId, route.legalEntityId),
              eq(customerGroupMembershipSourceRoutes.routeId, route.routeId),
            ),
          );
        if (stored === undefined) {
          return yield* unavailable();
        }
        const actual = yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceAuthorityFixtureRouteSchema)({
          active: stored.active,
          allowComplete: stored.allowComplete,
          completenessContract:
            stored.completenessContractRef === null &&
            stored.completenessContractRevision === null &&
            stored.completenessContractCoverage === null
              ? null
              : {
                  coverage: stored.completenessContractCoverage,
                  ref: stored.completenessContractRef,
                  revision: stored.completenessContractRevision,
                },
          issuer: stored.issuer,
          legalEntityId: stored.legalEntityId,
          principalId: stored.principalId,
          routeId: stored.routeId,
          routeRevision: stored.routeRevision,
          sourceNamespace: stored.sourceNamespace,
          tenantId: stored.tenantId,
        });
        if (!sameRoute(actual, route)) {
          return yield* unavailable();
        }
        return yield* Effect.void;
      }),
    ).pipe(Effect.mapError(unavailable));
  },
);
