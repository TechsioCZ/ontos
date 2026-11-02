import { ContextAccess, TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Context, DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { retailAccessDecisionRead } from '../../src/api/retail-access-decision.read.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import {
  prefetchRetailPermissions,
  ProfileRetailPermissionReaderFactory,
  profileRetailPermissionReaderFactoryLive,
} from '../../src/integrations/retail-permission-reader.ts';
import {
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RETAIL_PORTAL_PERMISSION_CATALOG,
} from '../../shared/domain/profile-contracts.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const compositionRevision = 'a'.repeat(64);
const principal = trustVerifiedGatewayPrincipalContext(
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '55555555-5555-4555-8555-555555555555',
    authContextRef: 'better-auth-session:retail-decision-permission',
    authMethod: 'session',
    legalEntityId,
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  compositionRevision,
);
const scope = { ...principal, correlationId: 'retail-decision-permission' };
const input = {
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
  requiredPermission: 'retail.consent.manage',
} as const;
const ownerFactories = Layer.mergeAll(
  partyRegistryGuestResolverFactoryLive,
  partyRegistryRetailPartyResolverFactoryLive,
  profileCounterpartyRoleEligibilityResolverFactoryLive,
  profileReactivationEligibilityEvaluatorFactoryLive.pipe(Layer.provide(profileReconfirmationPolicyUnavailableLive)),
  profileRetailPermissionReaderFactoryLive,
);

const contextPermissions: NonNullable<ContextAccessService['contextPermissions']> = ({ targets }) =>
  Effect.succeed(
    targets.map((target) => ({
      decision: 'denied' as const,
      key: `${target.moduleId}:${target.permission}`,
    })),
  );

it.layer(NodeCrypto.layer)('retail access decision runtime authorization', (suite) => {
  suite.effect('checks an explicitly requested optional permission without provisioning or widening the snapshot', () =>
    Effect.gen(function* optionalPermissionSnapshot() {
      const targets: string[] = [];
      let allowOptional = true;
      const optional = 'retail.settings.payment_term_preference.manage' as const;
      const readerScope = { legalEntityId, principalId: principal.principalId, tenantId };
      const harness = yield* makeReadTestHarness({
        businessPermissionDecision: (target) => {
          targets.push(target.permission);
          return target.permission === optional && allowOptional ? 'allowed' : 'denied';
        },
        compositionRevision,
        executeOwnerQuery: () => Effect.die('No SQL is used by this permission snapshot'),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-22T10:00:00.000Z')),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const context = yield* Layer.build(profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(harness.layer)));
      const reader = Context.get(context, ProfileRetailPermissionReaderFactory).make(readerScope);
      const prepared = yield* prefetchRetailPermissions(reader, readerScope, [profileId], [optional]);
      const snapshot = yield* prepared({ ...readerScope, profileId, requestedPermissions: [optional] });
      expect(snapshot.permissions).toEqual([optional]);
      expect(targets).toContain(optional);
      expect(RETAIL_PORTAL_SELF_SERVICE_BASELINE).not.toContain(optional);
      expect(RETAIL_PORTAL_PERMISSION_CATALOG.find(({ code }) => code === optional)?.launchBaseline).toBe(false);
      const firstCallCount = targets.length;
      yield* reader({ ...readerScope, profileId });
      expect(targets.slice(firstCallCount)).not.toContain(optional);
      allowOptional = false;
      const denied = yield* prefetchRetailPermissions(reader, readerScope, [profileId], [optional]);
      expect((yield* denied({ ...readerScope, profileId, requestedPermissions: [optional] })).permissions).toEqual([]);
      const unchecked = yield* Effect.flip(
        prepared({ ...readerScope, profileId, requestedPermissions: ['retail.notifications.manage'] }),
      );
      expect(unchecked.reason).toContain('snapshot was not read');
      const foreign = yield* Effect.flip(
        prepared({ ...readerScope, profileId: 'foreign-profile', requestedPermissions: [optional] }),
      );
      expect(foreign.reason).toContain('snapshot was not read');
    }),
  );
  for (const contextMode of ['absent', 'denied'] as const) {
    suite.effect(
      `exact business permission reaches the original owner when unrelated context permission is ${contextMode}`,
      () =>
        Effect.gen(function* exactPermissionAdmitted() {
          const businessTargets: string[] = [];
          const harness = yield* makeReadTestHarness({
            businessPermissionDecision: (target) => {
              businessTargets.push(target.permission);
              expect(target.target).toEqual({ kind: 'retail_profile', legalEntityId, profileId, tenantId });
              return target.permission === input.requiredPermission ? 'allowed' : 'denied';
            },
            compositionRevision,
            executeOwnerQuery: (query) => {
              expect(query.sql).toContain('resolve_retail_principal');
              expect(query.scope).toEqual({ legalEntityId, tenantId });
              expect(query.params).toEqual([tenantId, legalEntityId, profileId, principal.principalId]);
              return Effect.succeed([{ outcome: 'PROFILE_NOT_FOUND', payload: null }]);
            },
            operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-22T10:00:00.000Z')),
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
          });
          const contextAccess = Context.get(yield* Layer.build(harness.layer), ContextAccess);
          if (contextMode === 'denied') {
            Object.assign(contextAccess, { contextPermissions });
          }
          const failure = yield* Effect.flip(
            harness.runtime
              .runRead({
                input,
                principal,
                registration: retailAccessDecisionRead,
                transport: { correlationId: scope.correlationId },
              })
              .pipe(Effect.provide(ownerFactories.pipe(Layer.provide(harness.layer)))),
          );
          expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
          // The Read prefetches the Retail baseline before its transaction; every other permission is denied
          // here, so reaching the owner proves admission depends only on the exact required permission.
          expect(businessTargets).toContain('retail.consent.manage');
          expect(harness.snapshot().ownerQueries).toHaveLength(1);
        }),
    );
  }
  for (const deniedTarget of ['business', 'module', 'foreign-profile', 'foreign-tenant'] as const) {
    suite.effect(`${deniedTarget} is denied before owner SQL`, () =>
      Effect.gen(function* deniedAuthority() {
        const harness = yield* makeReadTestHarness({
          businessPermissionDecision: (target) =>
            target.target.kind === 'retail_profile' &&
            target.target.profileId === profileId &&
            target.target.tenantId === tenantId &&
            deniedTarget !== 'business'
              ? 'allowed'
              : 'denied',
          compositionRevision,
          executeOwnerQuery: () => Effect.die('Denied authority must not reach owner SQL'),
          operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-22T10:00:00.000Z')),
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const contextAccess = Context.get(yield* Layer.build(harness.layer), ContextAccess);
        const modules: ContextAccessService['modules'] = ({ moduleIds }) =>
          Effect.succeed(
            moduleIds.map((key) => ({
              decision: deniedTarget === 'module' ? ('denied' as const) : ('allowed' as const),
              key,
            })),
          );
        Object.assign(contextAccess, { modules });
        const requested = {
          ...input,
          profileRef: {
            ...input.profileRef,
            resourceId: deniedTarget === 'foreign-profile' ? '77777777-7777-4777-8777-777777777777' : profileId,
            tenantId: deniedTarget === 'foreign-tenant' ? '88888888-8888-4888-8888-888888888888' : tenantId,
          },
        };
        const failure = yield* Effect.flip(
          harness.runtime
            .runRead({
              input: requested,
              principal,
              registration: retailAccessDecisionRead,
              transport: { correlationId: scope.correlationId },
            })
            .pipe(Effect.provide(ownerFactories.pipe(Layer.provide(harness.layer)))),
        );
        expect(
          Predicate.isTagged(
            failure,
            deniedTarget === 'foreign-tenant' ? 'ReadPermissionUnavailable' : 'ReadPermissionDenied',
          ),
        ).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    );
  }
});
