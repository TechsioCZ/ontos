import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it, rstest } from 'effect-rstest';

import { ProjectSchema, ProjectUuidSchema } from '../../shared/domain/project.ts';
import { executeFreshReadProject } from '../../src/api/projects-client.ts';
import { executeReadProject } from '../../src/api/read-project-client.ts';

rstest.mock('../../src/api/action-gateway.ts', () => ({
  operationGateway: {
    invoke: <Success, Failure>(
      attempt: (
        authorization: string,
        target: { readonly apiBaseUrl: string; readonly compositionRevision: string },
      ) => Effect.Effect<Success, Failure>,
    ) =>
      attempt('Bearer test-transport-credential', {
        apiBaseUrl: 'https://owner.example/projects-api',
        compositionRevision: 'a'.repeat(64),
      }),
  },
}));

it.effect(
  'the actual generated owner client forwards fresh-read transport policy without changing the request or ordinary reads',
  () =>
    Effect.gen(function* targetReadTransport() {
      const projectId = Schema.decodeUnknownSync(ProjectUuidSchema)('30000000-0000-4000-8000-000000000001');
      const response = {
        createdAt: '2026-09-03T12:00:00.000Z',
        createdByPrincipalId: '20000000-0000-4000-8000-000000000002',
        lifecycleState: 'active',
        name: 'Project',
        ownerPrincipalId: '20000000-0000-4000-8000-000000000003',
        parentProjectId: null,
        prefix: 'ONTO',
        projectId,
        shortText: 'Original',
        tenantId: '10000000-0000-4000-8000-000000000001',
      };
      const decoded = Schema.decodeUnknownSync(ProjectSchema)(response);
      expect(decoded.projectId).toBe(projectId);
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json(response));
      };
      yield* executeReadProject({ projectId }, 'ordinary-project').pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      );
      yield* executeFreshReadProject({ projectId }, 'current-target').pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      );
      expect(requests.map(({ headers }) => headers.get('cache-control'))).toEqual([null, 'no-store']);
      expect(requests.map(({ headers }) => headers.get('authorization'))).toEqual([
        'Bearer test-transport-credential',
        'Bearer test-transport-credential',
      ]);
      expect(requests.map(({ headers }) => headers.get('x-ontos-composition-revision'))).toEqual([
        'a'.repeat(64),
        'a'.repeat(64),
      ]);
      expect(requests.map(({ headers }) => headers.get('x-correlation-id'))).toEqual([
        'ordinary-project',
        'current-target',
      ]);
      expect(requests.map(({ headers }) => headers.get('idempotency-key'))).toEqual([null, null]);
      expect(requests.map(({ url }) => url)).toEqual([
        'https://owner.example/projects-api/reads/read-project',
        'https://owner.example/projects-api/reads/read-project',
      ]);
      for (const request of requests) {
        expect(yield* Effect.promise(() => request.json())).toEqual({ projectId });
      }
    }),
);
