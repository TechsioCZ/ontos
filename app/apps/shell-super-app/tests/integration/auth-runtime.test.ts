import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Layer } from 'effect';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { Pool } from 'pg';
import { makePrincipalResolver } from '@app/core-runtime';
import {
  coreDatabaseSchema,
  principalAuthBindings,
  principals,
  tenants,
} from '@app/core-runtime/db/schema';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import type { GatewayIssuerDependencies } from '../../api/auth/gateway-issuer.ts';
import { account, authDatabaseSchema, session, user } from '../../api/auth/db/schema.ts';
import { AuthenticationService, makeAuthenticationService } from '../../api/auth/service.ts';
import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { renderActionPrincipalServer } from '../../../../scripts/scaffolding/microvertical-action-boundary/scaffold.mts';

const email = 'better-auth-runtime@example.test';
const password = 'correct-horse-battery-staple';
const tenantId = '30000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');

const cookieHeader = (setCookieHeaders: readonly string[]) =>
  setCookieHeaders.map((header) => header.split(';')[0]).join('; ');

test('creates, resolves, persists, revokes, and signs out a Better Auth session', async () => {
  const configuration = await Effect.runPromise(loadAuthConfig());
  const corePool = new Pool({ connectionString: configuration.connectionString });
  const authPool = new Pool({ connectionString: configuration.connectionString });
  const coreDatabase = drizzle({ client: corePool, schema: coreDatabaseSchema });
  const authDatabase = drizzle({ client: authPool, schema: authDatabaseSchema });
  const resolver = makePrincipalResolver({ executor: coreDatabase });
  const authentication = makeAuthenticationService(configuration, authDatabase, resolver, {
    allowFixtureSignUp: true,
  });
  const authenticationLayer = Layer.succeed(AuthenticationService, authentication);
  const handlers: { readonly dispose: () => Promise<void> }[] = [];
  const generatedFixtureRoot = await mkdtemp(path.join(tmpdir(), 'ontos-auth-runtime-'));

  const cleanup = async () => {
    const existingUsers = await authDatabase
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));

    await Promise.all(
      existingUsers.map(async (existingUser) => {
        await coreDatabase
          .delete(principalAuthBindings)
          .where(eq(principalAuthBindings.providerSubjectId, existingUser.id));
        await authDatabase.delete(session).where(eq(session.userId, existingUser.id));
        await authDatabase.delete(account).where(eq(account.userId, existingUser.id));
        await authDatabase.delete(user).where(eq(user.id, existingUser.id));
      }),
    );

    await coreDatabase
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.principalId, principalId));
    await coreDatabase.delete(principals).where(eq(principals.principalId, principalId));
    await coreDatabase.delete(tenants).where(eq(tenants.tenantId, tenantId));
  };

  try {
    await cleanup();
    const betterAuthUserId = await Effect.runPromise(
      authentication.createFixtureUser(email, 'Runtime fixture', password),
    );
    await coreDatabase.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Authentication runtime tenant',
      slug: 'authentication-runtime-tenant',
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(principals).values({
      displayName: 'Runtime fixture',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    await coreDatabase.insert(principalAuthBindings).values({
      principalId,
      provider: 'better_auth',
      providerSubjectId: betterAuthUserId,
      status: 'active',
      subjectType: 'user',
      tenantId,
    });

    const requestHeaders = new Headers({
      origin: configuration.baseUrl,
    });
    const invalid = await Effect.runPromise(
      Effect.flip(authentication.signIn(email, 'wrong-password', requestHeaders)),
    );
    assert.equal(invalid._tag, 'InvalidCredentialsError');

    const anonymousRuntime = makeShellAuthenticationApiRuntime(authenticationLayer, {
      currentTimeSeconds: Effect.succeed(1_700_000_000),
      generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
      loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
      loadConfig: parseGatewayIssuerConfig({}),
    });
    const unavailableHandler = anonymousRuntime.createHandler();
    handlers.push(unavailableHandler);
    const anonymousGatewayResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: { 'content-type': 'application/json', origin: configuration.baseUrl },
        method: 'POST',
      }),
    );
    assert.equal(anonymousGatewayResponse.status, 401);
    assert.match(anonymousGatewayResponse.headers.get('www-authenticate') ?? '', /^Bearer/u);

    const signInResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/sign-in`, {
        body: JSON.stringify({ email, password }),
        headers: { 'content-type': 'application/json', origin: configuration.baseUrl },
        method: 'POST',
      }),
    );
    assert.equal(signInResponse.status, 200);
    const signedIn = (await signInResponse.json()) as {
      readonly identity: { readonly email: string; readonly principalId: string };
    };
    const signedInCookies = signInResponse.headers.getSetCookie();
    assert.equal(signedIn.identity.email, email);
    assert.equal(signedIn.identity.principalId, principalId);
    assert.ok(signedInCookies.length > 0);

    const authenticatedHeaders = new Headers({
      cookie: cookieHeader(signedInCookies),
      origin: configuration.baseUrl,
    });
    const current = await Effect.runPromise(authentication.currentSession(authenticatedHeaders));
    assert.equal(current.identity?.tenantId, tenantId);
    assert.ok(current.identity);

    const currentSessionResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/session`, {
        headers: authenticatedHeaders,
      }),
    );
    assert.equal(currentSessionResponse.status, 200);
    assert.equal(
      ((await currentSessionResponse.json()) as { identity?: { principalId?: string } }).identity
        ?.principalId,
      principalId,
    );

    const unavailableGatewayResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: cookieHeader(signedInCookies),
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(unavailableGatewayResponse.status, 503);
    assert.match(
      unavailableGatewayResponse.headers.get('content-type') ?? '',
      /application\/problem\+json/u,
    );
    assert.equal(
      ((await unavailableGatewayResponse.json()) as { retryable?: boolean }).retryable,
      true,
    );

    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = await exportJWK(pair.publicKey);
    const issuerDependencies: GatewayIssuerDependencies = {
      currentTimeSeconds: Effect.succeed(1_700_000_000),
      generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
      loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
      loadConfig: Effect.succeed({
        issuer: 'https://shell.example.test',
        privateJwk: {
          alg: 'EdDSA',
          crv: 'Ed25519',
          d: privateJwk.d ?? '',
          kid: 'integration-current',
          kty: 'OKP',
          use: 'sig',
          x: privateJwk.x ?? '',
        },
      }),
    };
    const issuingHandler = makeShellAuthenticationApiRuntime(
      authenticationLayer,
      issuerDependencies,
    ).createHandler();
    handlers.push(issuingHandler);
    const assertionResponse = await issuingHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: cookieHeader(signedInCookies),
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(assertionResponse.status, 200);
    const assertion = (await assertionResponse.json()) as { readonly token: string };
    const verifiedAssertion = await jwtVerify(assertion.token, pair.publicKey, {
      algorithms: ['EdDSA'],
      audience: 'inventory-stock',
      currentDate: new Date(1_700_000_001_000),
      issuer: 'https://shell.example.test',
    });
    assert.deepEqual(verifiedAssertion.payload.principal, {
      authMethod: 'session',
      principalId,
      tenantId,
    });

    await mkdir(path.join(generatedFixtureRoot, 'node_modules', '@app'), { recursive: true });
    await symlink(
      path.join(appRoot, 'packages/core-runtime'),
      path.join(generatedFixtureRoot, 'node_modules/@app/core-runtime'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/shared-contracts'),
      path.join(generatedFixtureRoot, 'node_modules/@app/shared-contracts'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'node_modules/effect'),
      path.join(generatedFixtureRoot, 'node_modules/effect'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
      path.join(generatedFixtureRoot, 'node_modules/jose'),
      'dir',
    );
    const generatedVerifierPath = path.join(generatedFixtureRoot, 'action-principal.ts');
    await writeFile(
      generatedVerifierPath,
      renderActionPrincipalServer({ appId: 'inventory-stock' }),
      'utf-8',
    );
    const generatedVerifier = (await import(pathToFileURL(generatedVerifierPath).href)) as {
      readonly verifyActionPrincipal: (
        authorization: string,
        options: {
          readonly currentTimeSeconds: Effect.Effect<number>;
          readonly environment: Readonly<Record<string, string>>;
        },
      ) => Effect.Effect<unknown>;
    };
    assert.deepEqual(
      await Effect.runPromise(
        generatedVerifier.verifyActionPrincipal(`Bearer ${assertion.token}`, {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
          environment: {
            ONTOS_GATEWAY_ISSUER: 'https://shell.example.test',
            ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
              keys: [
                {
                  ...publicJwk,
                  alg: 'EdDSA',
                  kid: 'integration-current',
                  use: 'sig',
                },
              ],
            }),
          },
        }),
      ),
      { authMethod: 'session', principalId, tenantId },
    );

    const invalidAudienceResponse = await issuingHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'billing' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: cookieHeader(signedInCookies),
          origin: configuration.baseUrl,
        }),
        method: 'POST',
      }),
    );
    assert.equal(invalidAudienceResponse.status, 400);

    const defectHandler = makeShellAuthenticationApiRuntime(authenticationLayer, {
      ...issuerDependencies,
      generateJti: Effect.die(new Error('deliberate gateway test defect')),
    }).createHandler();
    handlers.push(defectHandler);
    const defectResponse = await defectHandler.handler(
      new Request(`${configuration.baseUrl}/auth/gateway-context`, {
        body: JSON.stringify({ audience: 'inventory-stock' }),
        headers: new Headers({
          'content-type': 'application/json',
          cookie: cookieHeader(signedInCookies),
          origin: configuration.baseUrl,
          'x-correlation-id': 'integration-correlation-id',
        }),
        method: 'POST',
      }),
    );
    assert.equal(defectResponse.status, 500);
    assert.match(defectResponse.headers.get('content-type') ?? '', /application\/problem\+json/u);
    const defectProblem = (await defectResponse.json()) as { detail?: string };
    assert.equal(defectProblem.detail, 'Gateway authentication could not complete.');
    assert.doesNotMatch(JSON.stringify(defectProblem), /deliberate gateway test defect/u);

    const stillAuthenticated = await Effect.runPromise(
      authentication.currentSession(authenticatedHeaders),
    );
    assert.equal(stillAuthenticated.identity?.principalId, principalId);

    await coreDatabase
      .update(principalAuthBindings)
      .set({ status: 'revoked' })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    const revoked = await Effect.runPromise(
      Effect.flip(authentication.currentSession(authenticatedHeaders)),
    );
    assert.equal(revoked._tag, 'OntosIdentityForbiddenError');

    await coreDatabase
      .update(principalAuthBindings)
      .set({ status: 'active' })
      .where(eq(principalAuthBindings.providerSubjectId, betterAuthUserId));
    const signOutResponse = await unavailableHandler.handler(
      new Request(`${configuration.baseUrl}/auth/sign-out`, {
        headers: authenticatedHeaders,
        method: 'POST',
      }),
    );
    assert.equal(signOutResponse.status, 200);
    const signedOutCookies = signOutResponse.headers.getSetCookie();
    assert.ok(signedOutCookies.length >= 3);
    assert.ok(signedOutCookies.every((header) => !header.includes(password)));

    const anonymous = await Effect.runPromise(
      authentication.currentSession(
        new Headers({
          cookie: cookieHeader(signedOutCookies),
          origin: configuration.baseUrl,
        }),
      ),
    );
    assert.equal(anonymous.identity, null);
  } finally {
    await Promise.all(handlers.map(({ dispose }) => dispose()));
    await rm(generatedFixtureRoot, { force: true, recursive: true });
    await cleanup();
    await Promise.all([authPool.end(), corePool.end()]);
  }
});
