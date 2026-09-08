import { expect, it } from 'effect-rstest';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { Context, Effect, Predicate } from 'effect';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { Pool } from 'pg';
import {
  ActionRuntime,
  ContextAccess,
  PrincipalResolver,
  SupportRecoveryPrincipalContextResolver,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  makePrincipalResolver,
  makeSupportRecoveryPrincipalContextResolver,
} from '@app/core-runtime';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  PrincipalManagementRepository,
  principalManagementRepositoryFromTransaction,
} from '../../../../packages/core-runtime/src/auth/principal-management.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { createNonHumanPrincipalAction } from '../../../../packages/core-runtime/src/modules/actions/create-non-human-principal.action.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeApiKeyService } from '../../api/auth/api-key-service.ts';
import {
  issueGatewayContextAssertion,
  makeGatewayIssuerLayer,
} from '../../api/auth/gateway-issuer.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import {
  account,
  apikey,
  session,
  supportImpersonationRecovery,
  user,
} from '../../api/auth/db/schema.ts';
import {
  makeSupportAuthProvider,
  makeSupportImpersonationService,
  makeSupportImpersonationStore,
  SupportAuthProviderService,
  SupportImpersonationCorrelationId,
  SupportImpersonationStoreService,
} from '../../api/auth/impersonation-service.ts';
import { AuthenticationService, makeAuthenticationService } from '../../api/auth/service.ts';
import { makeIdentityLifecycleService } from '../../api/auth/identity-lifecycle.ts';

const cookieHeader = (setCookieHeaders: readonly string[]): string => {
  const cookies = new Map<string, string>();
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair !== undefined && separator > 0) {
      cookies.set(pair.slice(0, separator), pair);
    }
  }
  return [...cookies.values()].join('; ');
};
it.live.each([
  {
    name: 'finds stale pending API keys with current and legacy metadata orders',
    pendingCleanupOnly: true,
  },
  {
    name: 'verifies provider keys and completes live support impersonation with durable stopped evidence',
    pendingCleanupOnly: false,
  },
])(
  '$name',
  Effect.fnUntraced(function* runIntegration1({ pendingCleanupOnly }) {
    const baseConfiguration = yield* loadAuthConfig();
    const corePool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: baseConfiguration.connectionString })),
      (pool) => Effect.tryPromise(() => pool.end()).pipe(Effect.orDie),
    );
    const authPersistence = yield* makeAuthDatabase(baseConfiguration);
    const authDatabase = authPersistence.executor;
    const coreDatabase = yield* makeTestDatabaseFromPool(corePool, coreRelations);
    const principalManagementRepository =
      principalManagementRepositoryFromTransaction(coreDatabase);
    const providePrincipalManagementRepository = <Success, Failure, Requirements>(
      effect: Effect.Effect<Success, Failure, Requirements>,
    ) =>
      effect.pipe(
        Effect.provideService(PrincipalManagementRepository, principalManagementRepository),
      );
    const tenantId = randomUUID();
    const originalPrincipalId = randomUUID();
    const targetPrincipalId = randomUUID();
    const secondAdministratorPrincipalId = randomUUID();
    const originalAuthBindingId = randomUUID();
    const targetAuthBindingId = randomUUID();
    const secondAdministratorAuthBindingId = randomUUID();
    const originalEmail = `support-original-${randomUUID()}@example.test`;
    const targetEmail = `support-target-${randomUUID()}@example.test`;
    const secondAdministratorEmail = `identity-admin-${randomUUID()}@example.test`;
    const password = 'correct-horse-battery-staple';
    const resolver = makePrincipalResolver({ executor: coreDatabase });
    let supportPermissionAllowed = true;
    const allowedContextAccess = {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: ({
        permission,
        tenantIds,
      }: {
        readonly permission:
          | 'access'
          | 'impersonate'
          | 'manage_identity'
          | 'manage_party_identity'
          | 'manage_party_relationships'
          | 'merge_party_identity'
          | 'read_party_identity'
          | 'review_party_identity';
        readonly tenantIds: readonly string[];
      }) =>
        Effect.succeed(
          tenantIds.map((key) => ({
            decision:
              permission === 'impersonate' && !supportPermissionAllowed
                ? ('denied' as const)
                : ('allowed' as const),
            key,
          })),
        ),
    };
    const provideContextAccess = <Success, Failure, Requirements>(
      effect: Effect.Effect<Success, Failure, Requirements>,
    ) => effect.pipe(Effect.provideService(ContextAccess, allowedContextAccess));
    const operationalScope = makeOperationalScopeResolver(
      makeOperationalScopeRepository({ executor: coreDatabase }),
      allowedContextAccess,
    );
    const actionRuntime = makeActionRuntime(
      { executor: coreDatabase },
      makeActionRepository(),
      { checkActionPermission: () => Effect.succeed('allowed' as const) },
      operationalScope,
      { ...openActionRuntimeOptions, contextAccess: allowedContextAccess },
    );
    const fixtureAuthentication = yield* makeAuthenticationService({
      allowFixtureSignUp: true,
    }).pipe(
      Effect.provideService(AuthConfig, baseConfiguration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, resolver),
    );
    let originalUserId = '';
    let targetUserId = '';
    let secondAdministratorUserId = '';
    const cleanup = Effect.fnUntraced(function* runIntegration2() {
      if (
        originalUserId.length > 0 ||
        targetUserId.length > 0 ||
        secondAdministratorUserId.length > 0
      ) {
        const ids = [originalUserId, targetUserId, secondAdministratorUserId].filter(
          (id) => id.length > 0,
        );
        yield* authDatabase
          .delete(supportImpersonationRecovery)
          .where(eq(supportImpersonationRecovery.tenantId, tenantId));
        yield* authDatabase.delete(apikey).where(inArray(apikey.referenceId, ids));
        yield* authDatabase.delete(session).where(inArray(session.userId, ids));
        yield* authDatabase.delete(account).where(inArray(account.userId, ids));
        yield* authDatabase.delete(user).where(inArray(user.id, ids));
      }
      yield* coreDatabase.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
      yield* coreDatabase.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
      yield* coreDatabase.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
      yield* coreDatabase
        .delete(principalAuthBindings)
        .where(eq(principalAuthBindings.tenantId, tenantId));
      yield* coreDatabase.delete(principals).where(eq(principals.tenantId, tenantId));
      yield* coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId));
    });
    yield* Effect.acquireRelease(
      Effect.void,
      Effect.fnUntraced(function* integrationEffect3() {
        yield* cleanup();
      }, Effect.orDie),
    );
    originalUserId = yield* fixtureAuthentication.createFixtureUser(
      originalEmail,
      'Support original',
      password,
    );
    targetUserId = yield* fixtureAuthentication.createFixtureUser(
      targetEmail,
      'Support target',
      password,
    );
    secondAdministratorUserId = yield* fixtureAuthentication.createFixtureUser(
      secondAdministratorEmail,
      'Second identity administrator',
      password,
    );
    yield* coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Identity modes Auth integration',
      slug: `identity-modes-auth-${tenantId}`,
      status: 'active',
      tenantId,
    });
    yield* coreDatabase.insert(principals).values([
      {
        displayName: 'Support original',
        kind: 'human',
        principalId: originalPrincipalId,
        status: 'active',
        tenantId,
      },
      {
        displayName: 'Support target',
        kind: 'human',
        principalId: targetPrincipalId,
        status: 'active',
        tenantId,
      },
      {
        displayName: 'Second identity administrator',
        kind: 'human',
        principalId: secondAdministratorPrincipalId,
        status: 'active',
        tenantId,
      },
    ]);
    yield* coreDatabase.insert(principalAuthBindings).values([
      {
        principalAuthBindingId: originalAuthBindingId,
        principalId: originalPrincipalId,
        provider: 'better_auth',
        providerSubjectId: originalUserId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      },
      {
        principalAuthBindingId: targetAuthBindingId,
        principalId: targetPrincipalId,
        provider: 'better_auth',
        providerSubjectId: targetUserId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      },
      {
        principalAuthBindingId: secondAdministratorAuthBindingId,
        principalId: secondAdministratorPrincipalId,
        provider: 'better_auth',
        providerSubjectId: secondAdministratorUserId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      },
    ]);
    const configuration = {
      ...baseConfiguration,
      supportUserIds: [originalUserId],
    };
    const authentication = yield* makeAuthenticationService({}).pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
      Effect.provideService(PrincipalResolver, resolver),
    );
    const signedIn = yield* authentication.signIn(
      originalEmail,
      password,
      new Headers({ origin: configuration.baseUrl }),
    );
    const originalHeaders = new Headers({
      cookie: cookieHeader(signedIn.setCookieHeaders),
      origin: configuration.baseUrl,
    });
    const keys = yield* makeApiKeyService().pipe(
      Effect.provideService(AuthConfig, configuration),
      Effect.provideService(AuthDatabase, authPersistence),
    );
    const resolvedOriginal = yield* provideContextAccess(
      authentication.resolveTenantContext(originalHeaders),
    );
    expect(resolvedOriginal.state).toBe('authenticated');
    if (resolvedOriginal.state !== 'authenticated') {
      throw new Error('The live original session did not resolve');
    }
    if (pendingCleanupOnly) {
      yield* Effect.gen(function* integrationEffect4() {
        const nowEpochMillis = 1_800_000_000_000;
        const lifecycleOperationId = randomUUID();
        const pending = yield* keys.issue(originalHeaders, {
          issuerPrincipalId: originalPrincipalId,
          lifecycleOperationId,
          name: 'Pending cleanup integration key',
          tenantId,
        });
        yield* authDatabase
          .update(apikey)
          .set({ createdAt: new Date(nowEpochMillis - 10 * 60 * 1000) })
          .where(eq(apikey.id, pending.providerKeyId));
        expect(
          yield* keys.pendingCleanup({
            issuerPrincipalId: originalPrincipalId,
            lifecycleOperationId: randomUUID(),
            nowEpochMillis,
            tenantId,
          }),
        ).toEqual({ hasMore: false, providerKeyIds: [pending.providerKeyId] });
        yield* authDatabase
          .update(apikey)
          .set({
            metadata: JSON.stringify({
              issuerPrincipalId: originalPrincipalId,
              lifecycleOperationId,
              ontosLifecycle: 'binding_pending_v1',
              tenantId,
            }),
          })
          .where(eq(apikey.id, pending.providerKeyId));
        expect(
          yield* keys.pendingCleanup({
            issuerPrincipalId: originalPrincipalId,
            lifecycleOperationId: randomUUID(),
            nowEpochMillis,
            tenantId,
          }),
        ).toEqual({ hasMore: false, providerKeyIds: [pending.providerKeyId] });
        yield* keys.setEnabled(pending.providerKeyId, false);
        yield* keys.clearPendingCleanup(pending.providerKeyId);
      });
      return;
    }
    const lifecycle = makeIdentityLifecycleService(actionRuntime, keys, resolver);
    const issued = yield* lifecycle.issue({
      correlationId: randomUUID(),
      idempotencyKey: `identity-integration-key-${randomUUID()}`,
      name: 'Identity integration key',
      principal: resolvedOriginal.principal,
      requestHeaders: originalHeaders,
    });
    const verified = yield* keys.verify(issued.secret);
    const apiKeyAuthBindingId = issued.authBindingId;
    const apiKeyIdentity = yield* resolver.resolveBetterAuthApiKey(verified.providerKeyId);
    const { privateKey, publicKey } = yield* Effect.tryPromise(() =>
      generateKeyPair('EdDSA', {
        crv: 'Ed25519',
        extractable: true,
      }),
    );
    const privateJwk = yield* Effect.tryPromise(() => exportJWK(privateKey));
    const assertion = yield* issueGatewayContextAssertion({
      audience: 'identity-integration',
      principal: {
        authBindingId: apiKeyIdentity.authBindingId,
        authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
        authMethod: 'api_key',
        principalId: apiKeyIdentity.principalId,
        tenantId: apiKeyIdentity.tenantId,
      },
    }).pipe(
      Effect.provide(
        makeGatewayIssuerLayer({
          currentTimeSeconds: Effect.succeed(1_800_000_000),
          generateJti: Effect.succeed(randomUUID()),
          loadAudiences: Effect.succeed(new Set(['identity-integration'])),
          loadConfig: Effect.succeed({
            issuer: 'https://shell.identity-integration.test',
            privateJwk: {
              alg: 'EdDSA',
              crv: 'Ed25519',
              d: privateJwk.d ?? '',
              kid: 'identity-integration-key',
              kty: 'OKP',
              use: 'sig',
              x: privateJwk.x ?? '',
            },
          }),
        }),
      ),
    );
    const verifiedAssertion = yield* Effect.tryPromise(() =>
      jwtVerify(assertion.token, publicKey, {
        algorithms: ['EdDSA'],
        audience: 'identity-integration',
        currentDate: new Date(1_800_000_001_000),
        issuer: 'https://shell.identity-integration.test',
      }),
    );
    expect(verifiedAssertion.payload['principal']).toEqual({
      authBindingId: apiKeyAuthBindingId,
      authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
      authMethod: 'api_key',
      principalId: originalPrincipalId,
      tenantId,
    });
    expect(JSON.stringify(verifiedAssertion.payload).includes(issued.secret)).toBe(false);
    yield* providePrincipalManagementRepository(
      actionRuntime.runAction({
        payload: { displayName: 'API-key evidence target', kind: 'service' },
        principal: {
          authBindingId: apiKeyAuthBindingId,
          authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
          authMethod: 'api_key',
          principalId: originalPrincipalId,
          tenantId,
        },
        registration: createNonHumanPrincipalAction,
        transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
      }),
    );
    yield* keys.setEnabled(verified.providerKeyId, false);
    const invalidKey = yield* Effect.flip(keys.verify(issued.secret));
    expect(Predicate.isTagged(invalidKey, 'ApiKeyCredentialInvalidError')).toBe(true);
    const managedPrincipal = yield* providePrincipalManagementRepository(
      lifecycle.createNonHumanPrincipal({
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        payload: { displayName: 'Cross-admin integration', kind: 'integration' },
        principal: resolvedOriginal.principal,
      }),
    );
    const managedKey = yield* lifecycle.issue({
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      managedPrincipalId: managedPrincipal.principalId,
      name: 'Cross-admin key',
      principal: resolvedOriginal.principal,
      requestHeaders: originalHeaders,
    });
    const secondAdministratorSignIn = yield* authentication.signIn(
      secondAdministratorEmail,
      password,
      new Headers({ origin: configuration.baseUrl }),
    );
    const secondAdministratorContext = yield* provideContextAccess(
      authentication.resolveTenantContext(
        new Headers({
          cookie: cookieHeader(secondAdministratorSignIn.setCookieHeaders),
          origin: configuration.baseUrl,
        }),
      ),
    );
    expect(secondAdministratorContext.state).toBe('authenticated');
    if (secondAdministratorContext.state !== 'authenticated') {
      throw new Error('The second live tenant administrator did not resolve');
    }
    const crossAdminDisabled = yield* lifecycle.setStatus({
      authBindingId: managedKey.authBindingId,
      correlationId: randomUUID(),
      expectedStatus: 'active',
      idempotencyKey: randomUUID(),
      managedPrincipalId: managedPrincipal.principalId,
      newStatus: 'disabled',
      principal: secondAdministratorContext.principal,
      reason: 'Cross-admin lifecycle integration proof',
    });
    expect(crossAdminDisabled.enabled).toBe(false);
    expect(crossAdminDisabled.cleanupPending).toBe(false);
    const supportRecoveryPrincipal = makeSupportRecoveryPrincipalContextResolver({
      executor: coreDatabase,
    });
    const support = makeSupportImpersonationService(
      Context.empty().pipe(
        Context.add(ActionRuntime, actionRuntime),
        Context.add(AuthenticationService, authentication),
        Context.add(AuthConfig, configuration),
        Context.add(PrincipalResolver, resolver),
        Context.add(SupportRecoveryPrincipalContextResolver, supportRecoveryPrincipal),
        Context.add(
          SupportAuthProviderService,
          makeSupportAuthProvider(configuration, authPersistence.adapter),
        ),
        Context.add(SupportImpersonationStoreService, makeSupportImpersonationStore(authDatabase)),
      ),
    );
    const started = yield* provideContextAccess(
      providePrincipalManagementRepository(
        support
          .start({
            idempotencyKey: randomUUID(),
            reason: 'Investigating a tenant support request',
            requestHeaders: originalHeaders,
            targetPrincipalId,
          })
          .pipe(Effect.provideService(SupportImpersonationCorrelationId, randomUUID())),
      ),
    );
    const impersonatedHeaders = new Headers({
      cookie: cookieHeader(started.setCookieHeaders),
      origin: configuration.baseUrl,
    });
    const [impersonationSession] = yield* authDatabase
      .select({ actionId: session.impersonationActionId, id: session.id })
      .from(session)
      .where(and(eq(session.userId, targetUserId), eq(session.impersonatedBy, originalUserId)))
      .limit(1);
    expect(impersonationSession).not.toBe(undefined);
    if (impersonationSession === undefined) {
      throw new TypeError('The support impersonation session was not persisted');
    }
    expect(Predicate.isString(impersonationSession.actionId)).toBe(true);
    if (!Predicate.isString(impersonationSession.actionId)) {
      throw new TypeError('The approved support start did not persist its Action correlation');
    }
    yield* authDatabase
      .update(session)
      .set({ impersonationActionId: null })
      .where(eq(session.id, impersonationSession.id));
    const incompleteImpersonation = yield* Effect.flip(
      provideContextAccess(authentication.resolveTenantContext(impersonatedHeaders)),
    );
    expect(Predicate.isTagged(incompleteImpersonation, 'OntosIdentityForbiddenError')).toBe(true);
    yield* authDatabase
      .update(session)
      .set({ impersonationActionId: impersonationSession.actionId })
      .where(eq(session.id, impersonationSession.id));
    yield* authDatabase
      .update(session)
      .set({ impersonationReason: 'Tampered support reason' })
      .where(eq(session.id, impersonationSession.id));
    const mismatchedImpersonationReason = yield* Effect.flip(
      provideContextAccess(authentication.resolveTenantContext(impersonatedHeaders)),
    );
    expect(Predicate.isTagged(mismatchedImpersonationReason, 'OntosIdentityForbiddenError')).toBe(
      true,
    );
    yield* authDatabase
      .update(session)
      .set({ impersonationReason: 'Investigating a tenant support request' })
      .where(eq(session.id, impersonationSession.id));
    const impersonated = yield* provideContextAccess(
      authentication.resolveTenantContext(impersonatedHeaders),
    );
    expect(impersonated.state).toBe('authenticated');
    if (impersonated.state === 'authenticated') {
      expect(impersonated.principal.authMethod).toBe('support_impersonation');
      expect(impersonated.principal.principalId).toBe(targetPrincipalId);
      expect(impersonated.principal.impersonatedByPrincipalId).toBe(originalPrincipalId);
      yield* providePrincipalManagementRepository(
        actionRuntime.runAction({
          payload: { displayName: 'Support evidence target', kind: 'integration' },
          principal: impersonated.principal,
          registration: createNonHumanPrincipalAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
    }
    supportPermissionAllowed = false;
    const revokedImpersonation = yield* Effect.flip(
      provideContextAccess(authentication.resolveTenantContext(impersonatedHeaders)),
    );
    expect(Predicate.isTagged(revokedImpersonation, 'OntosIdentityForbiddenError')).toBe(true);
    const stopped = yield* provideContextAccess(
      providePrincipalManagementRepository(
        support
          .stop({
            idempotencyKey: randomUUID(),
            requestHeaders: impersonatedHeaders,
          })
          .pipe(Effect.provideService(SupportImpersonationCorrelationId, randomUUID())),
      ),
    );
    expect(stopped.checkpointPending).toBe(false);
    expect(stopped.setCookieHeaders.length > 0).toBe(true);
    const checkpoints = yield* coreDatabase
      .select({ evidence: auditEvents.evidenceJson })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenantId));
    expect(
      checkpoints
        .flatMap(({ evidence }) =>
          Predicate.isObjectKeyword(evidence) &&
          evidence !== null &&
          'checkpoint' in evidence &&
          Predicate.isString(evidence.checkpoint)
            ? [evidence.checkpoint]
            : [],
        )
        .toSorted(),
    ).toEqual(['requested', 'started', 'stopped']);
    const identityEvidence = yield* coreDatabase
      .select({
        authBindingId: auditEvents.authBindingId,
        authMethod: auditEvents.authMethod,
        impersonatedByPrincipalId: auditEvents.impersonatedByPrincipalId,
        principalId: auditEvents.principalId,
      })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenantId));
    expect(
      identityEvidence.some(
        (evidence) =>
          evidence.authMethod === 'api_key' &&
          evidence.authBindingId === apiKeyAuthBindingId &&
          evidence.principalId === originalPrincipalId &&
          evidence.impersonatedByPrincipalId === null,
      ),
    ).toBe(true);
    expect(
      identityEvidence.some(
        (evidence) =>
          evidence.authMethod === 'support_impersonation' &&
          evidence.authBindingId === targetAuthBindingId &&
          evidence.principalId === targetPrincipalId &&
          evidence.impersonatedByPrincipalId === originalPrincipalId,
      ),
    ).toBe(true);
    const recovery = yield* authDatabase.select().from(supportImpersonationRecovery);
    expect(recovery.length).toBe(0);
  }),
);
