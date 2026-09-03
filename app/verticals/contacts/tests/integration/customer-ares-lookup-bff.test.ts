/* eslint-disable no-promise-executor-return, promise/avoid-new, promise/prefer-await-to-callbacks, require-await -- Node HTTP and fake transaction callbacks are adapted at the test boundary. */
// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off globalDate:off newPromise:off nodeBuiltinImport:off processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { ActionResultValidationError, ActionRuntime, ReadRuntime } from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { Effect, Layer } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeContactsApiRuntime } from '../../api/index.ts';
import { createCustomer, lookupCustomerAres } from '../../src/api/contacts-client.ts';
import {
  AresSubjectDecodeFailure,
  AresSubjectDenied,
  AresSubjectNotFound,
  AresSubjectService,
  AresSubjectTimeout,
} from '../../src/integrations/ares/ares-subject.service.ts';
import type {
  AresSubject,
  AresSubjectError,
  AresSubjectLookup,
} from '../../src/integrations/ares/ares-subject.service.ts';
import { parseJsonObject } from '../support/json-value.ts';
import type { JsonObject } from '../support/json-value.ts';
import { appendRequestChunk, webRequestInit } from '../support/node-http.ts';

const principal = {
  authBindingId: 'b1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:ares-bff-integration',
  authMethod: 'session' as const,
  legalEntityId: 'b4000000-0000-4000-8000-000000000001',
  principalId: 'b2000000-0000-4000-8000-000000000001',
  tenantId: 'b3000000-0000-4000-8000-000000000001',
};
const subject = {
  dic: 'CZ48039101',
  dissolvedOn: null,
  establishedOn: '1992-12-04',
  ico: '48039101',
  legalFormCode: '112',
  name: 'J.E.S., spol. s r.o.',
} as const;

const startServer = async (
  handler: { readonly handler: (request: Request) => Promise<Response> },
  issueAssertion: () => Promise<string>,
) => {
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      appendRequestChunk(chunks, chunk);
    }
    const url = `http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`;
    if (new URL(url).pathname === '/auth/gateway-context') {
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
  assert.ok(address instanceof Object);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      }),
  };
};

test('runs ARES lookup through the generated client, real BFF, and governed Read runtime', async () => {
  const previousIssuer = process.env['ONTOS_GATEWAY_ISSUER'];
  const previousJwks = process.env['ONTOS_GATEWAY_PUBLIC_JWKS'];
  const issuer = 'https://shell.ares-bff.test';
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const issueAssertion = () =>
    new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'ares-bff', typ: 'JWT' })
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
    keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'ares-bff', use: 'sig' }],
  });

  let permissionDecision: 'allowed' | 'denied' = 'allowed';
  let aresResult: Effect.Effect<AresSubject, AresSubjectError> = Effect.succeed(subject);
  const aresCalls: AresSubjectLookup[] = [];
  const evidenceRows: JsonObject[] = [];
  const actionCalls: JsonObject[] = [];
  let executeCount = 0;
  const transaction = {
    delete: () => {},
    execute: async () => {
      executeCount += 1;
      return executeCount % 2 === 1
        ? { rows: [] }
        : {
            rows: [
              {
                legal_entity_id: principal.legalEntityId,
                tenant_id: principal.tenantId,
              },
            ],
          };
    },
    insert: () => ({
      values: async (value: JsonObject) => {
        evidenceRows.push(value);
      },
    }),
    query: {},
    select: () => {},
    update: () => {},
  };
  const database = {
    executor: {
      insert: transaction.insert,
      transaction: <Result>(callback: (value: typeof transaction) => Promise<Result>) =>
        callback(transaction),
    },
  };
  const readRuntime = makeReadRuntime(
    database,
    { check: () => Effect.void, prepareSnapshot: () => Effect.succeed({}) },
    {
      resolve: ({ correlationId }: { readonly correlationId: string }) =>
        Effect.succeed({ ...principal, correlationId }),
    },
    {
      legalEntities: () => Effect.succeed([]),
      modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) =>
        Effect.succeed(moduleIds.map((key: string) => ({ decision: permissionDecision, key }))),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    },
  );
  const actionRuntime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('Action commit resolution is not used by this test'),
    runAction: (input) => {
      const payload = parseJsonObject(input.payload);
      const transport = parseJsonObject(input.transport);
      actionCalls.push({
        actionKey: input.registration.descriptor.actionKey,
        payload,
        transport,
      });
      return Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)({
        ...payload,
        archivedAt: null,
        createdAt: '2026-08-17T10:00:00.000Z',
        customerId: 'b5000000-0000-4000-8000-000000000001',
        updatedAt: '2026-08-17T10:00:00.000Z',
      }).pipe(
        Effect.mapError(
          () =>
            new ActionResultValidationError({
              code: 'action_result_invalid',
              reason: 'The Action fixture result does not match its declared schema',
            }),
        ),
      );
    },
  };
  const aresService = {
    subject: (input: AresSubjectLookup) => {
      aresCalls.push(input);
      return aresResult;
    },
  };
  const runtime = makeContactsApiRuntime(
    Layer.succeed(ActionRuntime, actionRuntime),
    Layer.succeed(ReadRuntime, readRuntime),
    Layer.succeed(AresSubjectService, aresService),
  );
  const handler = runtime.createHandler();
  const server = await startServer(handler, issueAssertion);

  try {
    const options = {
      baseUrl: server.baseUrl,
      correlationId: 'ares-bff-correlation',
      gateway: { baseUrl: server.baseUrl },
    } as const;
    const result = await Effect.runPromise(lookupCustomerAres({ ico: subject.ico }, options));
    assert.deepEqual(result, subject);
    assert.deepEqual(aresCalls, [{ correlationId: options.correlationId, ico: subject.ico }]);
    assert.equal(evidenceRows.length, 1);
    assert.deepEqual(
      {
        captureMode: evidenceRows[0]?.['evidenceCaptureMode'],
        outcome: evidenceRows[0]?.['outcome'],
        policyKey: evidenceRows[0]?.['evidencePolicyKey'],
        resultCount: evidenceRows[0]?.['resultCount'],
        targetModuleKey: evidenceRows[0]?.['targetModuleKey'],
      },
      {
        captureMode: 'metadata_only',
        outcome: 'allowed',
        policyKey: 'contacts.core.api.customer-ares-lookup.evidence.v1',
        resultCount: 1,
        targetModuleKey: 'contacts.core',
      },
    );

    const created = await Effect.runPromise(
      createCustomer(
        {
          dic: result.dic,
          dissolvedOn: result.dissolvedOn,
          establishedOn: result.establishedOn,
          ico: result.ico,
          legalFormCode: result.legalFormCode,
          name: result.name,
        },
        { ...options, idempotencyKey: 'ares-prefill-confirmed-create' },
      ),
    );
    assert.deepEqual(
      {
        dic: created.dic,
        dissolvedOn: created.dissolvedOn,
        establishedOn: created.establishedOn,
        ico: created.ico,
        legalFormCode: created.legalFormCode,
        name: created.name,
      },
      subject,
    );
    assert.deepEqual(actionCalls, [
      {
        actionKey: 'contacts.core.create-customer',
        payload: subject,
        transport: {
          correlationId: options.correlationId,
          idempotencyKey: 'ares-prefill-confirmed-create',
        },
      },
    ]);
    const createPayload = parseJsonObject(actionCalls[0]?.['payload']);
    assert.equal(Object.hasOwn(createPayload, 'address'), false);
    assert.equal(Object.hasOwn(createPayload, 'ares'), false);
    assert.equal(Object.hasOwn(createPayload, 'source'), false);
    assert.equal(Object.hasOwn(createPayload, 'upload'), false);

    const callsBeforeInvalid = aresCalls.length;
    const invalid = await handler.handler(
      new Request(`${server.baseUrl}/contacts/customers/ares-lookup`, {
        body: JSON.stringify({ ico: '123' }),
        headers: {
          authorization: `Bearer ${assertion}`,
          'content-type': 'application/json',
          'x-correlation-id': 'invalid-ico-correlation',
        },
        method: 'POST',
      }),
    );
    assert.equal(invalid.status, 400);
    assert.equal(aresCalls.length, callsBeforeInvalid);

    const missingAuthentication = await handler.handler(
      new Request(`${server.baseUrl}/contacts/customers/ares-lookup`, {
        body: JSON.stringify({ ico: subject.ico }),
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': 'missing-auth-correlation',
        },
        method: 'POST',
      }),
    );
    assert.equal(missingAuthentication.status, 401);
    assert.equal(missingAuthentication.headers.get('www-authenticate'), 'Bearer');

    permissionDecision = 'denied';
    const callsBeforeForbidden = aresCalls.length;
    const forbidden = await Effect.runPromise(
      Effect.flip(lookupCustomerAres({ ico: subject.ico }, options)),
    );
    assert.equal(parseJsonObject(forbidden)['_tag'], 'CustomerAresLookupForbiddenProblem');
    assert.equal(aresCalls.length, callsBeforeForbidden);
    assert.equal(evidenceRows.at(-1)?.['outcome'], 'denied');
    permissionDecision = 'allowed';

    aresResult = Effect.fail(
      new AresSubjectNotFound({
        code: 'ares_subject_not_found',
        reason: 'provider record is absent',
      }),
    );
    const notFound = await Effect.runPromise(
      Effect.flip(lookupCustomerAres({ ico: subject.ico }, options)),
    );
    assert.equal(parseJsonObject(notFound)['_tag'], 'CustomerAresLookupNotFoundProblem');

    const assertUnavailable = async (failure: AresSubjectError) => {
      aresResult = Effect.fail(failure);
      const unavailable = await Effect.runPromise(
        Effect.flip(lookupCustomerAres({ ico: subject.ico }, options)),
      );
      assert.equal(parseJsonObject(unavailable)['_tag'], 'CustomerAresLookupUnavailableProblem');
      assert.equal(JSON.stringify(unavailable).includes('secret'), false);
    };
    await assertUnavailable(
      new AresSubjectDenied({
        code: 'ares_subject_denied',
        reason: 'secret provider denial',
      }),
    );
    await assertUnavailable(
      new AresSubjectTimeout({
        code: 'ares_subject_timeout',
        reason: 'secret timeout detail',
      }),
    );

    aresResult = Effect.fail(
      new AresSubjectDecodeFailure({
        code: 'ares_subject_decode_failure',
        reason: 'secret raw ARES response detail',
      }),
    );
    const internal = await Effect.runPromise(
      Effect.flip(lookupCustomerAres({ ico: subject.ico }, options)),
    );
    assert.equal(parseJsonObject(internal)['_tag'], 'CustomerAresLookupInternalProblem');
    assert.equal(JSON.stringify(internal).includes('secret'), false);
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
