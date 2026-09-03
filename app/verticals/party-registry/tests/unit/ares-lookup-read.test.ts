// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
/* eslint-disable no-await-in-loop -- Closed failure and source-file cases are intentionally checked in stable order. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { getReadHandler } from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  AresLookupApi,
  AresLookupAuthenticationProblemSchema,
  AresLookupForbiddenProblemSchema,
  AresLookupInternalProblemSchema,
  AresLookupInvalidProblemSchema,
  AresLookupNotFoundProblemSchema,
  AresLookupRequestSchema,
  AresLookupResponseSchema,
  AresLookupUnavailableProblemSchema,
} from '../../shared/apis/ares-lookup.ts';
import { aresLookupRead } from '../../src/api/ares-lookup.read.ts';
import {
  AresSubjectDenied,
  AresSubjectNotFound,
  AresSubjectResponseInvalid,
  AresSubjectService,
  AresSubjectThrottled,
  AresSubjectTimeout,
  AresSubjectUnavailable,
} from '../../src/integrations/ares/ares-subject.service.ts';

const evidence = {
  cacheAgeSeconds: 0,
  observedAt: '2026-09-03T08:00:00.000Z',
  provider: 'ares',
  providerChangedOn: null,
  providerRecordRef: null,
  queryIco: '48039101',
  servedAt: '2026-09-03T08:00:00.000Z',
  status: 'FOUND',
  subject: {
    businessName: 'J.E.S., spol. s r.o.',
    dic: 'CZ48039101',
    dissolvedOn: null,
    establishedOn: '1992-12-04',
    ico: '48039101',
    legalFormCode: '112',
    registeredAddress: null,
  },
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

test('declares a tenant-authorized Party evidence Read with optional Legal Entity context', () => {
  assert.equal(aresLookupRead.descriptor.accessKind, 'detail');
  assert.equal(aresLookupRead.descriptor.legalEntityScope, 'optional');
  assert.equal(aresLookupRead.descriptor.permissionTarget, 'tenant');
  assert.equal(aresLookupRead.descriptor.owningModuleKey, 'party.registry');
  assert.equal(aresLookupRead.descriptor.readKey, 'party.registry.api.ares-lookup');
  assert.equal(aresLookupRead.descriptor.evidencePolicy.captureMode, 'metadata_only');
});

test('passes trusted correlation to the private adapter and returns exactly one evidence result', async () => {
  const calls: unknown[] = [];
  const result = await Effect.runPromise(
    getReadHandler(aresLookupRead)(
      { ico: '48039101' },
      {
        readKey: aresLookupRead.descriptor.readKey,
        scope,
        services: {
          lookup: (input) => {
            calls.push(input);
            return Effect.succeed(evidence);
          },
        },
      },
    ).pipe(
      Effect.provideService(AresSubjectService, {
        subject: () => Effect.die('The handler test supplies services directly'),
      }),
    ),
  );

  assert.deepEqual(calls, [{ correlationId: scope.correlationId, ico: '48039101' }]);
  assert.deepEqual(result, { evidence: { resultCount: 1 }, result: evidence });
});

test('maps provider failures to the closed governed Read error vocabulary without leaking details', async () => {
  const failures = [
    [
      new AresSubjectNotFound({ code: 'ares_subject_not_found', reason: 'private 404 body' }),
      'ReadHandlerNotFound',
    ],
    [
      new AresSubjectDenied({ code: 'ares_subject_denied', reason: 'private denial' }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectThrottled({ code: 'ares_subject_throttled', reason: 'private throttle' }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectTimeout({ code: 'ares_subject_timeout', reason: 'private timeout' }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectUnavailable({ code: 'ares_subject_unavailable', reason: 'private transport' }),
      'ReadHandlerUnavailable',
    ],
    [
      new AresSubjectResponseInvalid({
        code: 'ares_subject_response_invalid',
        reason: 'private payload',
      }),
      'ReadHandlerExecutionError',
    ],
  ] as const;

  for (const [failure, expectedTag] of failures) {
    const error = await Effect.runPromise(
      Effect.flip(
        getReadHandler(aresLookupRead)(
          { ico: '48039101' },
          {
            readKey: aresLookupRead.descriptor.readKey,
            scope,
            services: { lookup: () => Effect.fail(failure) },
          },
        ),
      ).pipe(
        Effect.provideService(AresSubjectService, {
          subject: () => Effect.die('The handler test supplies services directly'),
        }),
      ),
    );
    assert.equal(error._tag, expectedTag);
    assert.equal(JSON.stringify(error).includes('private'), false);
  }
});

test('publishes safe status-matched Problem Details and no provider payload schema', () => {
  interface ProblemFixture {
    readonly _tag: string;
    readonly detail: string;
    readonly retryable?: true;
    readonly status: number;
    readonly title: string;
    readonly type: string;
  }
  const schemas = [
    [AresLookupInvalidProblemSchema, 'AresLookupInvalidProblem', 400],
    [AresLookupAuthenticationProblemSchema, 'AresLookupAuthenticationProblem', 401],
    [AresLookupForbiddenProblemSchema, 'AresLookupForbiddenProblem', 403],
    [AresLookupNotFoundProblemSchema, 'AresLookupNotFoundProblem', 404],
    [AresLookupUnavailableProblemSchema, 'AresLookupUnavailableProblem', 503],
    [AresLookupInternalProblemSchema, 'AresLookupInternalProblem', 500],
  ] as const;
  for (const [schema, tag, status] of schemas) {
    const fixture: ProblemFixture =
      status === 503
        ? {
            _tag: tag,
            detail: 'safe detail',
            retryable: true,
            status,
            title: 'safe title',
            type: 'https://ontos.dev/problems/test',
          }
        : {
            _tag: tag,
            detail: 'safe detail',
            status,
            title: 'safe title',
            type: 'https://ontos.dev/problems/test',
          };
    assert.equal(Schema.decodeUnknownSync(schema)(fixture).status, status);
  }
  assert.deepEqual(Schema.decodeUnknownSync(AresLookupRequestSchema)({ ico: '48039101' }), {
    ico: '48039101',
  });
  assert.deepEqual(Schema.decodeUnknownSync(AresLookupResponseSchema)(evidence), evidence);
  assert.equal(AresLookupApi.identifier, 'AresLookupApi');
});

test('keeps the ARES integration read-only and exposes no ARES Action', async () => {
  const sourceFiles = [
    new URL('../../src/integrations/ares/ares-subject.service.ts', import.meta.url),
    new URL('../../src/api/ares-lookup.read.ts', import.meta.url),
  ];
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf-8');
    assert.doesNotMatch(source, /from ['"].*(?:\/db\/|\/actions\/|\/services\/party-)/u);
  }
  const actionFiles = await readdir(new URL('../../src/actions/', import.meta.url));
  assert.equal(
    actionFiles.some((name) => name.includes('ares')),
    false,
  );
});
