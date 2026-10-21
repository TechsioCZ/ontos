import type { ConnectionDescription } from '@app/shared-contracts/oauth-connections';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

import { connectorProblemStatus } from '../../../api/oauth-connections/connector-http.ts';
import {
  type ConnectorDeps,
  authenticateConnector,
  bearerOf,
  connectorKeyMatches,
  connectorPrincipalContext,
  makeAccessTokenVerifier,
} from '../../../api/oauth-connections/connector-service.ts';
import type { LiveConnection } from '../../../api/oauth-connections/connection-service.ts';
import {
  ConnectionForbidden,
  ConnectionUnauthorized,
  ConnectionUnavailable,
} from '../../../api/oauth-connections/errors.ts';
import type { OAuthServerConfig } from '../../../api/oauth-connections/server-config.ts';
import { GatewayIssuerError } from '../../../api/auth/gateway-issuer.ts';
import type { GrantRow } from '../../../api/oauth-connections/types.ts';

type SigningKey = Parameters<SignJWT['sign']>[0];

const config: OAuthServerConfig = {
  connectorSecret: 's'.repeat(32),
  issuer: 'http://localhost:3020/shell-super-app-api/oauth',
  resource: 'http://localhost:3090/mcp',
};

const grant = (overrides: Partial<GrantRow>): GrantRow => ({
  actingKind: 'human',
  actingPrincipalId: 'p-user',
  authBindingId: 'b-1',
  clientHost: 'claude.ai',
  clientId: 'https://claude.ai/oauth/mcp-client.json',
  clientKind: 'cimd',
  clientLogoUri: null,
  clientName: 'Claude',
  consentId: null,
  consentedAt: null,
  createdAt: new Date(0),
  grantId: 'g-active',
  lastUsedAt: null,
  legalEntityId: 'le-1',
  modules: 'all',
  profileId: 'prof-1',
  revokeReason: null,
  revokedAt: null,
  revokedByPrincipalId: null,
  sessionId: null,
  status: 'active',
  tenantId: 't-1',
  userId: 'u-1',
  userPrincipalId: 'p-user',
  writePolicy: 'approval',
  ...overrides,
});

const description = (overrides: Partial<ConnectionDescription> = {}): ConnectionDescription => ({
  acting: { displayName: 'Jan', kind: 'human', principalId: 'p-user' },
  client: {
    clientId: 'https://claude.ai/oauth/mcp-client.json',
    host: 'claude.ai',
    kind: 'cimd',
    logoUri: null,
    name: 'Claude',
  },
  compositionRevision: 'a'.repeat(64),
  delegatedBy: null,
  grantId: 'g-active',
  legalEntityId: 'le-1',
  legalName: 'Firma s.r.o.',
  modules: [
    { label: 'CRM', moduleId: 'demo.crm', read: true, write: true },
    { label: 'Sklad', moduleId: 'demo.sales', read: true, write: false },
  ],
  profileId: 'prof-1',
  status: 'active',
  tenantId: 't-1',
  writePolicy: 'approval',
  ...overrides,
});

const humanLive: LiveConnection = { description: description(), grant: grant({}) };

const agentLive: LiveConnection = {
  description: description({
    acting: { displayName: 'Agent', kind: 'agent', principalId: 'p-agent' },
    delegatedBy: { displayName: 'Jan', principalId: 'p-user' },
    grantId: 'g-agent',
  }),
  grant: grant({ actingKind: 'agent', actingPrincipalId: 'p-agent', grantId: 'g-agent' }),
};

const setup = () =>
  Effect.promise(async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid: 'k1' };
    return { jwks: createLocalJWKSet({ keys: [jwk] }), privateKey: privateKey as SigningKey };
  });

const sign = (
  privateKey: SigningKey,
  claims: { readonly aud?: string; readonly grant?: string; readonly iss?: string; readonly scope?: string; readonly sub?: string },
) =>
  new SignJWT({ 'https://ontos.cz/grant': claims.grant ?? 'g-active', scope: claims.scope ?? 'openid ontos' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setIssuer(claims.iss ?? config.issuer)
    .setAudience(claims.aud ?? config.resource)
    .setSubject(claims.sub ?? 'u-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

const depsFor = (jwks: Parameters<typeof makeAccessTokenVerifier>[1], cfg: OAuthServerConfig = config): ConnectorDeps<never> => ({
  config: cfg,
  loadLive: (grantId) => {
    if (grantId === 'g-active') {
      return Effect.succeed(humanLive);
    }
    if (grantId === 'g-agent') {
      return Effect.fail(new ConnectionUnauthorized({ code: 'operator_removed' }));
    }
    return Effect.fail(new ConnectionUnauthorized({ code: 'grant_inactive' }));
  },
  verifyAccessToken: makeAccessTokenVerifier(cfg, jwks),
});

const headersWith = (token: string | undefined, key: string | undefined = config.connectorSecret) => ({
  ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  ...(key === undefined ? {} : { 'x-ontos-connector-key': key }),
});

it('bearerOf reads a Bearer token only', () => {
  expect(bearerOf('Bearer abc.def')).toBe('abc.def');
  expect(bearerOf('bearer xyz')).toBe('xyz');
  expect(bearerOf('Basic abc')).toBeUndefined();
  expect(bearerOf(undefined)).toBeUndefined();
});

it('connectorKeyMatches compares the shared key and refuses short or missing secrets', () => {
  expect(connectorKeyMatches('s'.repeat(32), 's'.repeat(32))).toBe(true);
  expect(connectorKeyMatches('s'.repeat(32), 'x'.repeat(32))).toBe(false);
  expect(connectorKeyMatches('s'.repeat(32), undefined)).toBe(false);
  expect(connectorKeyMatches('short', 'short')).toBe(false);
});

it.effect('wrong connector secret is refused with connector_key_invalid', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, {}));
    const error = yield* authenticateConnector(headersWith(token, 'x'.repeat(32)), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'connector_key_invalid' });
    expect(connectorProblemStatus(error)).toBe(401);
  }),
);

it.effect('missing bearer token is refused with token_missing', () =>
  Effect.gen(function* () {
    const { jwks } = yield* setup();
    const error = yield* authenticateConnector(headersWith(undefined), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'token_missing' });
  }),
);

it.effect('token for another audience is refused with token_invalid', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, { aud: 'http://localhost:3090/other' }));
    const error = yield* authenticateConnector(headersWith(token), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'token_invalid' });
    expect(connectorProblemStatus(error)).toBe(401);
  }),
);

it.effect('token from another issuer is refused with token_invalid', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, { iss: 'http://evil' }));
    const error = yield* authenticateConnector(headersWith(token), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'token_invalid' });
  }),
);

it.effect('token without the ontos scope is refused with token_invalid', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, { scope: 'openid' }));
    const error = yield* authenticateConnector(headersWith(token), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'token_invalid' });
  }),
);

it.effect('revoked grant is refused with grant_inactive', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, { grant: 'g-revoked' }));
    const error = yield* authenticateConnector(headersWith(token), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'grant_inactive' });
  }),
);

it.effect('agent whose operator was removed is refused with operator_removed', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, { grant: 'g-agent' }));
    const error = yield* authenticateConnector(headersWith(token), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'operator_removed' });
  }),
);

it.effect('token subject that differs from the grant user is refused with token_invalid', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, { sub: 'u-2' }));
    const error = yield* authenticateConnector(headersWith(token), depsFor(jwks)).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: 'ConnectionUnauthorized', code: 'token_invalid' });
  }),
);

it.effect('valid key and token return the live connection', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, {}));
    const live = yield* authenticateConnector(headersWith(token), depsFor(jwks));
    expect(live.description.grantId).toBe('g-active');
    expect(live.grant.userId).toBe('u-1');
  }),
);

it.effect('an unset connector secret is unavailable (503), not unauthorized', () =>
  Effect.gen(function* () {
    const { jwks, privateKey } = yield* setup();
    const token = yield* Effect.promise(() => sign(privateKey, {}));
    const error = yield* authenticateConnector(
      headersWith(token, ''),
      depsFor(jwks, { ...config, connectorSecret: '' }),
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ConnectionUnavailable);
    expect(connectorProblemStatus(error)).toBe(503);
  }),
);

it('connectorProblemStatus maps connector failures to 401, 403, 409 and 503', () => {
  expect(connectorProblemStatus(new ConnectionUnauthorized({ code: 'token_invalid' }))).toBe(401);
  expect(connectorProblemStatus(new ConnectionForbidden({ code: 'connection_scope', reason: 'x' }))).toBe(403);
  expect(connectorProblemStatus(new ConnectionUnavailable({ cause: 'db' }))).toBe(503);
  expect(
    connectorProblemStatus(
      new GatewayIssuerError({ code: 'gateway_revision_unsupported', reason: 'x', stage: 'configuration' }),
    ),
  ).toBe(409);
  expect(
    connectorProblemStatus(new GatewayIssuerError({ code: 'gateway_audience_invalid', reason: 'x', stage: 'audience' })),
  ).toBe(403);
});

it('connectorPrincipalContext of an agent is an oauth_connection delegated by the person', () => {
  const principal = connectorPrincipalContext(agentLive);
  expect(principal.authMethod).toBe('oauth_connection');
  expect(principal.authContextRef).toBe('oauth-grant:g-agent');
  expect(principal.principalId).toBe('p-agent');
  expect(principal.delegatedByPrincipalId).toBe('p-user');
  expect(principal.connection.modules).toEqual([
    { access: 'write', moduleId: 'demo.crm' },
    { access: 'read', moduleId: 'demo.sales' },
  ]);
});

it('connectorPrincipalContext of a person carries no delegation', () => {
  const principal = connectorPrincipalContext(humanLive);
  expect(principal).not.toHaveProperty('delegatedByPrincipalId');
  expect(principal.connection.writePolicy).toBe('approval');
  expect(principal.connection.clientName).toBe('Claude');
});
