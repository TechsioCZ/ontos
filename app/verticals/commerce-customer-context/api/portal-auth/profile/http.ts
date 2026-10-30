import { ContextAccess, ModuleEntrypointGateway, toContextPermissionAccessKey } from '@app/core-runtime';
import type { ModuleEntrypointDescriptor, TrustedPrincipalContext } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { Crypto, DateTime, Effect } from 'effect';
import { Hex } from 'effect/encoding';
import type { HttpServerRequest } from 'effect/http';
import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { CustomerOwnProfileSchemaError } from '../../../shared/portal-auth/profile-api.ts';
import type { UpdateCustomerOwnProfile } from '../../../shared/portal-auth/profile-api.ts';
import {
  customerProfileReadOwnEntrypoint,
  customerProfileUpdateOwnEntrypoint,
} from '../../../shared/portal-auth/profile-entrypoints.ts';
import { CommercePortalAuthAudit } from '../../../src/portal-auth/audit/audit.ts';
import { noStoreHeaders, requireTrustedOrigin } from '../http-transport.ts';
import { admitCustomerAccount } from '../session/http.ts';
import { readCustomerPartyProfile, updateCustomerPartyProfile } from './party-profile.ts';
import {
  profileAuthentication,
  profileConflict,
  profileForbidden,
  profileInvalid,
  profileUnavailable,
} from './problems.ts';

export const authorizeCustomerProfile = Effect.fn('CustomerOwnProfile.authorize')(function* authorize(
  principal: Readonly<TrustedPrincipalContext>,
  entrypoint: ModuleEntrypointDescriptor,
) {
  if (entrypoint.authorization.kind !== 'context_permission' || principal.legalEntityId === undefined) {
    return yield* Effect.fail(profileForbidden());
  }
  const gateway = yield* ModuleEntrypointGateway;
  const snapshot = yield* gateway.prepareSnapshot(principal, [entrypoint]).pipe(Effect.mapError(profileUnavailable));
  yield* gateway.check(snapshot, entrypoint).pipe(Effect.mapError(profileForbidden));
  const access = yield* ContextAccess;
  if (access.contextPermissions === undefined) {
    return yield* Effect.fail(profileUnavailable());
  }
  const target = { moduleId: entrypoint.moduleKey, permission: entrypoint.authorization.permission };
  const decisions = yield* access.contextPermissions({
    legalEntityId: principal.legalEntityId,
    principalId: principal.principalId,
    targets: [target],
    tenantId: principal.tenantId,
  });
  const decision = decisions.find((item) => item.key === toContextPermissionAccessKey(target));
  if (decision?.decision === 'unavailable' || decision === undefined) {
    return yield* Effect.fail(profileUnavailable());
  }
  if (decision.decision !== 'allowed') {
    return yield* Effect.fail(profileForbidden());
  }
  return yield* Effect.void;
});

const admittedScope = Effect.fn('CustomerOwnProfile.admit')(function* admit(
  request: HttpServerRequest.HttpServerRequest,
  entrypoint: ModuleEntrypointDescriptor,
) {
  yield* noStoreHeaders;
  const current = yield* admitCustomerAccount(request).pipe(
    Effect.mapError((problem) => {
      if (problem.status === 401) {
        return profileAuthentication();
      }
      if (problem.status === 403) {
        return profileForbidden();
      }
      return profileUnavailable();
    }),
  );
  if (current.state !== 'authenticated') {
    return yield* Effect.fail(profileAuthentication());
  }
  yield* authorizeCustomerProfile(current.workloadPrincipal, entrypoint);
  if (current.workloadPrincipal.legalEntityId === undefined) {
    return yield* Effect.fail(profileForbidden());
  }
  const compositions = yield* ActiveApplicationCompositionService;
  const active = yield* compositions.load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(profileUnavailable),
  );
  const crypto = yield* Crypto.Crypto;
  return {
    current,
    scope: {
      compositionRevision: active.composition.revision,
      legalEntityId: current.workloadPrincipal.legalEntityId,
      partyId: current.account.partyId,
      requestCorrelation: yield* crypto.randomUUIDv4().pipe(Effect.mapError(profileUnavailable)),
      tenantId: current.workloadPrincipal.tenantId,
    },
  };
});

const read = Effect.fn('CustomerOwnProfile.read')(function* readProfile(request: HttpServerRequest.HttpServerRequest) {
  const { scope } = yield* admittedScope(request, customerProfileReadOwnEntrypoint);
  return (yield* readCustomerPartyProfile(scope)).profile;
});
const update = Effect.fn('CustomerOwnProfile.update')(function* updateProfile(
  request: HttpServerRequest.HttpServerRequest,
  input: UpdateCustomerOwnProfile,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, profileForbidden);
  const { current, scope } = yield* admittedScope(request, customerProfileUpdateOwnEntrypoint);
  const before = yield* readCustomerPartyProfile(scope);
  if (before.profile.version !== input.version) {
    return yield* Effect.fail(profileConflict());
  }
  const audit = yield* CommercePortalAuthAudit;
  const crypto = yield* Crypto.Crypto;
  const correlationDigest = yield* crypto
    .digest('SHA-256', new TextEncoder().encode(scope.requestCorrelation))
    .pipe(Effect.map(Hex.encode), Effect.mapError(profileUnavailable));
  const event = {
    correlationDigest,
    operation: 'customer-profile-update',
    providerSubjectId: current.session.providerSubjectId,
    sessionRef: current.session.sessionRef,
  };
  // A durable intent is mandatory before the first native command. No network call holds an owner DB transaction.
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.profile-update-requested.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'requested',
    })
    .pipe(Effect.mapError(profileUnavailable));
  const profile = yield* updateCustomerPartyProfile(scope, input, before).pipe(
    Effect.tapError(
      Effect.fn('CustomerOwnProfile.recordFailure')(function* recordFailure(failure) {
        yield* audit
          .record({
            ...event,
            eventType: 'commerce.portal-auth.profile-update-failed.v1',
            occurredAt: yield* DateTime.nowAsDate,
            outcome: failure.status === 409 ? 'state_conflict' : 'unavailable',
          })
          .pipe(Effect.mapError(profileUnavailable));
      }),
    ),
  );
  // Completion follows native persistence and a fresh owner read; failure here is never reported as success.
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.profile-updated.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'success',
    })
    .pipe(Effect.mapError(profileUnavailable));
  return profile;
});

const schemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CustomerOwnProfileSchemaError, () =>
  Effect.fail(profileInvalid()),
);
export const customerOwnProfileReadApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnProfileRead',
  (handlers) => handlers.handle('execute', ({ request }) => read(request)),
).pipe(Layer.provide(schemaErrorLive));
export const customerOwnProfileUpdateApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnProfileUpdate',
  (handlers) => handlers.handle('execute', ({ payload, request }) => update(request, payload)),
).pipe(Layer.provide(schemaErrorLive));
