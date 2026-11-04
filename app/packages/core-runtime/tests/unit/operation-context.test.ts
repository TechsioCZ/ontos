import { NodeCrypto } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { DateTime, Deferred, Duration, Effect, Exit, Fiber, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { supportRecoveryPrincipalContextResolverFromRepository } from '../../src/auth/support-recovery-principal-context.ts';
import {
  decodeTrustedPrincipalContext,
  isVerifiedGatewayPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
  readVerifiedGatewayCompositionRevision,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import {
  registerSystemWorkload,
  systemPrincipalContextResolverFromRepository,
} from '../../src/auth/system-principal-context.ts';
import { recordSupportImpersonationAction } from '../../src/modules/actions/record-support-impersonation.action.ts';
import { makeOperationalScopeResolver } from '../../src/operations/context.ts';
import { makeContextAccess, withRequestPermissionDecisions } from '../../src/permissions/context-access.ts';
import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from '../../src/operations/errors.ts';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'opaque-session-reference',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const active = {
  bindingAuthenticationNamespaceId: null,
  bindingPrincipalId: principal.principalId,
  bindingRevokedAt: null,
  bindingStatus: 'active',
  bindingTenantId: principal.tenantId,
  legalEntityStatus: 'active',
  legalEntityTenantId: principal.tenantId,
  principalStatus: 'active',
  principalTenantId: principal.tenantId,
  tenantStatus: 'active',
};
const access = (decision: 'allowed' | 'denied' | 'unavailable') => ({
  legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision, key }))),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
});
/** A SpiceDB client that records each CheckBulkPermissions request and allows every item. */
const recordingPermissionClient = (requests: v1.CheckBulkPermissionsRequest[]): SpiceDbPermissionClient => ({
  checkBulkPermissions: (request) =>
    Effect.sync(() => {
      requests.push(request);
      return v1.CheckBulkPermissionsResponse.create({
        pairs: request.items.map((item) =>
          v1.CheckBulkPermissionsPair.create({
            request: item,
            response: {
              item: v1.CheckBulkPermissionsResponseItem.create({
                permissionship: v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
              }),
              oneofKind: 'item',
            },
          }),
        ),
      });
    }),
  checkPermission: () => Effect.die(new Error('Action check must not run')),
  close: () => {},
});
const InactiveContextError = Schema.Union([OperationAuthenticationRequired, OperationContextDenied]);

it.layer(NodeCrypto.layer)('operation context', (suite) => {
  suite.effect('classifies required, optional, forbidden, denied, unavailable, and valid scope before handlers', () =>
    Effect.gen(function* scopeClassification() {
      const repository = { load: () => Effect.succeed(active) };
      const allowed = yield* makeOperationalScopeResolver(repository, access('allowed'));
      const valid = yield* allowed.resolve({
        correlationId: 'c-1',
        legalEntityScope: 'required',
        principal,
      });
      const { legalEntityId: _legalEntityId, ...principalWithoutLegalEntity } = principal;
      const missing = yield* Effect.flip(
        allowed.resolve({
          correlationId: 'c-1',
          legalEntityScope: 'required',
          principal: principalWithoutLegalEntity,
        }),
      );
      const forbidden = yield* Effect.flip(
        allowed.resolve({
          correlationId: 'c-1',
          legalEntityScope: 'forbidden',
          principal,
        }),
      );
      const denied = yield* Effect.flip(
        (yield* makeOperationalScopeResolver(repository, access('denied'))).resolve({
          correlationId: 'c-1',
          legalEntityScope: 'optional',
          principal,
        }),
      );
      const unavailable = yield* Effect.flip(
        (yield* makeOperationalScopeResolver(repository, access('unavailable'))).resolve({
          correlationId: 'c-1',
          legalEntityScope: 'optional',
          principal,
        }),
      );

      expect(Object.isFrozen(valid)).toBe(true);
      expect(Schema.is(OperationContextDenied)(missing)).toBe(true);
      expect(Schema.is(OperationContextInvalid)(forbidden)).toBe(true);
      expect(Schema.is(OperationContextDenied)(denied)).toBe(true);
      expect(Schema.is(OperationContextUnavailable)(unavailable)).toBe(true);
    }),
  );

  suite.effect('rejects stale tenant, principal, revoked auth binding, and cross-tenant entity records', () =>
    Effect.gen(function* staleContextRecords() {
      const records = [
        { ...active, tenantStatus: 'suspended' },
        { ...active, principalStatus: 'disabled' },
        {
          ...active,
          bindingRevokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')),
        },
        { ...active, bindingTenantId: '00000000-0000-4000-8000-000000000099' },
        {
          ...active,
          legalEntityTenantId: '00000000-0000-4000-8000-000000000099',
        },
      ];
      const errors = yield* Effect.forEach(
        records,
        (record) =>
          makeOperationalScopeResolver({ load: () => Effect.succeed(record) }, access('allowed')).pipe(
            Effect.flatMap((resolver) =>
              Effect.flip(
                resolver.resolve({
                  correlationId: 'c-1',
                  legalEntityScope: 'required',
                  principal,
                }),
              ),
            ),
          ),
        { concurrency: 1 },
      );
      for (const error of errors) {
        expect(Schema.is(InactiveContextError)(error)).toBe(true);
      }
    }),
  );

  suite.effect('preserves resolver-issued system provenance across operational scope construction', () =>
    Effect.gen(function* systemProvenance() {
      const systemContext = yield* systemPrincipalContextResolverFromRepository({
        load: () =>
          Effect.succeed({
            kind: 'system' as const,
            principalStatus: 'active' as const,
            tenantStatus: 'active' as const,
          }).pipe(Effect.asSome),
      }).resolve({
        principalId: principal.principalId,
        registration: registerSystemWorkload({
          jobKey: 'operation-scope-test',
        }),
        runReference: 'run-1',
        tenantId: principal.tenantId,
      });
      const resolver = yield* makeOperationalScopeResolver(
        {
          load: () =>
            Effect.succeed({
              ...active,
              bindingPrincipalId: null,
              bindingStatus: null,
              bindingTenantId: null,
              legalEntityStatus: null,
              legalEntityTenantId: null,
            }),
        },
        access('allowed'),
      );

      const scope = yield* resolver.resolve({
        correlationId: 'system-correlation',
        legalEntityScope: 'forbidden',
        principal: systemContext,
      });

      expect(scope.authMethod).toBe('system');
      expect(scope.correlationId).toBe('system-correlation');
      const decoded = yield* decodeTrustedPrincipalContext(scope);
      expect(decoded.authMethod).toBe('system');
      expect(decoded.principalId).toBe(scope.principalId);
      const untrusted = yield* Effect.exit(decodeTrustedPrincipalContext({ ...scope }));
      expect(Exit.isFailure(untrusted)).toBe(true);
    }),
  );

  suite.effect('preserves verified Storefront scope through persisted tenant and legal-entity checks', () =>
    Effect.gen(function* verifiedStorefrontScope() {
      const storefrontPrincipal = trustVerifiedGatewayPrincipalContext(
        {
          ...principal,
          trustedStorefrontId: 'storefront-tenant-a-b2b',
        },
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      const resolver = yield* makeOperationalScopeResolver({ load: () => Effect.succeed(active) }, access('allowed'));

      const resolved = yield* resolver.resolve({
        correlationId: 'storefront-scope',
        legalEntityScope: 'required',
        principal: storefrontPrincipal,
      });

      expect(resolved.trustedStorefrontId).toBe('storefront-tenant-a-b2b');
      expect(isVerifiedGatewayPrincipalContext(resolved)).toBe(true);
      expect(Object.isFrozen(storefrontPrincipal)).toBe(true);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(readVerifiedGatewayCompositionRevision(resolved)).toBe(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(readVerifiedGatewayCompositionRevision({ ...resolved })).toBeUndefined();
      expect(Exit.isFailure(yield* Effect.exit(decodeTrustedPrincipalContext({ ...resolved })))).toBe(true);
    }),
  );

  suite.effect('permits only a resolver-branded support-stop recovery through inactive historical scope', () =>
    Effect.gen(function* supportRecovery() {
      const recoveryPrincipal = yield* supportRecoveryPrincipalContextResolverFromRepository({
        load: () =>
          Effect.succeed({
            bindingPrincipalId: principal.principalId,
            bindingTenantId: principal.tenantId,
            principalKind: 'human' as const,
            principalTenantId: principal.tenantId,
            tenantId: principal.tenantId,
          }).pipe(Effect.asSome),
      }).resolveStoppedImpersonation({
        originalAuthBindingId: principal.authBindingId ?? '00000000-0000-0000-0000-000000000004',
        originalPrincipalId: principal.principalId,
        originalSessionId: 'expired-original-session',
        tenantId: principal.tenantId,
      });
      const resolver = yield* makeOperationalScopeResolver(
        {
          load: () =>
            Effect.succeed({
              ...active,
              bindingRevokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-09T00:00:00.000Z')),
              bindingStatus: 'revoked',
              principalStatus: 'disabled',
              tenantStatus: 'suspended',
            }),
        },
        access('allowed'),
      );

      const scope = yield* resolver.resolve({
        correlationId: 'support-recovery',
        legalEntityScope: 'optional',
        principal: recoveryPrincipal,
      });

      expect(isTrustedSupportRecoveryPrincipalContext(scope, recordSupportImpersonationAction)).toBe(true);
      expect(isTrustedSupportRecoveryPrincipalContext(scope, {})).toBe(false);
      expect(isTrustedSupportRecoveryPrincipalContext({ ...scope })).toBe(false);
    }),
  );
  suite.effect('audits cached-credential disabled admission without a session request or handler', () =>
    Effect.gen(function* cachedCredentialDenial() {
      const attempts: string[] = [];
      const resolver = yield* makeOperationalScopeResolver(
        { load: () => Effect.succeed({ ...active, principalStatus: 'disabled' }) },
        access('allowed'),
        (input) =>
          Effect.sync(() => {
            attempts.push(input.correlationId);
          }),
      );
      const failure = yield* Effect.flip(
        resolver.resolve({
          correlationId: 'cached-bearer-mutation',
          legalEntityScope: 'required',
          principal,
        }),
      );
      expect(failure).toBeInstanceOf(OperationContextDenied);
      expect(attempts).toEqual(['cached-bearer-mutation']);
    }),
  );

  suite.effect('binds agent API key admission to its audited issuing company, not the principal’s other roles', () =>
    Effect.gen(function* companyAgentKeyAdmission() {
      const apiPrincipal = { ...principal, authMethod: 'api_key' as const };
      const record = {
        ...active,
        bindingIssuingLegalEntityId: principal.legalEntityId ?? null,
        bindingSubjectType: 'api_key',
        principalKind: 'agent',
      };
      const resolve = (
        persisted: Omit<typeof record, 'bindingIssuingLegalEntityId'> & { bindingIssuingLegalEntityId: string | null },
        target: typeof principal = apiPrincipal,
      ) =>
        Effect.flatMap(
          makeOperationalScopeResolver({ load: () => Effect.succeed(persisted) }, access('allowed')),
          (resolver) =>
            resolver.resolve({
              correlationId: 'agent-key-admission',
              legalEntityScope: 'optional',
              principal: target,
            }),
        );
      yield* resolve(record);
      const wrongCompany = yield* Effect.flip(resolve({ ...record, bindingIssuingLegalEntityId: 'other-company' }));
      expect(Schema.is(OperationContextDenied)(wrongCompany)).toBe(true);
      const missingAudit = yield* Effect.flip(resolve({ ...record, bindingIssuingLegalEntityId: null }));
      expect(Schema.is(OperationContextDenied)(missingAudit)).toBe(true);
      const { legalEntityId: _company, ...tenantPrincipal } = apiPrincipal;
      const tenantContext = yield* Effect.flip(resolve(record, tenantPrincipal));
      expect(Schema.is(OperationContextDenied)(tenantContext)).toBe(true);
      // Native tenant-managed workloads retain their existing scope rules.
      yield* resolve({ ...record, bindingIssuingLegalEntityId: null, principalKind: 'service' }, tenantPrincipal);
    }),
  );

  suite.effect('starts the Legal Entity access check beside the persisted load, not after it', () =>
    Effect.gen(function* legalEntityAccessOverlapsLoad() {
      const accessStarted = yield* Deferred.make<boolean>();
      let legalEntityChecks = 0;
      const overlapping = {
        legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
          Effect.sync(() => {
            legalEntityChecks += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(accessStarted, true)),
            Effect.as(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
          ),
        modules: () => Effect.succeed([]),
        resources: () => Effect.succeed([]),
      };
      // The load finishes only once the access check has started: a sequential resolver would never finish it.
      const repository = { load: () => Deferred.await(accessStarted).pipe(Effect.as(active)) };
      const resolver = yield* makeOperationalScopeResolver(repository, overlapping);
      const resolved = yield* resolver
        .resolve({ correlationId: 'c-1', legalEntityScope: 'required', principal })
        .pipe(Effect.timeout(Duration.seconds(2)));
      expect(resolved.legalEntityId).toBe(principal.legalEntityId);
      expect(legalEntityChecks).toBe(1);
    }),
  );

  suite.effect('sends the overlapping Legal Entity and module checks to SpiceDB in one round trip', () =>
    Effect.gen(function* overlappingChecksShareOneRpc() {
      const requests: v1.CheckBulkPermissionsRequest[] = [];
      const contextAccess = makeContextAccess(recordingPermissionClient(requests));
      // The load takes real I/O time, so a sequential resolver would send the Legal Entity check afterwards.
      const repository = {
        load: () => Effect.sleep('5 millis').pipe(Effect.as(active)),
      };
      const resolver = yield* makeOperationalScopeResolver(repository, contextAccess);
      const prefetch = contextAccess.modules({
        legalEntityId: principal.legalEntityId ?? '',
        moduleIds: ['core.shell'],
        principalId: principal.principalId,
        tenantId: principal.tenantId,
      });
      const running = yield* Effect.forkChild(
        Effect.all([resolver.resolve({ correlationId: 'c-1', legalEntityScope: 'required', principal }), prefetch], {
          concurrency: 2,
        }).pipe(withRequestPermissionDecisions),
      );
      yield* TestClock.adjust('5 millis');
      const resolved = yield* Fiber.join(running);
      expect(resolved[0].legalEntityId).toBe(principal.legalEntityId);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.items).toHaveLength(2);
    }),
  );

  suite.effect('keeps persisted Legal Entity denial ahead of the overlapping access decision', () =>
    Effect.gen(function* persistedDenialOutranksAccess() {
      const inactive = { ...active, legalEntityStatus: 'suspended' };
      const unavailable = {
        legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
          Effect.succeed(legalEntityIds.map((key) => ({ decision: 'unavailable' as const, key }))),
        modules: () => Effect.succeed([]),
        resources: () => Effect.succeed([]),
      };
      const dying = {
        legalEntities: () => Effect.die(new Error('legal entity access defect')),
        modules: () => Effect.succeed([]),
        resources: () => Effect.succeed([]),
      };
      const request = { correlationId: 'c-1', legalEntityScope: 'required' as const, principal };
      const denied = yield* Effect.flatMap(
        makeOperationalScopeResolver({ load: () => Effect.succeed(inactive) }, unavailable),
        (resolver) => Effect.flip(resolver.resolve(request)),
      );
      expect(Schema.is(OperationContextDenied)(denied)).toBe(true);
      // A defect from the overlapping check is observed only after the persisted gates pass.
      const masked = yield* Effect.flatMap(
        makeOperationalScopeResolver({ load: () => Effect.succeed(inactive) }, dying),
        (resolver) => Effect.flip(resolver.resolve(request)),
      );
      expect(Schema.is(OperationContextDenied)(masked)).toBe(true);
      const defect = yield* Effect.flatMap(
        makeOperationalScopeResolver({ load: () => Effect.succeed(active) }, dying),
        (resolver) => Effect.exit(resolver.resolve(request)),
      );
      expect(Exit.isFailure(defect)).toBe(true);
    }),
  );
});
