import { readFile, readdir } from 'node:fs/promises';

import { Effect, Schema, SchemaAST, Predicate, Struct } from 'effect';
// @effect-diagnostics nodeBuiltinImport:off -- Read-only architecture assertions use native filesystem promises. expires: 2026-12-31.
import { assert, expect, it } from 'effect-rstest';

import { getReadHandler } from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  AresLookupApi,
  AresLookupAuthenticationProblemSchema,
  AresLookupForbiddenProblemSchema,
  AresLookupInternalProblemSchema,
  AresLookupInvalidProblemSchema,
  AresLookupNotFoundProblemSchema,
  AresLookupPolicyConflictProblemSchema,
  AresLookupPolicyProblemSchema,
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

const evidenceWire = {
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
const problemTag = (schema: Schema.Top): SchemaAST.LiteralValue => {
  assert.isOk(SchemaAST.isObjects(schema.ast));
  const tag = schema.ast.propertySignatures.find(
    ({ name }) => name === '_tag'
  )?.type;
  assert.isOk(tag !== undefined && SchemaAST.isLiteral(tag));
  return tag.literal;
};

const evidence = Schema.decodeUnknownSync(AresLookupResponseSchema)(
  evidenceWire
);

const scope = Object.freeze({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:ares-lookup-unit',
  authMethod: 'session' as const,
  correlationId: 'ares-lookup-correlation',
  legalEntityId: '00000000-0000-4000-8000-000000000004',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const request = Schema.decodeUnknownSync(AresLookupRequestSchema)({
  ico: '48039101',
});

it('declares a tenant-authorized Party evidence Read with optional Legal Entity context', () => {
  expect(aresLookupRead.descriptor.accessKind).toBe('detail');
  expect(aresLookupRead.descriptor.legalEntityScope).toBe('optional');
  expect(aresLookupRead.descriptor.permissionTarget).toBe('tenant');
  expect(aresLookupRead.descriptor.owningModuleKey).toBe('party.registry');
  expect(aresLookupRead.descriptor.readKey).toBe(
    'party.registry.api.ares-lookup'
  );
  expect(aresLookupRead.descriptor.evidencePolicy.captureMode).toBe(
    'metadata_only'
  );
});

it.effect(
  'passes trusted correlation to the private adapter and returns exactly one evidence result',
  () =>
    Effect.gen(function* aresLookupReadCase1() {
      const calls: unknown[] = [];
      const result = yield* getReadHandler(aresLookupRead)(request, {
        readKey: aresLookupRead.descriptor.readKey,
        scope,
        services: {
          lookup: (input) => {
            calls.push(input);
            return Effect.succeed(evidence);
          },
        },
      }).pipe(
        Effect.provideService(AresSubjectService, {
          subject: () =>
            Effect.die('The handler test supplies services directly'),
        })
      );

      expect(calls).toEqual([
        { correlationId: scope.correlationId, ico: '48039101' },
      ]);
      expect(result).toEqual({
        evidence: { resultCount: 1 },
        result: evidence,
      });
    })
);

it.effect(
  'maps provider failures to the closed governed Read error vocabulary without leaking details',
  () =>
    Effect.gen(function* aresLookupReadCase2() {
      const failures = [
        [
          new AresSubjectNotFound({
            code: 'ares_subject_not_found',
            reason: 'private 404 body',
          }),
          'ReadHandlerNotFound',
        ],
        [
          new AresSubjectDenied({
            code: 'ares_subject_denied',
            reason: 'private denial',
          }),
          'ReadHandlerUnavailable',
        ],
        [
          new AresSubjectThrottled({
            code: 'ares_subject_throttled',
            reason: 'private throttle',
          }),
          'ReadHandlerUnavailable',
        ],
        [
          new AresSubjectTimeout({
            code: 'ares_subject_timeout',
            reason: 'private timeout',
          }),
          'ReadHandlerUnavailable',
        ],
        [
          new AresSubjectUnavailable({
            code: 'ares_subject_unavailable',
            reason: 'private transport',
          }),
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

      const errors = yield* Effect.all(
        failures.map(([failure, expectedTag]) =>
          Effect.flip(
            getReadHandler(aresLookupRead)(request, {
              readKey: aresLookupRead.descriptor.readKey,
              scope,
              services: { lookup: () => Effect.fail(failure) },
            })
          ).pipe(
            Effect.provideService(AresSubjectService, {
              subject: () =>
                Effect.die('The handler test supplies services directly'),
            }),
            Effect.map((error) => ({ error, expectedTag }))
          )
        )
      );
      for (const { error, expectedTag } of errors) {
        expect(Predicate.isTagged(error, expectedTag)).toBe(true);
        expect(
          (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            error
          )).includes('private')
        ).toBe(false);
      }
    })
);

it.effect(
  'publishes safe status-matched Problem Details and no provider payload schema',
  () =>
    Effect.gen(function* validateContract2() {
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
        [
          AresLookupAuthenticationProblemSchema,
          'AresLookupAuthenticationProblem',
          401,
        ],
        [AresLookupForbiddenProblemSchema, 'AresLookupForbiddenProblem', 403],
        [AresLookupNotFoundProblemSchema, 'AresLookupNotFoundProblem', 404],
        [
          AresLookupPolicyConflictProblemSchema,
          'AresLookupPolicyConflictProblem',
          409,
        ],
        [AresLookupPolicyProblemSchema, 'AresLookupPolicyProblem', 422],
        [
          AresLookupUnavailableProblemSchema,
          'AresLookupUnavailableProblem',
          503,
        ],
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
        expect(
          (yield* Schema.decodeUnknownEffect(schema)(fixture)).status
        ).toBe(status);
        const encoding = schema.ast.annotations?.['~httpApiEncoding'];
        expect(Predicate.isTagged(encoding, 'Json')).toBe(true);
        if (!Predicate.isTagged(encoding, 'Json')) {
          throw new Error('Expected JSON HTTP API encoding');
        }
        expect(Struct.omit(encoding, ['_tag'])).toEqual({
          contentType: 'application/problem+json',
        });
      }
      expect(
        [...AresLookupApi.groups.aresLookup.endpoints.execute.error].map(
          problemTag
        )
      ).toEqual([
        'AresLookupInvalidProblem',
        'AresLookupAuthenticationProblem',
        'AresLookupForbiddenProblem',
        'AresLookupNotFoundProblem',
        'AresLookupPolicyConflictProblem',
        'AresLookupPolicyProblem',
        'AresLookupUnavailableProblem',
        'AresLookupInternalProblem',
      ]);
      expect(
        yield* Schema.decodeUnknownEffect(AresLookupRequestSchema)({
          ico: '48039101',
        })
      ).toEqual({
        ico: '48039101',
      });
      expect(
        yield* Schema.decodeUnknownEffect(AresLookupResponseSchema)(
          evidenceWire
        )
      ).toEqual(evidence);
      expect(AresLookupApi.identifier).toBe('AresLookupApi');
    })
);

it.effect(
  'keeps the ARES integration read-only and exposes no ARES Action',
  () =>
    Effect.gen(function* aresLookupReadCase3() {
      const sourceFiles = [
        new URL(
          '../../src/integrations/ares/ares-subject.service.ts',
          import.meta.url
        ),
        new URL('../../src/api/ares-lookup.read.ts', import.meta.url),
      ];
      const sources = yield* Effect.all(
        sourceFiles.map((sourceFile) =>
          Effect.promise(() => readFile(sourceFile, 'utf-8'))
        ),
        { concurrency: 'unbounded' }
      );
      for (const source of sources) {
        expect(source).not.toMatch(
          /from ['"].*(?:\/db\/|\/actions\/|\/services\/party-)/u
        );
      }
      const actionFiles = yield* Effect.promise(() =>
        readdir(new URL('../../src/actions/', import.meta.url))
      );
      expect(actionFiles.some((name) => name.includes('ares'))).toBe(false);
    })
);
