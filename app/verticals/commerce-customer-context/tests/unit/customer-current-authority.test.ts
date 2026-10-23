import { ContextAccess, toBusinessPermissionAccessKey } from '@app/core-runtime';
import type { ContextAccessResult } from '@app/core-runtime';
import { ResolveExternalSubjectResultSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { ExternalIdentityForbiddenProblemSchema } from '@app/shared-contracts/external-identity';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import type {
  ExternalIdentityClientPort,
  ResolveExternalSubjectRequest,
} from '@app/shared-contracts/server/external-identity-client';
import { Effect, Layer, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import {
  CommerceCustomerAuthority,
  commerceCustomerAuthorityLive,
  CustomerAuthorityRejected,
  CustomerAuthorityUnavailable,
} from '../../api/portal-auth/session/customer-authority.ts';
import type { CustomerAuthorityInput } from '../../api/portal-auth/session/customer-authority.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type { EnrollmentAttemptScopedRoutineInvoker } from '../../src/enrollment/attempts/attempt-persistence.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const authBindingId = '40000000-0000-4000-8000-000000000001';
const partyId = '50000000-0000-4000-8000-000000000001';
const profileId = '60000000-0000-4000-8000-000000000001';
const otherId = '70000000-0000-4000-8000-000000000001';
const input: CustomerAuthorityInput = {
  legalEntityId,
  permission: 'retail.profile.read',
  providerSubjectId: 'provider-owned-subject',
  sessionRef: `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:native-session`,
  tenantId,
};
const unused = () => Effect.die('Unexpected mutation or unrelated identity lookup');

interface CustomerAuthorityOwnerState {
  coreDenied: boolean;
  identity: typeof ResolveExternalSubjectResultSchema.Type;
  permission: ContextAccessResult['decision'];
  permissionResponse: 'duplicate' | 'exact' | 'missing' | 'wrong-key';
  retained: boolean;
}

const harness = Effect.fnUntraced(function* authorityHarness() {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture();
  const state: CustomerAuthorityOwnerState = {
    coreDenied: false,
    identity: Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({
      authBindingId,
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      bindingRevision: 2,
      bindingStatus: 'active',
      outcome: 'RESOLVED',
      principalId,
      tenantId,
    }),
    permission: 'allowed',
    permissionResponse: 'exact',
    retained: true,
  };
  const requests: ResolveExternalSubjectRequest[] = [];
  const observedReads: unknown[][] = [];
  const permissionPrincipals: string[] = [];
  const permissionTargets: string[] = [];
  const client: ExternalIdentityClientPort = {
    activatePrincipalBinding: unused,
    changePrincipalBindingStatus: unused,
    issueExternalGatewayContext: unused,
    readPrincipalBinding: unused,
    reservePrincipalBinding: unused,
    resolveExternalSubject: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        return state.coreDenied
          ? Effect.fail(
              Schema.decodeUnknownSync(ExternalIdentityForbiddenProblemSchema)({
                _tag: 'ExternalIdentityForbiddenProblem',
                detail: 'Current customer identity admission refused',
                status: 403,
                title: 'Forbidden',
                type: 'https://ontos.dev/problems/external-identity-forbidden',
              }),
            )
          : Effect.succeed(state.identity);
      }),
  };
  const invoke: EnrollmentAttemptScopedRoutineInvoker['invoke'] = (routine, values) =>
    Effect.sync(() => {
      expect(routine.name).toBe('read_retail_enrollment_account_party');
      observedReads.push([...values]);
      const exact =
        values.at(0) === input.providerSubjectId && values.at(1) === principalId && values.at(2) === authBindingId;
      return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(
        state.retained && exact ? [{ party_id: partyId, profile_id: profileId }] : [],
      );
    });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ExternalIdentityClient, client),
    Layer.succeed(CommerceCoreIdentityClientConfig, {
      apiKey: Redacted.make('test-only-workload-credential'),
      baseUrl: 'https://core.example.test',
    }),
    Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
    Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, {
      run: (scope, operation) => {
        expect(scope.tenantId).toBe(tenantId);
        expect(scope.legalEntityId).toBe(legalEntityId);
        return operation({ invoke });
      },
      runWorker: unused,
    }),
    Layer.succeed(ContextAccess, {
      businessPermissions: ({ principal, targets }) =>
        Effect.sync(() => {
          permissionPrincipals.push(principal.principalId);
          permissionTargets.push(...targets.map(toBusinessPermissionAccessKey));
          const decisions = targets.map((target) => ({
            decision: state.permission,
            key: toBusinessPermissionAccessKey(target),
          }));
          if (state.permissionResponse === 'missing') {
            return [];
          }
          if (state.permissionResponse === 'duplicate') {
            return [...decisions, ...decisions];
          }
          if (state.permissionResponse === 'wrong-key') {
            return decisions.map((decision) => ({ ...decision, key: 'wrong-customer-profile' }));
          }
          return decisions;
        }),
      legalEntities: unused,
      modules: unused,
      resources: unused,
      tenants: unused,
    }),
  );
  return {
    layer: commerceCustomerAuthorityLive.pipe(Layer.provide(dependencies)),
    observedReads,
    permissionPrincipals,
    permissionTargets,
    requests,
    snapshot,
    state,
  };
});

it.effect('re-admits the exact live provider session and checks the customer, never the service actor', () =>
  Effect.gen(function* exactSubject() {
    const h = yield* harness();
    yield* Effect.gen(function* checks() {
      const authority = yield* CommerceCustomerAuthority;
      expect(yield* authority.admit(input)).toEqual({ authBindingId, partyId, principalId, profileId });
      expect(h.requests).toEqual([
        {
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          authenticationRef: input.sessionRef,
          compositionRevision: h.snapshot.composition.revision,
          providerSubjectId: input.providerSubjectId,
          subjectType: 'user',
        },
      ]);
      expect(h.observedReads).toEqual([[input.providerSubjectId, principalId, authBindingId]]);
      expect(h.permissionPrincipals).toEqual([principalId]);
      expect(h.permissionTargets[0]).toContain(profileId);
    }).pipe(Effect.provide(h.layer));
  }),
);

for (const reason of ['binding-revoked', 'principal-disabled'] as const) {
  it.effect(`refuses ${reason} on the next call even while the provider session remains live`, () =>
    Effect.gen(function* coreRevocation() {
      const h = yield* harness();
      yield* Effect.gen(function* calls() {
        const authority = yield* CommerceCustomerAuthority;
        yield* authority.admit(input);
        h.state.coreDenied = true;
        const refused = yield* authority.admit(input).pipe(Effect.result);
        expect(Result.isFailure(refused) && Schema.is(CustomerAuthorityRejected)(refused.failure)).toBe(true);
        expect(h.requests).toHaveLength(2);
        expect(h.observedReads).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    }),
  );
}

for (const permission of ['retail.profile.read', 'retail.consent.manage'] as const) {
  it.effect(`rechecks removed ${permission} permission for account/profile or consent/callback admission`, () =>
    Effect.gen(function* removedPermission() {
      const h = yield* harness();
      yield* Effect.gen(function* calls() {
        const authority = yield* CommerceCustomerAuthority;
        yield* authority.admit({ ...input, permission });
        h.state.permission = 'denied';
        const refused = yield* authority.admit({ ...input, permission }).pipe(Effect.result);
        expect(Result.isFailure(refused) && Schema.is(CustomerAuthorityRejected)(refused.failure)).toBe(true);
        expect(h.requests).toHaveLength(2);
        expect(h.permissionPrincipals).toEqual([principalId, principalId]);
      }).pipe(Effect.provide(h.layer));
    }),
  );
}

for (const change of ['principal', 'binding', 'tenant', 'retained'] as const) {
  it.effect(`rejects a mismatched ${change} rather than following provider/email continuity`, () =>
    Effect.gen(function* retainedIdentity() {
      const h = yield* harness();
      if (change === 'principal') {
        h.state.identity = {
          ...h.state.identity,
          principalId: Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({
            ...h.state.identity,
            principalId: otherId,
          }).principalId,
        };
      }
      if (change === 'binding') {
        h.state.identity = {
          ...h.state.identity,
          authBindingId: Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({
            ...h.state.identity,
            authBindingId: otherId,
          }).authBindingId,
        };
      }
      if (change === 'tenant') {
        h.state.identity = {
          ...h.state.identity,
          tenantId: Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({
            ...h.state.identity,
            tenantId: otherId,
          }).tenantId,
        };
      }
      if (change === 'retained') {
        h.state.retained = false;
      }
      const refused = yield* CommerceCustomerAuthority.pipe(
        Effect.flatMap((authority) => authority.admit(input)),
        Effect.result,
        Effect.provide(h.layer),
      );
      expect(Result.isFailure(refused) && Schema.is(CustomerAuthorityRejected)(refused.failure)).toBe(true);
      expect(h.permissionPrincipals).toEqual([]);
    }),
  );
}

for (const response of ['duplicate', 'missing', 'wrong-key'] as const) {
  it.effect(`fails closed on ${response} current permission results`, () =>
    Effect.gen(function* malformedPermissions() {
      const h = yield* harness();
      h.state.permissionResponse = response;
      const refused = yield* CommerceCustomerAuthority.pipe(
        Effect.flatMap((authority) => authority.admit(input)),
        Effect.result,
        Effect.provide(h.layer),
      );
      expect(Result.isFailure(refused) && Schema.is(CustomerAuthorityUnavailable)(refused.failure)).toBe(true);
    }),
  );
}
