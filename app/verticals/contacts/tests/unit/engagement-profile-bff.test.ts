// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ActionResultValidationError, ActionRuntime, ReadRuntime } from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { makeContactsApiRuntime } from '../../api/index.ts';

test('authenticates before dispatch and lets Core replay committed attach without Party reads', async (context) => {
  const issuer = 'https://shell.contacts-replay.test';
  const principal = {
    authBindingId: 'e1000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:contacts-replay',
    authMethod: 'session' as const,
    principalId: 'e2000000-0000-4000-8000-000000000001',
    tenantId: 'e3000000-0000-4000-8000-000000000001',
  };
  const partyRef = {
    moduleId: 'party.registry',
    resourceId: 'e4000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party',
    tenantId: principal.tenantId,
  };
  const committedProfile = {
    archivedAt: null,
    counterpartyRef: null,
    createdAt: '2026-09-03T08:00:00.000Z',
    partyRef,
    profileRef: {
      moduleId: 'contacts.core',
      resourceId: 'e5000000-0000-4000-8000-000000000001',
      resourceType: 'contacts.core.organization-engagement-profile',
      tenantId: principal.tenantId,
    },
    updatedAt: '2026-09-03T08:00:00.000Z',
  };
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = await exportJWK(publicKey);
  const token = await new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'contacts-replay', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('contacts')
    .setSubject(principal.principalId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(privateKey);
  const environment = {
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'contacts-replay', use: 'sig' }],
    }),
  };
  let invocations = 0;
  let networkCalls = 0;
  context.mock.method(globalThis, 'fetch', () => {
    networkCalls += 1;
    return Promise.reject(new Error('Committed replay must not call Party Registry'));
  });
  const actionRuntime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('Commit resolution is not used by this fixture'),
    runAction: (input) => {
      invocations += 1;
      assert.deepEqual(input.transport, {
        correlationId: 'replay-correlation',
        idempotencyKey: 'committed-attach',
      });
      return Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(
        committedProfile,
      ).pipe(
        Effect.mapError(
          () =>
            new ActionResultValidationError({
              code: 'action_result_invalid',
              reason: 'Invalid committed fixture',
            }),
        ),
      );
    },
  };
  const runtime = makeContactsApiRuntime(
    Layer.succeed(ActionRuntime, actionRuntime),
    Layer.succeed(ReadRuntime, { runRead: () => Effect.die('Read is not used by this fixture') }),
    ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
  ).createHandler();
  const request = (authorization?: string) => {
    const headers = new Headers({
      'content-type': 'application/json',
      'idempotency-key': 'committed-attach',
      'x-correlation-id': 'replay-correlation',
    });
    if (authorization !== undefined) {
      headers.set('authorization', authorization);
    }
    return new Request('https://contacts.example/contacts/engagement/organizations/attach', {
      body: JSON.stringify({ partyRef }),
      headers,
      method: 'POST',
    });
  };
  try {
    const unauthenticated = await runtime.handler(request());
    assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());
    assert.equal(invocations, 0);
    const replay = await runtime.handler(request(`Bearer ${token}`));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), committedProfile);
    assert.equal(invocations, 1);
    assert.equal(networkCalls, 0);
  } finally {
    await runtime.dispose();
  }
});
