/* eslint-disable no-promise-executor-return, promise/avoid-new -- Node HTTP lifecycle callbacks are adapted once at the test boundary. */
// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off globalDate:off newPromise:off nodeBuiltinImport:off processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  ActionIdempotencyKeyRequired,
  ActionPayloadValidationError,
  ActionPermissionDenied,
  ActionResultValidationError,
  ActionRuntime,
  ReadEvidencePersistenceError,
  ReadResultValidationError,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { Effect, Layer, Schema } from '@modern-js/plugin-bff/effect-edge';
import { isObject } from 'effect/Predicate';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { makeContactsApiRuntime } from '../../api/index.ts';
import { parseJsonObject } from '../support/json-value.ts';
import type { JsonObject } from '../support/json-value.ts';
import { appendRequestChunk, webRequestInit } from '../support/node-http.ts';
import {
  ContactsCustomerIcoConflict,
  ContactsCustomerNotFound,
  ContactsLifecycleConflict,
  ContactsPersistenceUnavailable,
} from '../../shared/apis/customer-detail.ts';
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
} from '../../src/api/contacts-client.ts';

const principal = {
  authBindingId: 'b1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:bff-integration',
  authMethod: 'session' as const,
  principalId: 'b2000000-0000-4000-8000-000000000001',
  tenantId: 'b3000000-0000-4000-8000-000000000001',
};
const customerId = 'b4000000-0000-4000-8000-000000000001';
const completeCustomerId = 'b4000000-0000-4000-8000-000000000002';
const contactId = 'b5000000-0000-4000-8000-000000000001';
const missingId = 'b6000000-0000-4000-8000-000000000001';
const conflictId = 'b7000000-0000-4000-8000-000000000001';
const timestamp = '2026-08-14T10:00:00.000Z';
const nullableCustomer = {
  archivedAt: null,
  createdAt: timestamp,
  customerId,
  dic: null,
  dissolvedOn: null,
  establishedOn: null,
  ico: null,
  legalFormCode: null,
  name: 'Acme',
  updatedAt: timestamp,
};
const completeCustomer = {
  ...nullableCustomer,
  customerId: completeCustomerId,
  dic: 'CZ00123456',
  dissolvedOn: '2026-08-17',
  establishedOn: '2020-01-02',
  ico: '00123456',
  legalFormCode: '112',
};
const completeEditPayload = {
  customerId,
  dic: completeCustomer.dic,
  dissolvedOn: completeCustomer.dissolvedOn,
  establishedOn: completeCustomer.establishedOn,
  ico: completeCustomer.ico,
  legalFormCode: completeCustomer.legalFormCode,
  name: 'Acme complete edit',
};
const customerPayload = (name: string) => ({
  dic: null,
  dissolvedOn: null,
  establishedOn: null,
  ico: null,
  legalFormCode: null,
  name,
});
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
  idempotencyKey?: string;
  readonly key: string;
  readonly payload?: JsonObject;
  traceId?: string;
}

const startServer = async (
  handler: { readonly handler: (request: Request) => Promise<Response> },
  issueAssertion: () => Promise<string>,
  onGatewayIssue: () => void,
) => {
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      appendRequestChunk(chunks, chunk);
    }
    const url = `http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`;
    if (new URL(url).pathname === '/auth/gateway-context') {
      onGatewayIssue();
      const assertion = await issueAssertion();
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({ expiresAt: Math.floor(Date.now() / 1000) + 300, token: assertion }),
      );
      return;
    }
    const webResponse = await handler.handler(
      new Request(url, webRequestInit(chunks, request.headers, request.method)),
    );
    response.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers) {
      response.setHeader(key, value);
    }
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(isObject(address));
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
};

test('runs every Contacts client operation through the real governed BFF boundary', async () => {
  const previousIssuer = process.env['ONTOS_GATEWAY_ISSUER'];
  const previousJwks = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
  const issuer = 'https://shell.contacts-bff.test';
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const issueAssertion = async () =>
    await new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'contacts-bff', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience('contacts')
      .setSubject(principal.principalId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(privateKey);
  const assertion = await issueAssertion();
  process.env['ONTOS_GATEWAY_ISSUER'] = issuer;
  process.env['ONTOS_GATEWAY_PUBLIC_JWKS'] = JSON.stringify({
    keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'contacts-bff', use: 'sig' }],
  });

  const invocations: CapturedInvocation[] = [];
  const actionRuntime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('resolveActionCommit is not used by this BFF'),
    runAction: (input) => {
      const key = input.registration.descriptor.actionKey;
      const payload = parseJsonObject(input.payload);
      const transport = Schema.decodeUnknownSync(
        Schema.Struct({
          correlationId: Schema.String,
          idempotencyKey: Schema.optional(Schema.String),
          traceId: Schema.optional(Schema.String),
        }),
      )(input.transport);
      const invocation: CapturedInvocation = {
        correlationId: transport.correlationId,
        key,
        payload,
      };
      if (transport.idempotencyKey !== undefined) {
        invocation.idempotencyKey = transport.idempotencyKey;
      }
      if (transport.traceId !== undefined) {
        invocation.traceId = transport.traceId;
      }
      invocations.push(invocation);
      const decodeResult = <Result>(result: Result) =>
        Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(result).pipe(
          Effect.mapError(
            () =>
              new ActionResultValidationError({
                code: 'action_result_invalid',
                reason: 'The Action fixture result does not match its declared schema',
              }),
          ),
        );
      const failDomain = <Failure>(failure: Failure) =>
        Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failure).pipe(
          Effect.mapError(
            () =>
              new ActionResultValidationError({
                code: 'action_result_invalid',
                reason: 'The Action fixture domain error does not match its declared schema',
              }),
          ),
          Effect.flatMap(Effect.fail),
        );
      if (transport.idempotencyKey === undefined) {
        return Effect.fail(
          new ActionIdempotencyKeyRequired({
            code: 'action_idempotency_key_required',
            reason: 'An idempotency key is required',
          }),
        );
      }
      if (payload['name'] === 'trigger-defect') {
        return Effect.die(new Error('secret persistence detail'));
      }
      if (payload['name'] === 'trigger-invalid') {
        return Effect.fail(
          new ActionPayloadValidationError({
            code: 'action_payload_invalid',
            reason: 'The Customer payload is invalid',
          }),
        );
      }
      if (payload['name'] === 'trigger-ico-conflict') {
        return failDomain(
          new ContactsCustomerIcoConflict({
            code: 'contacts_customer_ico_conflict',
            reason: 'A Customer with this IČO already exists',
          }),
        );
      }
      if (payload['name'] === 'trigger-unavailable') {
        return failDomain(
          new ContactsPersistenceUnavailable({
            code: 'contacts_persistence_unavailable',
            reason: 'Contacts persistence is temporarily unavailable',
          }),
        );
      }
      if (payload['name'] === 'trigger-forbidden') {
        return Effect.fail(
          new ActionPermissionDenied({
            code: 'action_permission_denied',
            reason: 'The principal is not permitted to run this action',
          }),
        );
      }
      if (key.endsWith('edit-customer') && payload['customerId'] === missingId) {
        return failDomain(
          new ContactsCustomerNotFound({
            code: 'contacts_customer_not_found',
            customerId: missingId,
            reason: 'The requested Customer does not exist',
          }),
        );
      }
      if (key.endsWith('archive-customer') && payload['customerId'] === conflictId) {
        return failDomain(
          new ContactsLifecycleConflict({
            code: 'contacts_lifecycle_conflict',
            reason: 'The Customer is already archived',
            requestedState: 'archived',
            resourceId: conflictId,
            resourceType: 'customer',
          }),
        );
      }
      if (key.endsWith('contact')) {
        return decodeResult(contact);
      }
      if (key.endsWith('edit-customer')) {
        return decodeResult({
          ...nullableCustomer,
          ...payload,
          updatedAt: timestamp,
        });
      }
      return decodeResult(nullableCustomer);
    },
  };
  const readRuntime: ReadRuntimeService = {
    runRead: (input) => {
      const key = input.registration.descriptor.readKey;
      const readInput = parseJsonObject(input.input);
      const transport = Schema.decodeUnknownSync(
        Schema.Struct({
          correlationId: Schema.String,
          traceId: Schema.optional(Schema.String),
        }),
      )(input.transport);
      const invocation: CapturedInvocation = {
        correlationId: transport.correlationId,
        key,
      };
      if (transport.traceId !== undefined) {
        invocation.traceId = transport.traceId;
      }
      invocations.push(invocation);
      const decodeResult = <Result>(result: Result) =>
        Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(result).pipe(
          Effect.mapError(
            () =>
              new ReadResultValidationError({
                code: 'read_result_invalid',
                reason: 'The Read fixture result does not match its declared schema',
              }),
          ),
        );
      if (readInput['customerId'] === missingId) {
        return Effect.fail(
          new ReadEvidencePersistenceError({
            code: 'read_evidence_persistence_failed',
            reason: 'simulated evidence outage',
          }),
        );
      }
      if (key.endsWith('customer-detail')) {
        return decodeResult(
          readInput['customerId'] === completeCustomerId ? completeCustomer : nullableCustomer,
        );
      }
      if (key.endsWith('customer-list')) {
        if (readInput['offset'] === 99) {
          return Effect.fail(
            new ReadEvidencePersistenceError({
              code: 'read_evidence_persistence_failed',
              reason: 'simulated list evidence outage',
            }),
          );
        }
        return decodeResult({ items: [completeCustomer, nullableCustomer], nextOffset: null });
      }
      if (key.endsWith('contact-detail')) {
        return decodeResult(contact);
      }
      return decodeResult({ items: [contact], nextOffset: null });
    },
  };
  const runtime = makeContactsApiRuntime(
    Layer.succeed(ActionRuntime, actionRuntime),
    Layer.succeed(ReadRuntime, readRuntime),
  );
  const handler = runtime.createHandler();
  let gatewayIssues = 0;
  const server = await startServer(handler, issueAssertion, () => {
    gatewayIssues += 1;
  });

  try {
    const base = {
      baseUrl: server.baseUrl,
      correlationId: 'contacts-bff-correlation',
      gateway: { baseUrl: server.baseUrl },
      traceId: 'contacts-bff-trace',
    } as const;
    const mutation = { ...base, idempotencyKey: 'contacts-bff-idempotency' };
    const results = await Promise.all([
      Effect.runPromise(createCustomer(customerPayload('Acme'), mutation)),
      Effect.runPromise(editCustomer(completeEditPayload, mutation)),
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
      Effect.runPromise(getCustomerDetail({ customerId: completeCustomerId }, base)),
      Effect.runPromise(getCustomerList({ limit: 10, offset: 0 }, base)),
      Effect.runPromise(getContact({ contactId }, base)),
      Effect.runPromise(getContactList({ customerId, limit: 10, offset: 0 }, base)),
    ]);
    assert.equal(results.length, 13);
    assert.deepEqual(results[1], {
      ...completeCustomer,
      customerId,
      name: 'Acme complete edit',
    });
    assert.deepEqual(results[8], nullableCustomer);
    assert.deepEqual(results[9], completeCustomer);
    assert.deepEqual(results[10], {
      items: [completeCustomer, nullableCustomer],
      nextOffset: null,
    });
    assert.equal(gatewayIssues, 13);
    assert.equal(invocations.length, 13);
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
    assert.deepEqual(
      invocations.find((invocation) => invocation.key.endsWith('edit-customer'))?.payload,
      completeEditPayload,
    );
    assert.ok(
      invocations
        .filter((invocation) => invocation.idempotencyKey !== undefined)
        .every((invocation) => invocation.traceId === base.traceId),
    );

    const evidenceFailure = await Effect.runPromise(
      Effect.flip(getCustomerDetail({ customerId: missingId }, base)),
    );
    assert.equal(parseJsonObject(evidenceFailure)['_tag'], 'CustomerDetailUnavailableProblem');
    const listEvidenceFailure = await Effect.runPromise(
      Effect.flip(getCustomerList({ limit: 10, offset: 99 }, base)),
    );
    assert.equal(parseJsonObject(listEvidenceFailure)['_tag'], 'CustomerListUnavailableProblem');

    let malformedGatewayIssues = 0;
    const malformedServer = await startServer(
      {
        handler: async () =>
          Response.json(
            { ...completeCustomer, ico: 'malformed' },
            {
              status: 200,
            },
          ),
      },
      issueAssertion,
      () => {
        malformedGatewayIssues += 1;
      },
    );
    const malformedBase = {
      baseUrl: malformedServer.baseUrl,
      correlationId: 'contacts-bff-malformed-correlation',
      gateway: { baseUrl: malformedServer.baseUrl },
    } as const;
    try {
      const detailDecodingFailure = await Effect.runPromise(
        Effect.flip(getCustomerDetail({ customerId: completeCustomerId }, malformedBase)),
      );
      const listDecodingFailure = await Effect.runPromise(
        Effect.flip(getCustomerList({ limit: 10, offset: 0 }, malformedBase)),
      );
      assert.equal(Schema.isSchemaError(detailDecodingFailure), true);
      assert.equal(Schema.isSchemaError(listDecodingFailure), true);
      assert.equal(malformedGatewayIssues, 2);
    } finally {
      await malformedServer.close();
    }

    const transportFailure = await Effect.runPromise(
      Effect.flip(
        getCustomerDetail(
          { customerId: completeCustomerId },
          {
            baseUrl: malformedServer.baseUrl,
            correlationId: 'contacts-bff-transport-correlation',
            gateway: { baseUrl: server.baseUrl },
          },
        ),
      ),
    );
    const transportProblem = parseJsonObject(transportFailure);
    assert.equal(transportProblem['_tag'], 'HttpClientError');
    assert.equal(parseJsonObject(transportProblem['reason'])['_tag'], 'TransportError');

    const defectFailure = await Effect.runPromise(
      Effect.flip(createCustomer(customerPayload('trigger-defect'), mutation)),
    );
    assert.equal(parseJsonObject(defectFailure)['_tag'], 'ContactsInternalProblem');
    assert.equal(JSON.stringify(defectFailure).includes('secret persistence detail'), false);

    const forbiddenFailure = await Effect.runPromise(
      Effect.flip(createCustomer(customerPayload('trigger-forbidden'), mutation)),
    );
    assert.equal(parseJsonObject(forbiddenFailure)['_tag'], 'ContactsForbiddenProblem');
    const notFoundFailure = await Effect.runPromise(
      Effect.flip(editCustomer({ customerId: missingId, ...customerPayload('Missing') }, mutation)),
    );
    assert.equal(parseJsonObject(notFoundFailure)['_tag'], 'ContactsNotFoundProblem');
    const conflictFailure = await Effect.runPromise(
      Effect.flip(archiveCustomer({ customerId: conflictId }, mutation)),
    );
    assert.equal(parseJsonObject(conflictFailure)['_tag'], 'ContactsConflictProblem');

    const invalidMutation = await Effect.runPromise(
      Effect.flip(createCustomer(customerPayload('trigger-invalid'), mutation)),
    );
    assert.equal(parseJsonObject(invalidMutation)['_tag'], 'ContactsInvalidRequestProblem');
    const icoConflict = await Effect.runPromise(
      Effect.flip(createCustomer(customerPayload('trigger-ico-conflict'), mutation)),
    );
    const icoConflictProblem = parseJsonObject(icoConflict);
    assert.equal(icoConflictProblem['_tag'], 'ContactsConflictProblem');
    assert.equal(icoConflictProblem['code'], 'contacts_customer_ico_conflict');
    assert.equal(JSON.stringify(icoConflict).includes('contacts_customers_tenant_ico_uk'), false);
    const editIcoConflict = await Effect.runPromise(
      Effect.flip(
        editCustomer(
          {
            customerId,
            ...customerPayload('trigger-ico-conflict'),
            ico: completeCustomer.ico,
          },
          mutation,
        ),
      ),
    );
    const editIcoConflictProblem = parseJsonObject(editIcoConflict);
    assert.equal(editIcoConflictProblem['_tag'], 'ContactsConflictProblem');
    assert.equal(editIcoConflictProblem['code'], 'contacts_customer_ico_conflict');
    assert.equal(
      JSON.stringify(editIcoConflict).includes('contacts_customers_tenant_ico_uk'),
      false,
    );
    const unavailableMutation = await Effect.runPromise(
      Effect.flip(createCustomer(customerPayload('trigger-unavailable'), mutation)),
    );
    const unavailableProblem = parseJsonObject(unavailableMutation);
    assert.equal(unavailableProblem['_tag'], 'ContactsUnavailableProblem');
    assert.equal(unavailableProblem['retryable'], true);

    const rawValidHeaders = {
      authorization: `Bearer ${assertion}`,
      'content-type': 'application/json',
      'idempotency-key': 'raw-idempotency',
      'x-correlation-id': 'raw-correlation',
    };
    const missingAssertion = await handler.handler(
      new Request('https://contacts.test/contacts/customers/create', {
        body: JSON.stringify(customerPayload('Acme')),
        headers: { ...rawValidHeaders, authorization: '' },
        method: 'POST',
      }),
    );
    assert.equal(missingAssertion.status, 401);
    assert.equal(missingAssertion.headers.get('www-authenticate'), 'Bearer');
    const invalidAssertion = await handler.handler(
      new Request('https://contacts.test/contacts/customers/create', {
        body: JSON.stringify(customerPayload('Acme')),
        headers: { ...rawValidHeaders, authorization: 'Bearer invalid.jwt.assertion' },
        method: 'POST',
      }),
    );
    assert.equal(invalidAssertion.status, 401);
    assert.equal(invalidAssertion.headers.get('www-authenticate'), 'Bearer');

    const missingCorrelation = await handler.handler(
      new Request('https://contacts.test/contacts/customers/create', {
        body: JSON.stringify(customerPayload('Acme')),
        headers: { ...rawValidHeaders, 'x-correlation-id': '' },
        method: 'POST',
      }),
    );
    assert.equal(missingCorrelation.status, 400);

    const missingIdempotency = await handler.handler(
      new Request('https://contacts.test/contacts/customers/create', {
        body: JSON.stringify(customerPayload('Acme')),
        headers: {
          authorization: `Bearer ${await issueAssertion()}`,
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
