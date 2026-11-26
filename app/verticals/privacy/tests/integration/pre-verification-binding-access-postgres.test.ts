import {
  loadDatabaseConnectionPair,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  AccessDecisionGate,
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import { makeTestTenantRoleAccess } from '../../../../packages/core-runtime/src/testing/tenant-access-roles.ts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Context, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { describe, expect, it } from 'effect-rstest';

import { withdrawPreVerificationBindingAction } from '../../src/actions/withdraw-pre-verification-binding.action.ts';

/*
 * #1406 D.8 (review P4): who may withdraw a pre-verification binding. The withdraw Action declares no `accessActor`, so it
 * is a Privacy operator's own, rights-based Action: Core's access gate admits a human principal only through a grant of
 * its declaration `privacy.core.pre-verification-binding.withdraw` in the principal's own Tenant.
 *
 * What is REAL: Core's production access gate (`AccessDecisionLive` over Core's access intent on native PostgreSQL and the
 * SpiceDB engine of the test environment), the fixture principals and their role grants written by Core's own bootstrap,
 * and the Action's own declared carrier. What is NOT run: the HTTP gateway and Privacy's API runtime (the owner body after
 * admission is proven by `pre-verification-binding-postgres.test.ts`).
 */

const WITHDRAW = 'privacy.core.pre-verification-binding.withdraw';
const COMPOSITION_REVISION = 'f'.repeat(64);

interface FixturePrincipal {
  readonly authBindingId: string;
  readonly authContextRef: string;
  readonly authMethod: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Reactivity.layer);

/** The trusted staff scope of one principal acting in one Tenant (a Tenant-wide operation, as the Action allows). */
const scopeOf = (principal: FixturePrincipal, tenantId = principal.tenantId): OperationalScope => {
  const trusted = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: principal.authBindingId,
    authContextRef: principal.authContextRef,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: principal.authMethod,
    principalId: principal.principalId,
    tenantId,
  });
  return trustVerifiedGatewayPrincipalContext(
    { ...trusted, correlationId: 'privacy-withdraw-access' },
    COMPOSITION_REVISION,
  );
};

describe('Who may withdraw a pre-verification binding (#1406 D.8, P4)', () => {
  it.live(
    'a Privacy operator holding the withdraw grant is admitted; a member without it, another Tenant and a revoked grant are not',
    () =>
      Effect.scoped(
        Effect.gen(function* withdrawAccess() {
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const fixtureOf = Effect.fnUntraced(function* fixtureOf() {
            const fixture = yield* makeLiveOperationFixture({
              access: 'allowed',
              authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
              compositionRevision: COMPOSITION_REVISION,
              moduleKeys: ['privacy.core'],
              runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
            });
            yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
            return fixture;
          });
          const tenant = yield* fixtureOf();
          const foreign = yield* fixtureOf();
          const target = yield* environmentTestAccessTarget;
          // the operator holds the withdraw declaration in its own Tenant; the reader holds an unrelated capability only;
          // the foreign operator holds it in the foreign Tenant only
          yield* grantTestTenantRoleAccess({
            ...target,
            holders: [
              { capabilityKeys: [WITHDRAW], principalId: tenant.manager.principalId },
              { capabilityKeys: ['party.registry.party.read'], principalId: tenant.reader.principalId },
            ],
            legalEntityIds: [tenant.legalEntityId],
            tenantId: tenant.tenantId,
          });
          yield* grantTestTenantRoleAccess({
            ...target,
            holders: [{ capabilityKeys: [WITHDRAW], principalId: foreign.manager.principalId }],
            legalEntityIds: [foreign.legalEntityId],
            tenantId: foreign.tenantId,
          });
          const runtime = yield* makeCoreDatabase(connections.runtime);
          const gate = Context.get(
            yield* Layer.build(
              AccessDecisionLive.pipe(
                Layer.provide(AccessEnforcementPortsLive),
                Layer.provide(TenantIntentLoaderLive),
                Layer.provide(Layer.succeed(CoreDatabase, runtime)),
              ),
            ),
            AccessDecisionGate,
          );
          const decide = Effect.fnUntraced(function* decide(scope: OperationalScope) {
            return yield* gate.decide({
              carrier: withdrawPreVerificationBindingAction.descriptor,
              legalEntityScope: withdrawPreVerificationBindingAction.descriptor.legalEntityScope,
              now: yield* DateTime.nowAsDate,
              scope,
            });
          });

          const reasonsOf = (decision: Effect.Success<ReturnType<typeof decide>>) =>
            decision.reasons.map(({ code }) => code);
          // ALLOWED: the Privacy operator of this Tenant, through its grant
          const operator = yield* decide(scopeOf(tenant.manager));
          expect(operator.outcome).toBe('ALLOWED');
          expect(reasonsOf(operator)).toEqual(['allow.granted']);
          // DENIED: a member of the Tenant without the withdraw grant
          const member = yield* decide(scopeOf(tenant.reader));
          expect(member.outcome).toBe('DENIED');
          expect(reasonsOf(member)).toEqual(['deny.insufficient_grant']);
          // CROSS-TENANT: the foreign operator is no principal of this Tenant, so its own grant never reaches it
          const crossed = yield* decide(scopeOf(foreign.manager, tenant.tenantId));
          expect(crossed.outcome).toBe('DENIED');
          expect(reasonsOf(crossed)).toEqual(['deny.principal_kind_forbidden']);
          // the foreign operator is admitted in its own Tenant only
          expect((yield* decide(scopeOf(foreign.manager))).outcome).toBe('ALLOWED');
          // GRANTED THEN REVOKED: a role of exactly the withdraw declaration admits the member, its revocation refuses it
          const roles = yield* makeTestTenantRoleAccess({
            ...target,
            legalEntityIds: [tenant.legalEntityId],
            principalId: tenant.reader.principalId,
            tenantId: tenant.tenantId,
          });
          const withdrawRole = yield* roles.capabilityRole([WITHDRAW]);
          yield* withdrawRole.grant();
          expect((yield* decide(scopeOf(tenant.reader))).outcome).toBe('ALLOWED');
          yield* withdrawRole.revoke();
          const revoked = yield* decide(scopeOf(tenant.reader));
          expect(revoked.outcome).toBe('DENIED');
          expect(reasonsOf(revoked)).toEqual(['deny.insufficient_grant']);
        }),
      ).pipe(Effect.provide(services)),
    180_000,
  );
});
