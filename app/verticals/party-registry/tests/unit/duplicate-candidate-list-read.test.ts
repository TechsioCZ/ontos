import { ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Predicate, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../../../packages/core-runtime/src/actions/principal-context.ts';
import {
  getReadPermissionTargetResolver,
  runReadOwnerSteps,
} from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  DuplicateCandidateListForbiddenProblemSchema,
  DuplicateCandidateListRequestSchema,
} from '../../shared/apis/duplicate-candidate-list.ts';
import { PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { executeDuplicateCandidateListWithAuthorization } from '../../src/api/duplicate-candidate-list-client.ts';
import { duplicateCandidateListRead } from '../../src/api/duplicate-candidate-list.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000002',
    authContextRef: 'better-auth-session:duplicate-review-unit',
    authMethod: 'session',
    principalId: '10000000-0000-4000-8000-000000000003',
    tenantId,
  }),
  correlationId: 'duplicate-review',
};
const caseRef = makeDuplicateCandidateCaseRef(tenantId, '30000000-0000-4000-8000-000000000001');
const request = Schema.decodeSync(DuplicateCandidateListRequestSchema)({ afterCaseRef: caseRef });
const page = {
  items: [{ caseRef, displayName: 'Submitted subject', lifecycleState: 'OPEN' as const, revision: 3 }],
  nextCaseRef: null,
};

it('the queue is a tenant reviewer read without a required commercial Legal Entity', () => {
  expect(duplicateCandidateListRead.descriptor.accessKind).toBe('list');
  expect(duplicateCandidateListRead.descriptor.legalEntityScope).toBe('optional');
  expect(duplicateCandidateListRead.descriptor.permissionTarget).toBe('tenant');
  expect(duplicateCandidateListRead.descriptor.evidencePolicy.captureMode).toBe('metadata_only');
  const resolve = getReadPermissionTargetResolver(duplicateCandidateListRead);
  expect(Predicate.isFunction(resolve)).toBe(true);
  if (Predicate.isFunction(resolve)) {
    expect(resolve(request, scope)).toEqual({ kind: 'tenant', permission: 'review_party_identity' });
  }
});

it.effect('the queue forwards the typed cursor and records only the result count as evidence', () =>
  Effect.gen(function* queueRead() {
    const calls: unknown[] = [];
    const result = yield* runReadOwnerSteps(duplicateCandidateListRead, request, {
      readKey: duplicateCandidateListRead.descriptor.readKey,
      scope,
      services: {
        list: (input) => {
          calls.push(input);
          return Effect.succeed(page);
        },
      },
    });
    expect(calls).toEqual([request]);
    expect(result).toEqual({ evidence: { resultCount: 1 }, result: page });
  }),
);

it.effect('the queue sanitizes persistence failures into the governed unavailable vocabulary', () =>
  Effect.gen(function* queueFailure() {
    const failure = yield* runReadOwnerSteps(duplicateCandidateListRead, request, {
      readKey: duplicateCandidateListRead.descriptor.readKey,
      scope,
      services: {
        list: () =>
          Effect.fail(
            Object.assign(
              new PartyPersistenceUnavailable({
                code: 'party_persistence_unavailable',
                reason: 'private database diagnostic',
              }),
              { cause: 'private database diagnostic' },
            ),
          ),
      },
    }).pipe(Effect.flip);
    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(failure.reason).toBe('Duplicate Candidate persistence is unavailable');
  }),
);

it.effect('the generated queue client posts its typed cursor and preserves an owner permission denial', () =>
  Effect.gen(function* queueHttp() {
    const requests: Request[] = [];
    const problem = {
      _tag: 'DuplicateCandidateListForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    };
    const fakeFetch: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json(problem, { headers: { 'content-type': 'application/problem+json' }, status: 403 }),
      );
    };
    const failure = yield* executeDuplicateCandidateListWithAuthorization(request, 'Bearer test', 'review-http', {
      baseUrl: 'https://party.example/party-registry-api',
    }).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(Schema.is(DuplicateCandidateListForbiddenProblemSchema)(failure)).toBe(true);
    expect(requests).toHaveLength(1);
    const [sent] = requests;
    if (sent === undefined) {
      return expect.unreachable('Expected a queue request');
    }
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://party.example/party-registry-api/reads/duplicate-candidate-list');
    expect(sent.headers.get('authorization')).toBe('Bearer test');
    expect(sent.headers.get('x-correlation-id')).toBe('review-http');
    expect(yield* Effect.promise(() => sent.json())).toEqual(request);
  }),
);
