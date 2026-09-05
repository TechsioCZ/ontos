// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Predicate, Redacted } from 'effect';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { Pool } from 'pg';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
  makePrincipalResolver,
  makeSupportRecoveryPrincipalContextResolver,
} from '@app/core-runtime';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
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
import { issueGatewayContextAssertion } from '../../api/auth/gateway-issuer.ts';
import { loadAuthConfig } from '../../api/auth/config.ts';
import {
  account,
  apikey,
  authRelations,
  session,
  supportImpersonationRecovery,
  user,
} from '../../api/auth/db/schema.ts';
import { makeSupportImpersonationService } from '../../api/auth/impersonation-service.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';
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

void test('verifies provider keys and completes live support impersonation with durable stopped evidence', async (context) => {
  const baseConfiguration = await Effect.runPromise(loadAuthConfig());
  const authPool = new Pool({
    connectionString: Redacted.value(baseConfiguration.connectionString),
  });
  const corePool = new Pool({
    connectionString: Redacted.value(baseConfiguration.connectionString),
  });
  const authDatabase = drizzle({ client: authPool, relations: authRelations });
  const coreDatabase = drizzle({ client: corePool, relations: coreRelations });
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
  const fixtureAuthentication = makeAuthenticationService(
    baseConfiguration,
    authDatabase,
    resolver,
    { allowFixtureSignUp: true },
  );
  let originalUserId = '';
  let targetUserId = '';
  let secondAdministratorUserId = '';
  const cleanup = async () => {
    if (
      originalUserId.length > 0 ||
      targetUserId.length > 0 ||
      secondAdministratorUserId.length > 0
    ) {
      const ids = [originalUserId, targetUserId, secondAdministratorUserId].filter(
        (id) => id.length > 0,
      );
      await authDatabase
        .delete(supportImpersonationRecovery)
        .where(eq(supportImpersonationRecovery.tenantId, tenantId));
      await authDatabase.delete(apikey).where(inArray(apikey.referenceId, ids));
      await authDatabase.delete(session).where(inArray(session.userId, ids));
      await authDatabase.delete(account).where(inArray(account.userId, ids));
      await authDatabase.delete(user).where(inArray(user.id, ids));
    }
    await coreDatabase.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
    await coreDatabase.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    await coreDatabase.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId));
    await coreDatabase
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.tenantId, tenantId));
    await coreDatabase.delete(principals).where(eq(principals.tenantId, tenantId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId));
  };

  try {
    originalUserId = await Effect.runPromise(
      fixtureAuthentication.createFixtureUser(originalEmail, 'Support original', password),
    );
    targetUserId = await Effect.runPromise(
      fixtureAuthentication.createFixtureUser(targetEmail, 'Support target', password),
    );
    secondAdministratorUserId = await Effect.runPromise(
      fixtureAuthentication.createFixtureUser(
        secondAdministratorEmail,
        'Second identity administrator',
        password,
      ),
    );
    await coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Identity modes Auth integration',
      slug: `identity-modes-auth-${tenantId}`,
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(principals).values([
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
    await coreDatabase.insert(principalAuthBindings).values([
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
    const authentication = makeAuthenticationService(configuration, authDatabase, resolver, {
      contextAccess: allowedContextAccess,
      legalEntityContext: {
        listActiveForTenant: () => Effect.succeed([]),
        validateSelection: () => Effect.die('not used'),
      },
    });
    const signedIn = await Effect.runPromise(
      authentication.signIn(
        originalEmail,
        password,
        new Headers({ origin: configuration.baseUrl }),
      ),
    );
    const originalHeaders = new Headers({
      cookie: cookieHeader(signedIn.setCookieHeaders),
      origin: configuration.baseUrl,
    });

    const keys = makeApiKeyService(configuration, authDatabase);
    const resolvedOriginal = await Effect.runPromise(
      authentication.resolveTenantContext(originalHeaders),
    );
    assert.equal(resolvedOriginal.state, 'authenticated');
    if (resolvedOriginal.state !== 'authenticated') {
      throw new Error('The live original session did not resolve');
    }
    await context.test(
      'finds stale pending API keys with current and legacy metadata orders',
      async () => {
        const nowEpochMillis = Date.now();
        const lifecycleOperationId = randomUUID();
        const pending = await Effect.runPromise(
          keys.issue(originalHeaders, {
            issuerPrincipalId: originalPrincipalId,
            lifecycleOperationId,
            name: 'Pending cleanup integration key',
            tenantId,
          }),
        );
        await authDatabase
          .update(apikey)
          .set({ createdAt: new Date(nowEpochMillis - 10 * 60 * 1000) })
          .where(eq(apikey.id, pending.providerKeyId));

        assert.deepEqual(
          await Effect.runPromise(
            keys.pendingCleanup({
              issuerPrincipalId: originalPrincipalId,
              lifecycleOperationId: randomUUID(),
              nowEpochMillis,
              tenantId,
            }),
          ),
          { hasMore: false, providerKeyIds: [pending.providerKeyId] },
        );
        await authDatabase
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
        assert.deepEqual(
          await Effect.runPromise(
            keys.pendingCleanup({
              issuerPrincipalId: originalPrincipalId,
              lifecycleOperationId: randomUUID(),
              nowEpochMillis,
              tenantId,
            }),
          ),
          { hasMore: false, providerKeyIds: [pending.providerKeyId] },
        );
        await Effect.runPromise(keys.setEnabled(pending.providerKeyId, false));
        await Effect.runPromise(keys.clearPendingCleanup(pending.providerKeyId));
      },
    );
    const lifecycle = makeIdentityLifecycleService(actionRuntime, keys, resolver);
    const issued = await Effect.runPromise(
      lifecycle.issue({
        correlationId: randomUUID(),
        idempotencyKey: `identity-integration-key-${randomUUID()}`,
        name: 'Identity integration key',
        principal: resolvedOriginal.principal,
        requestHeaders: originalHeaders,
      }),
    );
    const verified = await Effect.runPromise(keys.verify(Redacted.value(issued.secret)));
    const apiKeyAuthBindingId = issued.authBindingId;
    const apiKeyIdentity = await Effect.runPromise(
      resolver.resolveBetterAuthApiKey(verified.providerKeyId),
    );
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });
    const privateJwk = await exportJWK(privateKey);
    const assertion = await Effect.runPromise(
      issueGatewayContextAssertion(
        {
          audience: 'identity-integration',
          principal: {
            authBindingId: apiKeyIdentity.authBindingId,
            authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
            authMethod: 'api_key',
            principalId: apiKeyIdentity.principalId,
            tenantId: apiKeyIdentity.tenantId,
          },
        },
        {
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
        },
      ),
    );
    const verifiedAssertion = await jwtVerify(assertion.token, publicKey, {
      algorithms: ['EdDSA'],
      audience: 'identity-integration',
      currentDate: new Date(1_800_000_001_000),
      issuer: 'https://shell.identity-integration.test',
    });
    assert.deepEqual(verifiedAssertion.payload['principal'], {
      authBindingId: apiKeyAuthBindingId,
      authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
      authMethod: 'api_key',
      principalId: originalPrincipalId,
      tenantId,
    });
    assert.equal(
      JSON.stringify(verifiedAssertion.payload).includes(Redacted.value(issued.secret)),
      false,
    );
    await Effect.runPromise(
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
    await Effect.runPromise(keys.setEnabled(verified.providerKeyId, false));
    const invalidKey = await Effect.runPromise(
      Effect.flip(keys.verify(Redacted.value(issued.secret))),
    );
    assert.equal(invalidKey._tag, 'ApiKeyCredentialInvalidError');

    const managedPrincipal = await Effect.runPromise(
      lifecycle.createNonHumanPrincipal({
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        payload: { displayName: 'Cross-admin integration', kind: 'integration' },
        principal: resolvedOriginal.principal,
      }),
    );
    const managedKey = await Effect.runPromise(
      lifecycle.issue({
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        managedPrincipalId: managedPrincipal.principalId,
        name: 'Cross-admin key',
        principal: resolvedOriginal.principal,
        requestHeaders: originalHeaders,
      }),
    );
    const secondAdministratorSignIn = await Effect.runPromise(
      authentication.signIn(
        secondAdministratorEmail,
        password,
        new Headers({ origin: configuration.baseUrl }),
      ),
    );
    const secondAdministratorContext = await Effect.runPromise(
      authentication.resolveTenantContext(
        new Headers({
          cookie: cookieHeader(secondAdministratorSignIn.setCookieHeaders),
          origin: configuration.baseUrl,
        }),
      ),
    );
    assert.equal(secondAdministratorContext.state, 'authenticated');
    if (secondAdministratorContext.state !== 'authenticated') {
      throw new Error('The second live tenant administrator did not resolve');
    }
    const crossAdminDisabled = await Effect.runPromise(
      lifecycle.setStatus({
        authBindingId: managedKey.authBindingId,
        correlationId: randomUUID(),
        expectedStatus: 'active',
        idempotencyKey: randomUUID(),
        managedPrincipalId: managedPrincipal.principalId,
        newStatus: 'disabled',
        principal: secondAdministratorContext.principal,
        reason: 'Cross-admin lifecycle integration proof',
      }),
    );
    assert.equal(crossAdminDisabled.enabled, false);
    assert.equal(crossAdminDisabled.cleanupPending, false);

    const support = makeSupportImpersonationService({
      actionRuntime,
      authentication,
      configuration,
      database: authDatabase,
      resolver,
      supportRecoveryPrincipal: makeSupportRecoveryPrincipalContextResolver({
        executor: coreDatabase,
      }),
    });
    const started = await Effect.runPromise(
      support.start({
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        reason: 'Investigating a tenant support request',
        requestHeaders: originalHeaders,
        targetPrincipalId,
      }),
    );
    const impersonatedHeaders = new Headers({
      cookie: cookieHeader(started.setCookieHeaders),
      origin: configuration.baseUrl,
    });
    const [impersonationSession] = await authDatabase
      .select({ actionId: session.impersonationActionId, id: session.id })
      .from(session)
      .where(and(eq(session.userId, targetUserId), eq(session.impersonatedBy, originalUserId)))
      .limit(1);
    assert.notEqual(impersonationSession, undefined);
    if (impersonationSession === undefined) {
      throw new TypeError('The support impersonation session was not persisted');
    }
    assert.equal(Predicate.isString(impersonationSession.actionId), true);
    if (!Predicate.isString(impersonationSession.actionId)) {
      throw new TypeError('The approved support start did not persist its Action correlation');
    }
    await authDatabase
      .update(session)
      .set({ impersonationActionId: null })
      .where(eq(session.id, impersonationSession.id));
    const incompleteImpersonation = await Effect.runPromise(
      Effect.flip(authentication.resolveTenantContext(impersonatedHeaders)),
    );
    assert.equal(incompleteImpersonation._tag, 'OntosIdentityForbiddenError');
    await authDatabase
      .update(session)
      .set({ impersonationActionId: impersonationSession.actionId })
      .where(eq(session.id, impersonationSession.id));
    await authDatabase
      .update(session)
      .set({ impersonationReason: 'Tampered support reason' })
      .where(eq(session.id, impersonationSession.id));
    const mismatchedImpersonationReason = await Effect.runPromise(
      Effect.flip(authentication.resolveTenantContext(impersonatedHeaders)),
    );
    assert.equal(mismatchedImpersonationReason._tag, 'OntosIdentityForbiddenError');
    await authDatabase
      .update(session)
      .set({ impersonationReason: 'Investigating a tenant support request' })
      .where(eq(session.id, impersonationSession.id));
    const impersonated = await Effect.runPromise(
      authentication.resolveTenantContext(impersonatedHeaders),
    );
    assert.equal(impersonated.state, 'authenticated');
    if (impersonated.state === 'authenticated') {
      assert.equal(impersonated.principal.authMethod, 'support_impersonation');
      assert.equal(impersonated.principal.principalId, targetPrincipalId);
      assert.equal(impersonated.principal.impersonatedByPrincipalId, originalPrincipalId);
      await Effect.runPromise(
        actionRuntime.runAction({
          payload: { displayName: 'Support evidence target', kind: 'integration' },
          principal: impersonated.principal,
          registration: createNonHumanPrincipalAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        }),
      );
    }
    supportPermissionAllowed = false;
    const revokedImpersonation = await Effect.runPromise(
      Effect.flip(authentication.resolveTenantContext(impersonatedHeaders)),
    );
    assert.equal(revokedImpersonation._tag, 'OntosIdentityForbiddenError');
    const stopped = await Effect.runPromise(
      support.stop({
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestHeaders: impersonatedHeaders,
      }),
    );
    assert.equal(stopped.checkpointPending, false);
    assert.ok(stopped.setCookieHeaders.length > 0);
    const checkpoints = await coreDatabase
      .select({ evidence: auditEvents.evidenceJson })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenantId));
    assert.deepEqual(
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
      ['requested', 'started', 'stopped'],
    );
    const identityEvidence = await coreDatabase
      .select({
        authBindingId: auditEvents.authBindingId,
        authMethod: auditEvents.authMethod,
        impersonatedByPrincipalId: auditEvents.impersonatedByPrincipalId,
        principalId: auditEvents.principalId,
      })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenantId));
    assert.ok(
      identityEvidence.some(
        (evidence) =>
          evidence.authMethod === 'api_key' &&
          evidence.authBindingId === apiKeyAuthBindingId &&
          evidence.principalId === originalPrincipalId &&
          evidence.impersonatedByPrincipalId === null,
      ),
    );
    assert.ok(
      identityEvidence.some(
        (evidence) =>
          evidence.authMethod === 'support_impersonation' &&
          evidence.authBindingId === targetAuthBindingId &&
          evidence.principalId === targetPrincipalId &&
          evidence.impersonatedByPrincipalId === originalPrincipalId,
      ),
    );
    const recovery = await authDatabase.select().from(supportImpersonationRecovery);
    assert.equal(recovery.length, 0);
  } finally {
    await cleanup();
    await Promise.all([authPool.end(), corePool.end()]);
  }
});
