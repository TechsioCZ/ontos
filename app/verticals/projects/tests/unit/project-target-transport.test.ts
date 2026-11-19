// @rstest-environment happy-dom
import {
  inProcessFetch,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
  testCompositionRevision,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ReadProjectApi } from '../../shared/apis/read-project.ts';
import { ProjectSchema, ProjectUuidSchema } from '../../shared/domain/project.ts';
import { executeFreshReadProject } from '../../src/api/projects-client.ts';
import { executeReadProject } from '../../src/api/read-project-client.ts';

it.live(
  'the actual generated owner client forwards fresh-read transport policy without changing the request or ordinary reads',
  () =>
    Effect.gen(function* targetReadTransport() {
      yield* pinTestDocument;
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
      const requests: { readonly body: unknown; readonly headers: Headers; readonly url: string }[] = [];
      const issuer = shellGatewayIssuer({ projects: '/projects-api' });
      const OwnerReadProjectApi = ReadProjectApi.prefix('/projects-api');
      const owner = serveApi(
        OwnerReadProjectApi,
        HttpApiBuilder.group(OwnerReadProjectApi, 'readProject', (group) =>
          group.handle('execute', () =>
            Effect.gen(function* receiveReadProject() {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const body = yield* request.json;
              requests.push({ body, headers: new Headers(request.headers), url: request.originalUrl });
              return decoded;
            }).pipe(Effect.orDie),
          ),
        ),
      );
      yield* Effect.gen(function* readProjectThroughGateway() {
        yield* executeReadProject({ projectId }, 'ordinary-project');
        yield* executeFreshReadProject({ projectId }, 'current-target');
      }).pipe(Effect.provide(inProcessFetch(issuer.application, owner)));
      expect(requests.map(({ headers }) => headers.get('cache-control'))).toEqual([null, 'no-store']);
      expect(requests.map(({ headers }) => headers.get('authorization'))).toEqual([
        'Bearer projects-assertion-1',
        'Bearer projects-assertion-2',
      ]);
      expect(requests.map(({ headers }) => headers.get('x-ontos-composition-revision'))).toEqual([
        testCompositionRevision,
        testCompositionRevision,
      ]);
      expect(requests.map(({ headers }) => headers.get('x-correlation-id'))).toEqual([
        'ordinary-project',
        'current-target',
      ]);
      expect(requests.map(({ headers }) => headers.get('idempotency-key'))).toEqual([null, null]);
      expect(requests.map(({ url }) => url)).toEqual([
        new URL('/projects-api/reads/read-project', window.location.href).href,
        new URL('/projects-api/reads/read-project', window.location.href).href,
      ]);
      for (const request of requests) {
        expect(request.body).toEqual({ projectId });
      }
    }),
);
