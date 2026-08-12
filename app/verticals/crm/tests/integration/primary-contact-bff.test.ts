/* eslint-disable max-lines, no-await-in-loop, no-promise-executor-return, node/no-process-env, promise/avoid-new, promise/no-multiple-resolved, promise/prefer-await-to-callbacks, typescript/no-explicit-any, typescript/no-non-null-assertion, unicorn/no-await-expression-member, unicorn/switch-case-braces -- One sequential strict HTTP fixture exercises the complete generated primary-contact transport and callback-only Node server lifecycle. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  ActionAlreadyCommitted,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionRequestHashConflict,
  ActionRuntime,
  OperationContextDenied,
  ReadRuntime,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { changeCustomerPrimaryContactActionApiLive } from '../../api/change-customer-primary-contact-action-server.ts';
import { contactDetailReadApiLive } from '../../api/contact-detail-read-server.ts';
import { createContactActionApiLive } from '../../api/create-contact-action-server.ts';
import { createCustomerActionApiLive } from '../../api/create-customer-action-server.ts';
import { customerDetailReadApiLive } from '../../api/customer-detail-read-server.ts';
import { customerDirectoryReadApiLive } from '../../api/customer-directory-read-server.ts';
import { customerTimelineReadApiLive } from '../../api/customer-timeline-read-server.ts';
import { dealDetailReadApiLive } from '../../api/deal-detail-read-server.ts';
import { deleteContactActionApiLive } from '../../api/delete-contact-action-server.ts';
import { deleteCustomerActionApiLive } from '../../api/delete-customer-action-server.ts';
import { editContactActionApiLive } from '../../api/edit-contact-action-server.ts';
import { editCustomerActionApiLive } from '../../api/edit-customer-action-server.ts';
import { crmApi } from '../../shared/api.ts';
import {
  ChangeCustomerPrimaryContactConflict,
  ChangeCustomerPrimaryContactNotFound,
  ChangeCustomerPrimaryContactRejected,
  ChangeCustomerPrimaryContactUnavailable,
} from '../../src/actions/change-customer-primary-contact.action.ts';
import { executeChangeCustomerPrimaryContactActionWithAuthorization } from '../../src/api/change-customer-primary-contact-action-client.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

type ActionMode =
  | 'already_committed'
  | 'conflict'
  | 'defect'
  | 'denied'
  | 'hash_conflict'
  | 'not_found'
  | 'permission_check'
  | 'rejected'
  | 'success'
  | 'unavailable';

const customerId = '10000000-0000-4000-8000-000000000001';
const selectedContactId = '20000000-0000-4000-8000-000000000001';
const payload = {
  customerId,
  expectedCurrentPrimaryContactId: null,
  expectedCurrentPrimaryContactVersion: null,
  expectedCustomerVersion: 1,
  expectedSelectedContactVersion: 1,
  selectedContactId,
} as const;
const result = {
  changedAt: '2026-08-12T10:00:00.000Z',
  customerId,
  customerVersion: 2,
  previousPrimaryContactId: null,
  previousPrimaryContactVersion: null,
  primaryContactId: selectedContactId,
  primaryContactVersion: 2,
} as const;

const foundationLive = HttpApiBuilder.group(crmApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: ultramodernApiMarker,
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }),
  ),
);

const makeAuthorizationFixture = async () => {
  const issuer = 'https://shell.primary-contact-bff.test';
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'primary-contact-bff-test',
    use: 'sig',
  };
  const issue = (principal: TrustedPrincipalContext) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'primary-contact-bff-test', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience('crm')
      .setSubject(principal.principalId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(privateKey);
  };
  return { issue, issuer, jwks: JSON.stringify({ keys: [publicJwk] }) };
};

test('maps every primary Contact outcome and decodes the generated Effect client', async () => {
  const authorizationFixture = await makeAuthorizationFixture();
  const previousIssuer = process.env['ONTOS_GATEWAY_ISSUER'];
  const previousJwks = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
  process.env['ONTOS_GATEWAY_ISSUER'] = authorizationFixture.issuer;
  process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = authorizationFixture.jwks;
  let mode: ActionMode = 'success';
  let lastPayload: unknown;
  const actionRuntime = {
    resolveActionCommit: () => Effect.die('Unused test seam'),
    runAction: (input: {
      readonly payload: unknown;
      readonly principal: TrustedPrincipalContext;
    }) => {
      lastPayload = input.payload;
      if (input.principal.legalEntityId === undefined) {
        return Effect.fail(
          new OperationContextDenied({
            code: 'operation_context_denied',
            reason: 'Selected Legal Entity required',
          }),
        );
      }
      // eslint-disable-next-line default-case -- The closed test mode union makes this switch exhaustive.
      switch (mode) {
        case 'already_committed':
          return Effect.fail(
            new ActionAlreadyCommitted({
              code: 'action_already_committed',
              reason: 'Already committed',
            }),
          );
        case 'conflict':
          return Effect.fail(
            new ChangeCustomerPrimaryContactConflict({
              code: 'action_conflict',
              reason: 'Concurrent change',
            }),
          );
        case 'defect':
          return Effect.die(new Error('secret primary Contact database detail'));
        case 'denied':
          return Effect.fail(
            new ActionPermissionDenied({
              code: 'action_permission_denied',
              reason: 'Denied',
            }),
          );
        case 'hash_conflict':
          return Effect.fail(
            new ActionRequestHashConflict({
              code: 'action_request_hash_conflict',
              reason: 'Hash conflict',
            }),
          );
        case 'not_found':
          return Effect.fail(
            new ChangeCustomerPrimaryContactNotFound({
              code: 'action_target_not_found',
              reason: 'Not found',
            }),
          );
        case 'permission_check':
          return Effect.fail(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'Permission service unavailable',
            }),
          );
        case 'rejected':
          return Effect.fail(
            new ChangeCustomerPrimaryContactRejected({
              code: 'action_semantically_rejected',
              reason: 'Ineligible',
            }),
          );
        case 'success':
          return Effect.succeed(result);
        case 'unavailable':
          return Effect.fail(
            new ChangeCustomerPrimaryContactUnavailable({
              code: 'primary_contact_persistence_unavailable',
              reason: 'Unavailable',
            }),
          );
      }
    },
  };
  const readRuntime = {
    runRead: () => Effect.die('Unused primary Contact BFF read seam'),
  };
  const layer = HttpApiBuilder.layer(crmApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        foundationLive,
        changeCustomerPrimaryContactActionApiLive,
        contactDetailReadApiLive,
        createContactActionApiLive,
        createCustomerActionApiLive,
        customerDetailReadApiLive,
        customerDirectoryReadApiLive,
        customerTimelineReadApiLive,
        dealDetailReadApiLive,
        deleteContactActionApiLive,
        deleteCustomerActionApiLive,
        editContactActionApiLive,
        editCustomerActionApiLive,
      ),
    ),
    Layer.provide(Layer.succeed(ReadRuntime, readRuntime as never)),
    Layer.provide(Layer.succeed(ActionRuntime, actionRuntime as never)),
  );
  const bff = defineEffectBff({ api: crmApi as never, layer: layer as never });
  const handler = bff.createHandler();
  const principal = {
    authBindingId: '30000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:primary-contact-bff-test',
    authMethod: 'session' as const,
    legalEntityId: '40000000-0000-4000-8000-000000000001',
    principalId: '50000000-0000-4000-8000-000000000001',
    tenantId: '60000000-0000-4000-8000-000000000001',
  };
  const authorization = `Bearer ${await authorizationFixture.issue(principal)}`;
  const request = (body: unknown, bearer = authorization) =>
    handler.handler(
      new Request('http://primary-contact-bff.test/actions/change-customer-primary-contact', {
        body: JSON.stringify(body),
        headers: {
          authorization: bearer,
          'content-type': 'application/json',
          'x-correlation-id': randomUUID(),
          'x-idempotency-key': randomUUID(),
        },
        method: 'POST',
      }),
    );

  let server: ReturnType<typeof createServer> | undefined;
  try {
    assert.equal((await request({ ...payload, customerId: 'invalid' })).status, 400);
    const unauthenticated = await request(payload, '');
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('www-authenticate'), 'Bearer');

    const accepted = await request({
      ...payload,
      legalEntityId: 'forbidden',
      tenantId: 'forbidden',
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(lastPayload, payload);

    const noLegalEntity = { ...principal, legalEntityId: undefined };
    const noLegalEntityAuthorization = `Bearer ${await authorizationFixture.issue(noLegalEntity)}`;
    assert.equal((await request(payload, noLegalEntityAuthorization)).status, 403);

    for (const [nextMode, status] of [
      ['denied', 403],
      ['not_found', 404],
      ['conflict', 409],
      ['already_committed', 409],
      ['hash_conflict', 409],
      ['rejected', 422],
      ['permission_check', 503],
      ['unavailable', 503],
      ['defect', 500],
    ] as const) {
      mode = nextMode;
      const response = await request(payload);
      assert.equal(response.status, status);
      const body = await response.text();
      assert.doesNotMatch(body, /secret|database detail/iu);
      if (status === 503) {
        assert.equal((JSON.parse(body) as Record<string, unknown>)['retryable'], true);
      }
    }

    mode = 'success';
    server = createServer(async (incoming, outgoing) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(',') : value);
        }
      }
      const response = await handler.handler(
        new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
          body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
          headers,
          method: incoming.method,
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(
      await Effect.runPromise(
        executeChangeCustomerPrimaryContactActionWithAuthorization(payload, authorization, {
          baseUrl,
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ),
      result,
    );

    mode = 'conflict';
    const decodedConflict = await Effect.runPromise(
      Effect.flip(
        executeChangeCustomerPrimaryContactActionWithAuthorization(payload, authorization, {
          baseUrl,
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    assert.equal(
      (decodedConflict as { readonly _tag?: string })._tag,
      'ChangeCustomerPrimaryContactConflictProblem',
    );
  } finally {
    await handler.dispose();
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    if (previousIssuer === undefined) {
      delete process.env['ONTOS_GATEWAY_ISSUER'];
    } else {
      process.env['ONTOS_GATEWAY_ISSUER'] = previousIssuer;
    }
    if (previousJwks === undefined) {
      delete process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
    } else {
      process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = previousJwks;
    }
  }
});
