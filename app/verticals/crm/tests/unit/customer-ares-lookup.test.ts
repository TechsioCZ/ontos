// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { getReadHandler } from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  CustomerAresLookupApi,
  CustomerAresLookupAuthenticationProblemSchema,
  CustomerAresLookupForbiddenProblemSchema,
  CustomerAresLookupInternalProblemSchema,
  CustomerAresLookupInvalidProblemSchema,
  CustomerAresLookupNotFoundProblemSchema,
  CustomerAresLookupRequestSchema,
  CustomerAresLookupResponseSchema,
  CustomerAresLookupUnavailableProblemSchema,
} from '../../shared/apis/customer-ares-lookup.ts';
import { customerAresLookupRead } from '../../src/api/customer-ares-lookup.read.ts';
import {
  AresSubjectDecodeFailure,
  AresSubjectDenied,
  AresSubjectInvalidIco,
  AresSubjectNotFound,
  AresSubjectService,
  AresSubjectThrottled,
  AresSubjectTimeout,
  AresSubjectUnavailable,
} from '../../src/integrations/ares/ares-subject.service.ts';

const subject = {
  dic: 'CZ48039101',
  dissolvedOn: null,
  establishedOn: '1992-12-04',
  ico: '48039101',
  legalFormCode: '112',
  name: 'J.E.S., spol. s r.o.',
} as const;

const scope = Object.freeze({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:ares-lookup-unit',
  authMethod: 'session' as const,
  correlationId: 'ares-lookup-correlation',
  legalEntityId: '00000000-0000-4000-8000-000000000004',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});

test('retains the exact generated governed read identity and access policy', () => {
  assert.deepEqual(customerAresLookupRead.descriptor, {
    accessKind: 'detail',
    entrypoint: {
      access: 'read',
      entrypointKey: 'crm.core.api.customer-ares-lookup',
      moduleKey: 'crm.core',
      role: 'api',
      scope: 'tenant',
    },
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'crm.core.api.customer-ares-lookup.evidence.v1',
    },
    inputSchema: CustomerAresLookupRequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'crm.core',
    permissionTarget: 'module',
    policies: [],
    readKey: 'crm.core.api.customer-ares-lookup',
    resultSchema: CustomerAresLookupResponseSchema,
    schemaVersion: '1',
  });
});

test('decodes only exact eight-digit input and flat Customer-compatible output', () => {
  assert.deepEqual(Schema.decodeUnknownSync(CustomerAresLookupRequestSchema)({ ico: '01234567' }), {
    ico: '01234567',
  });
  for (const ico of ['1234567', '123456789', '1234 567', 'abcdefgh']) {
    assert.throws(() => Schema.decodeUnknownSync(CustomerAresLookupRequestSchema)({ ico }));
  }
  const decoded = Schema.decodeUnknownSync(CustomerAresLookupResponseSchema)({
    ...subject,
    activities: ['must not escape'],
    address: { text: 'must not escape' },
    czNace: ['62010'],
    metadata: { source: 'ares' },
  });
  assert.deepEqual(decoded, subject);
  assert.deepEqual(Object.keys(decoded).toSorted(), [
    'dic',
    'dissolvedOn',
    'establishedOn',
    'ico',
    'legalFormCode',
    'name',
  ]);
});

test('declares only the required status-matched Problem Details union', () => {
  const fixtures = [
    [CustomerAresLookupInvalidProblemSchema, 'CustomerAresLookupInvalidProblem', 400],
    [CustomerAresLookupAuthenticationProblemSchema, 'CustomerAresLookupAuthenticationProblem', 401],
    [CustomerAresLookupForbiddenProblemSchema, 'CustomerAresLookupForbiddenProblem', 403],
    [CustomerAresLookupNotFoundProblemSchema, 'CustomerAresLookupNotFoundProblem', 404],
    [CustomerAresLookupUnavailableProblemSchema, 'CustomerAresLookupUnavailableProblem', 503],
    [CustomerAresLookupInternalProblemSchema, 'CustomerAresLookupInternalProblem', 500],
  ] as const;
  for (const [schema, tag, status] of fixtures) {
    const decoded = Schema.decodeUnknownSync(schema)({
      _tag: tag,
      detail: 'safe detail',
      ...(status === 503 ? { retryable: true } : {}),
      status,
      title: 'safe title',
      type: 'https://ontos.dev/problems/test',
    });
    assert.equal(decoded.status, status);
  }
});

test('maps the private ARES failure union without leaking provider diagnostics', async () => {
  const handler = getReadHandler(customerAresLookupRead);
  const failures = [
    [
      new AresSubjectNotFound({
        code: 'ares_subject_not_found',
        reason: 'private not-found detail',
      }),
      'ReadHandlerNotFound',
    ],
    [
      new AresSubjectDenied({
        code: 'ares_subject_denied',
        reason: 'private denial detail',
      }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectThrottled({
        code: 'ares_subject_throttled',
        reason: 'private throttling detail',
      }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectTimeout({
        code: 'ares_subject_timeout',
        reason: 'private timeout detail',
      }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectUnavailable({
        code: 'ares_subject_unavailable',
        reason: 'private transport detail',
      }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectDecodeFailure({
        code: 'ares_subject_decode_failure',
        reason: 'private decode detail',
      }),
      'AresSubjectDecodeFailure',
    ],
    [
      new AresSubjectInvalidIco({
        code: 'ares_subject_invalid_ico',
        reason: 'private invariant detail',
      }),
      'AresSubjectInvalidIco',
    ],
  ] as const;
  await Promise.all(
    failures.map(async ([failure, expectedTag]) => {
      const mapped = await Effect.runPromise(
        Effect.flip(
          handler(
            { ico: subject.ico },
            {
              readKey: customerAresLookupRead.descriptor.readKey,
              scope,
              services: { lookup: () => Effect.fail(failure) },
            },
          ).pipe(
            Effect.provideService(AresSubjectService, {
              subject: () => Effect.die('The unit test supplies handler services directly'),
            }),
          ),
        ),
      );
      assert.equal(mapped._tag, expectedTag);
      if (mapped._tag === 'ReadHandlerNotFound' || mapped._tag === 'ReadHandlerUnavailable') {
        assert.equal(mapped.reason.includes('private'), false);
      }
    }),
  );
});

test('passes trusted correlation to ARES and returns one flat evidence result', async () => {
  const calls: unknown[] = [];
  const result = await Effect.runPromise(
    getReadHandler(customerAresLookupRead)(
      { ico: subject.ico },
      {
        readKey: customerAresLookupRead.descriptor.readKey,
        scope,
        services: {
          lookup: (input) => {
            calls.push(input);
            return Effect.succeed(subject);
          },
        },
      },
    ).pipe(
      Effect.provideService(AresSubjectService, {
        subject: () => Effect.die('The unit test supplies handler services directly'),
      }),
    ),
  );
  assert.deepEqual(calls, [{ correlationId: scope.correlationId, ico: subject.ico }]);
  assert.deepEqual(result, { evidence: { resultCount: 1 }, result: subject });
});

test('publishes the generated API and private client registration without an ARES Action', async () => {
  const manifest = await readFile(new URL('../../vertical.manifest.ts', import.meta.url), 'utf-8');
  const registration = await readFile(
    new URL('../../vertical.registration.ts', import.meta.url),
    'utf-8',
  );
  assert.match(manifest, /'customer-ares-lookup': CustomerAresLookupApi,/u);
  assert.match(
    registration,
    /'customer-ares-lookup': \(\) => import\('\.\/src\/api\/customer-ares-lookup-client\.ts'\),/u,
  );
  const clientModule = await import('../../src/api/customer-ares-lookup-client.ts');
  assert.equal(typeof clientModule.executeCustomerAresLookup, 'function');
  assert.equal(typeof clientModule.executeCustomerAresLookupWithAuthorization, 'function');
  const actionFiles = await readdir(new URL('../../src/actions/', import.meta.url));
  assert.equal(
    actionFiles.some((name) => name.includes('ares')),
    false,
  );
  assert.equal(CustomerAresLookupApi.identifier, 'CustomerAresLookupApi');
});
