/* eslint-disable no-promise-executor-return, promise/avoid-new, promise/no-multiple-resolved, promise/prefer-await-to-callbacks -- Node HTTP lifecycle callbacks are adapted once at the test boundary. */
// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off globalDate:off newPromise:off nodeBuiltinImport:off processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  ActionIdempotencyKeyRequired,
  ActionPermissionDenied,
  ActionRuntime,
  ReadEvidencePersistenceError,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { Effect, Layer } from '@modern-js/plugin-bff/effect-edge';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { makeCrmApiRuntime } from '../../api/index.ts';
import { CrmCustomerNotFound, CrmLifecycleConflict } from '../../shared/apis/customer-detail.ts';
import {
  archiveContact,
  archiveCustomer,
  createContact,
  createCustomer,
  editContact,
  editCustomer,
  getContact,
  getContactList,
  getCustomerDetail,
  getCustomerList,
  unarchiveContact,
  unarchiveCustomer,
} from '../../src/api/crm-client.ts';

const principal = {
  authBindingId: 'b1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:bff-integration',
  authMethod: 'session' as const,
  principalId: 'b2000000-0000-4000-8000-000000000001',
  tenantId: 'b3000000-0000-4000-8000-000000000001',
};
const customerId = 'b4000000-0000-4000-8000-000000000001';
const contactId = 'b5000000-0000-4000-8000-000000000001';
const missingId = 'b6000000-0000-4000-8000-000000000001';
const conflictId = 'b7000000-0000-4000-8000-000000000001';
const timestamp = '2026-08-14T10:00:00.000Z';
const customer = {
  archivedAt: null,
  createdAt: timestamp,
  customerId,
  name: 'Acme',
  updatedAt: timestamp,
};
const contact = {
  archivedAt: null,
  contactId,
  createdAt: timestamp,
  customerId,
  email: 'ada@example.test',
  name: 'Ada',
  phone: '+420 123',
  updatedAt: timestamp,
};

interface CapturedInvocation {
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly key: string;
  readonly traceId?: string;
}

const startServer = async (
  handler: { readonly handler: (request: Request) => Promise<Response> },
  assertion: string,
  onGatewayIssue: () => void,
) => {
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const url = `http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`;
    if (new URL(url).pathname === '/auth/gateway-context') {
      onGatewayIssue();
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({ expiresAt: Math.floor(Date.now() / 1000) + 300, token: assertion }),
      );
      return;
    }
    const webResponse = await handler.handler(
      new Request(url, {
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        headers: request.headers as HeadersInit,
        method: request.method ?? 'GET',
      }),
    );
    response.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers) {
      response.setHeader(key, value);
    }
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
};

test('runs every CRM client operation through the real governed BFF boundary', async () => {
  const previousIssuer = process.env['ONTOS_GATEWAY_ISSUER'];
  const previousJwks = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
  const issuer = 'https://shell.crm-bff.test';
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'crm-bff', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('crm')
    .setSubject(principal.principalId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(randomUUID())
    .sign(privateKey);
  process.env['ONTOS_GATEWAY_ISSUER'] = issuer;
  process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = JSON.stringify({
    keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'crm-bff', use: 'sig' }],
  });

  const invocations: CapturedInvocation[] = [];
  const actionRuntime = {
    resolveActionCommit: () => Effect.die('resolveActionCommit is not used by this BFF'),
    runAction: (input: {
      readonly payload: Readonly<Record<string, unknown>>;
      readonly registration: { readonly descriptor: { readonly actionKey: string } };
      readonly transport: {
        readonly correlationId: string;
        readonly idempotencyKey?: string;
        readonly traceId?: string;
      };
    }) => {
      const key = input.registration.descriptor.actionKey;
      invocations.push({ key, ...input.transport });
      if (input.transport.idempotencyKey === undefined) {
        return Effect.fail(
          new ActionIdempotencyKeyRequired({
            code: 'action_idempotency_key_required',
            reason: 'An idempotency key is required',
          }),
        );
      }
      if (input.payload['name'] === 'trigger-defect') {
        return Effect.die(new Error('secret persistence detail'));
      }
      if (input.payload['name'] === 'trigger-forbidden') {
        return Effect.fail(
          new ActionPermissionDenied({
            code: 'action_permission_denied',
            reason: 'The principal is not permitted to run this action',
          }),
        );
      }
      if (key.endsWith('edit-customer') && input.payload['customerId'] === missingId) {
        return Effect.fail(
          new CrmCustomerNotFound({
            code: 'crm_customer_not_found',
            customerId: missingId,
            reason: 'The requested Customer does not exist',
          }),
        );
      }
      if (key.endsWith('archive-customer') && input.payload['customerId'] === conflictId) {
        return Effect.fail(
          new CrmLifecycleConflict({
            code: 'crm_lifecycle_conflict',
            reason: 'The Customer is already archived',
            requestedState: 'archived',
            resourceId: conflictId,
            resourceType: 'customer',
          }),
        );
      }
      if (key.endsWith('contact')) {
        return Effect.succeed(contact);
      }
      return Effect.succeed(customer);
    },
  } as unknown as ActionRuntimeService;
  const readRuntime = {
    runRead: (input: {
      readonly input: Readonly<Record<string, unknown>>;
      readonly registration: { readonly descriptor: { readonly readKey: string } };
      readonly transport: { readonly correlationId: string };
    }) => {
      const key = input.registration.descriptor.readKey;
      invocations.push({ key, ...input.transport });
      if (input.input['customerId'] === missingId) {
        return Effect.fail(
          new ReadEvidencePersistenceError({
            code: 'read_evidence_persistence_failed',
            reason: 'simulated evidence outage',
          }),
        );
      }
      if (key.endsWith('customer-detail')) {
        return Effect.succeed(customer);
      }
      if (key.endsWith('customer-list')) {
        return Effect.succeed({ items: [customer], nextOffset: null });
      }
      if (key.endsWith('contact-detail')) {
        return Effect.succeed(contact);
      }
      return Effect.succeed({ items: [contact], nextOffset: null });
    },
  } as unknown as ReadRuntimeService;
  const runtime = makeCrmApiRuntime(
    Layer.succeed(ActionRuntime, actionRuntime),
    Layer.succeed(ReadRuntime, readRuntime),
  );
  const handler = runtime.createHandler();
  let gatewayIssues = 0;
  const server = await startServer(handler, assertion, () => {
    gatewayIssues += 1;
  });

  try {
    const base = {
      baseUrl: server.baseUrl,
      correlationId: 'crm-bff-correlation',
      gateway: { baseUrl: server.baseUrl },
      traceId: 'crm-bff-trace',
    } as const;
    const mutation = { ...base, idempotencyKey: 'crm-bff-idempotency' };
    const results = await Promise.all([
      Effect.runPromise(createCustomer({ name: 'Acme' }, mutation)),
      Effect.runPromise(editCustomer({ customerId, name: 'Acme' }, mutation)),
      Effect.runPromise(archiveCustomer({ customerId }, mutation)),
      Effect.runPromise(unarchiveCustomer({ customerId }, mutation)),
      Effect.runPromise(
        createContact(
          { customerId, email: contact.email, name: contact.name, phone: contact.phone },
          mutation,
        ),
      ),
      Effect.runPromise(
        editContact(
          { contactId, email: contact.email, name: contact.name, phone: contact.phone },
          mutation,
        ),
      ),
      Effect.runPromise(archiveContact({ contactId }, mutation)),
      Effect.runPromise(unarchiveContact({ contactId }, mutation)),
      Effect.runPromise(getCustomerDetail({ customerId }, base)),
      Effect.runPromise(getCustomerList({ limit: 10, offset: 0 }, base)),
      Effect.runPromise(getContact({ contactId }, base)),
      Effect.runPromise(getContactList({ customerId, limit: 10, offset: 0 }, base)),
    ]);
    assert.equal(results.length, 12);
    assert.equal(gatewayIssues, 12);
    assert.equal(invocations.length, 12);
    assert.ok(invocations.every((invocation) => invocation.correlationId === base.correlationId));
    assert.ok(
      invocations
        .filter(
          (invocation) =>
            invocation.key.includes('create-') ||
            invocation.key.includes('edit-') ||
            invocation.key.includes('archive-'),
        )
        .every((invocation) => invocation.idempotencyKey === mutation.idempotencyKey),
    );
    assert.ok(
      invocations
        .filter((invocation) => invocation.idempotencyKey !== undefined)
        .every((invocation) => invocation.traceId === base.traceId),
    );

    const evidenceFailure = await Effect.runPromise(
      Effect.flip(getCustomerDetail({ customerId: missingId }, base)),
    );
    assert.equal(
      (evidenceFailure as { readonly _tag: string })._tag,
      'CustomerDetailUnavailableProblem',
    );

    const defectFailure = await Effect.runPromise(
      Effect.flip(createCustomer({ name: 'trigger-defect' }, mutation)),
    );
    assert.equal((defectFailure as { readonly _tag: string })._tag, 'CrmInternalProblem');
    assert.equal(JSON.stringify(defectFailure).includes('secret persistence detail'), false);

    const forbiddenFailure = await Effect.runPromise(
      Effect.flip(createCustomer({ name: 'trigger-forbidden' }, mutation)),
    );
    assert.equal((forbiddenFailure as { readonly _tag: string })._tag, 'CrmForbiddenProblem');
    const notFoundFailure = await Effect.runPromise(
      Effect.flip(editCustomer({ customerId: missingId, name: 'Missing' }, mutation)),
    );
    assert.equal((notFoundFailure as { readonly _tag: string })._tag, 'CrmNotFoundProblem');
    const conflictFailure = await Effect.runPromise(
      Effect.flip(archiveCustomer({ customerId: conflictId }, mutation)),
    );
    assert.equal((conflictFailure as { readonly _tag: string })._tag, 'CrmConflictProblem');

    const rawValidHeaders = {
      authorization: `Bearer ${assertion}`,
      'content-type': 'application/json',
      'idempotency-key': 'raw-idempotency',
      'x-correlation-id': 'raw-correlation',
    };
    const missingAssertion = await handler.handler(
      new Request('https://crm.test/crm/customers/create', {
        body: JSON.stringify({ name: 'Acme' }),
        headers: { ...rawValidHeaders, authorization: '' },
        method: 'POST',
      }),
    );
    assert.equal(missingAssertion.status, 401);
    assert.equal(missingAssertion.headers.get('www-authenticate'), 'Bearer');
    const invalidAssertion = await handler.handler(
      new Request('https://crm.test/crm/customers/create', {
        body: JSON.stringify({ name: 'Acme' }),
        headers: { ...rawValidHeaders, authorization: 'Bearer invalid.jwt.assertion' },
        method: 'POST',
      }),
    );
    assert.equal(invalidAssertion.status, 401);
    assert.equal(invalidAssertion.headers.get('www-authenticate'), 'Bearer');

    const missingCorrelation = await handler.handler(
      new Request('https://crm.test/crm/customers/create', {
        body: JSON.stringify({ name: 'Acme' }),
        headers: { ...rawValidHeaders, 'x-correlation-id': '' },
        method: 'POST',
      }),
    );
    assert.equal(missingCorrelation.status, 400);

    const missingIdempotency = await handler.handler(
      new Request('https://crm.test/crm/customers/create', {
        body: JSON.stringify({ name: 'Acme' }),
        headers: {
          authorization: `Bearer ${assertion}`,
          'content-type': 'application/json',
          'x-correlation-id': 'raw-correlation',
        },
        method: 'POST',
      }),
    );
    assert.equal(missingIdempotency.status, 428);
  } finally {
    await server.close();
    await handler.dispose();
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
