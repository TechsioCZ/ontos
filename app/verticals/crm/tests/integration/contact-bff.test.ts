/* eslint-disable max-lines, no-await-in-loop, no-promise-executor-return, node/no-process-env, promise/avoid-new, promise/no-multiple-resolved, promise/prefer-await-to-callbacks, typescript/no-explicit-any, typescript/no-non-null-assertion, unicorn/no-await-expression-member -- One deliberately sequential strict HTTP fixture switches fake runtime outcomes while exercising every generated CRM group and Node's callback-only server lifecycle. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off processEnv:off
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  ActionPermissionDenied,
  ActionRuntime,
  OperationContextDenied,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadRuntime,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
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
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { crmApi } from '../../shared/api.ts';
import {
  CreateContactConflict,
  CreateContactNotFound,
  CreateContactRejected,
  CreateContactUnavailable,
} from '../../src/actions/create-contact.action.ts';
import { executeContactDetailWithAuthorization } from '../../src/api/contact-detail-client.ts';
import { executeCreateContactActionWithAuthorization } from '../../src/api/create-contact-action-client.ts';
import { executeCustomerDirectoryWithAuthorization } from '../../src/api/customer-directory-client.ts';

type ActionMode =
  | 'conflict'
  | 'defect'
  | 'denied'
  | 'not_found'
  | 'rejected'
  | 'success'
  | 'unavailable';
type ReadMode = 'defect' | 'denied' | 'not_found' | 'success' | 'unavailable';

const contactId = '20000000-0000-4000-8000-000000000001';
const customerId = '10000000-0000-4000-8000-000000000001';
const contact = {
  contactId,
  createdAt: '2026-08-11T10:00:00.000Z',
  customerId,
  customerLabel: 'Acme',
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  firstName: 'Ada',
  isPrimaryContact: false,
  jobTitle: 'Engineer',
  lastName: 'Lovelace',
  phone: null,
  updatedAt: '2026-08-11T10:00:00.000Z',
  version: 1,
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
  const issuer = 'https://shell.contact-bff.test';
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'contact-bff-test',
    use: 'sig',
  };
  const issue = (principal: TrustedPrincipalContext) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'contact-bff-test', typ: 'JWT' })
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

const responseJson = (response: Response) => response.json() as Promise<Record<string, unknown>>;

test('serves strict Contact Action/read problems and decodes the generated Effect client', async () => {
  const authorizationFixture = await makeAuthorizationFixture();
  const previousIssuer = process.env['ONTOS_GATEWAY_ISSUER'];
  const previousJwks = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
  process.env['ONTOS_GATEWAY_ISSUER'] = authorizationFixture.issuer;
  process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = authorizationFixture.jwks;
  let actionMode: ActionMode = 'success';
  let readMode: ReadMode = 'success';
  let lastActionPayload: unknown;
  const actionRuntime = {
    resolveActionCommit: () => Effect.die('Unused test seam'),
    runAction: (input: { readonly payload: unknown }) => {
      lastActionPayload = input.payload;
      // eslint-disable-next-line default-case -- The closed test mode union makes this switch exhaustive.
      switch (actionMode) {
        case 'conflict': {
          return Effect.fail(
            new CreateContactConflict({ code: 'action_conflict', reason: 'Test conflict' }),
          );
        }
        case 'defect': {
          return Effect.die(new Error('secret database detail'));
        }
        case 'denied': {
          return Effect.fail(
            new ActionPermissionDenied({
              code: 'action_permission_denied',
              reason: 'Test denial',
            }),
          );
        }
        case 'not_found': {
          return Effect.fail(
            new CreateContactNotFound({
              code: 'action_target_not_found',
              reason: 'Test absence',
            }),
          );
        }
        case 'rejected': {
          return Effect.fail(
            new CreateContactRejected({
              code: 'action_semantically_rejected',
              reason: 'Test rejection',
            }),
          );
        }
        case 'success': {
          return Effect.succeed(contact);
        }
        case 'unavailable': {
          return Effect.fail(
            new CreateContactUnavailable({
              code: 'contact_persistence_unavailable',
              reason: 'Test unavailable',
            }),
          );
        }
      }
    },
  };
  const readRuntime = {
    runRead: (input: {
      readonly principal: TrustedPrincipalContext;
      readonly registration: { readonly descriptor: { readonly readKey: string } };
    }) => {
      if (input.principal.legalEntityId === undefined) {
        return Effect.fail(
          new OperationContextDenied({
            code: 'operation_context_denied',
            reason: 'Selected Legal Entity required',
          }),
        );
      }
      // eslint-disable-next-line default-case -- The closed test mode union makes this switch exhaustive.
      switch (readMode) {
        case 'defect': {
          return Effect.die(new Error('secret read database detail'));
        }
        case 'denied': {
          return Effect.fail(
            new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Test denial' }),
          );
        }
        case 'not_found': {
          return Effect.fail(
            new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'Test absence' }),
          );
        }
        case 'unavailable': {
          return Effect.fail(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'Test unavailable',
            }),
          );
        }
        case 'success': {
          switch (input.registration.descriptor.readKey) {
            case 'crm.core.api.contact-detail': {
              return Effect.succeed({
                fields: [{ label: 'Customer', value: 'Acme' }],
                title: contact.displayName,
              });
            }
            case 'crm.core.api.customer-directory.contact-detail': {
              return Effect.succeed({ contact, operation: 'contact_detail' as const });
            }
            case 'crm.core.api.customer-directory.contacts': {
              return Effect.succeed({
                customerId,
                customerLabel: 'Acme',
                items: [contact],
                nextCursor: null,
                operation: 'contacts' as const,
              });
            }
            default: {
              return Effect.die('Unexpected read registration in Contact BFF test');
            }
          }
        }
      }
    },
  };
  const layer = HttpApiBuilder.layer(crmApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        foundationLive,
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
    authContextRef: 'better-auth-session:contact-bff-test',
    authMethod: 'session' as const,
    legalEntityId: '40000000-0000-4000-8000-000000000001',
    principalId: '50000000-0000-4000-8000-000000000001',
    tenantId: '60000000-0000-4000-8000-000000000001',
  };
  const authorization = `Bearer ${await authorizationFixture.issue(principal)}`;
  const request = (path: string, payload: unknown, bearer = authorization) =>
    handler.handler(
      new Request(`http://contact-bff.test${path}`, {
        body: JSON.stringify(payload),
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
    const invalid = await request('/actions/create-contact', {
      customerId: 'not-a-uuid',
      firstName: 'Ada',
    });
    assert.equal(invalid.status, 400);

    const unauthenticated = await request(
      '/actions/create-contact',
      { customerId, firstName: 'Ada' },
      '',
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('www-authenticate'), 'Bearer');

    const extraProperty = await request('/actions/create-contact', {
      customerId,
      firstName: 'Ada',
      isPrimaryContact: true,
    });
    assert.equal(extraProperty.status, 200);
    assert.deepEqual(lastActionPayload, { customerId, firstName: 'Ada' });

    for (const [mode, status] of [
      ['denied', 403],
      ['not_found', 404],
      ['conflict', 409],
      ['rejected', 422],
      ['unavailable', 503],
      ['defect', 500],
    ] as const) {
      actionMode = mode;
      const response = await request('/actions/create-contact', { customerId, firstName: 'Ada' });
      assert.equal(response.status, status);
      const body = await responseJson(response);
      assert.doesNotMatch(JSON.stringify(body), /secret|database detail/iu);
      if (status === 503) {
        assert.equal(body['retryable'], true);
      }
    }

    actionMode = 'success';
    for (const [payload, expected] of [
      [{ customerId, limit: 10, operation: 'contacts' }, 'contacts'],
      [{ contactId, operation: 'contact_detail' }, 'contact_detail'],
    ] as const) {
      const response = await request('/reads/customer-directory', payload);
      assert.equal(response.status, 200);
      assert.equal((await responseJson(response))['operation'], expected);
    }
    const resourceDetail = await request('/reads/contact-detail', {
      moduleId: 'crm.core',
      resourceId: contactId,
      resourceType: 'crm.core.contact',
    });
    assert.equal(resourceDetail.status, 200);
    assert.equal((await responseJson(resourceDetail))['title'], 'Ada Lovelace');

    const noLegalEntity = { ...principal, legalEntityId: undefined };
    const noLegalEntityAuthorization = `Bearer ${await authorizationFixture.issue(noLegalEntity)}`;
    assert.equal(
      (
        await request(
          '/reads/customer-directory',
          { customerId, limit: 10, operation: 'contacts' },
          noLegalEntityAuthorization,
        )
      ).status,
      403,
    );
    for (const [mode, status] of [
      ['denied', 403],
      ['not_found', 404],
      ['unavailable', 503],
      ['defect', 500],
    ] as const) {
      readMode = mode;
      const response = await request('/reads/contact-detail', {
        moduleId: 'crm.core',
        resourceId: contactId,
        resourceType: 'crm.core.contact',
      });
      assert.equal(response.status, status);
      assert.doesNotMatch(await response.text(), /secret|database detail/iu);
    }

    readMode = 'success';
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
    const clientResult = await Effect.runPromise(
      executeCreateContactActionWithAuthorization({ customerId, firstName: 'Ada' }, authorization, {
        baseUrl,
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    assert.deepEqual(clientResult, contact);

    actionMode = 'conflict';
    const decodedConflict = await Effect.runPromise(
      Effect.flip(
        executeCreateContactActionWithAuthorization(
          { customerId, firstName: 'Ada' },
          authorization,
          {
            baseUrl: `http://127.0.0.1:${address.port}`,
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
          },
        ),
      ),
    );
    assert.equal(
      (decodedConflict as { readonly _tag?: string })._tag,
      'CreateContactConflictProblem',
    );

    readMode = 'success';
    const decodedContacts = await Effect.runPromise(
      executeCustomerDirectoryWithAuthorization(
        { customerId, limit: 10, operation: 'contacts' },
        authorization,
        randomUUID(),
        baseUrl,
      ),
    );
    assert.equal(decodedContacts.operation, 'contacts');
    assert.deepEqual(decodedContacts.items, [contact]);
    const decodedResourceDetail = await Effect.runPromise(
      executeContactDetailWithAuthorization(
        { moduleId: 'crm.core', resourceId: contactId, resourceType: 'crm.core.contact' },
        authorization,
        randomUUID(),
        baseUrl,
      ),
    );
    assert.equal(decodedResourceDetail.title, contact.displayName);

    readMode = 'not_found';
    const decodedReadNotFound = await Effect.runPromise(
      Effect.flip(
        executeCustomerDirectoryWithAuthorization(
          { contactId, operation: 'contact_detail' },
          authorization,
          randomUUID(),
          baseUrl,
        ),
      ),
    );
    assert.equal(
      (decodedReadNotFound as { readonly _tag?: string })._tag,
      'CustomerDirectoryNotFoundProblem',
    );

    readMode = 'unavailable';
    const decodedReadUnavailable = await Effect.runPromise(
      Effect.flip(
        executeContactDetailWithAuthorization(
          { moduleId: 'crm.core', resourceId: contactId, resourceType: 'crm.core.contact' },
          authorization,
          randomUUID(),
          baseUrl,
        ),
      ),
    );
    assert.equal(
      (decodedReadUnavailable as { readonly _tag?: string })._tag,
      'ContactDetailUnavailableProblem',
    );
    assert.equal((decodedReadUnavailable as { readonly retryable?: boolean }).retryable, true);
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
