import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { archiveProjectAction } from '../../src/actions/archive-project.action.ts';
import { createProjectAction } from '../../src/actions/create-project.action.ts';
import { moveProjectAction } from '../../src/actions/move-project.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { unarchiveProjectAction } from '../../src/actions/unarchive-project.action.ts';
import { updateProjectAction } from '../../src/actions/update-project.action.ts';
import { creatorId, ownerId, projectFixture, projectId, tenantId } from '../support/project.ts';

const projectModuleKey = 'projects.core';
const refreshTopic = 'projects.core.search-refresh-requested.v1';
const rebuildTopic = 'projects.core.search-rebuild-requested.v1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-search-outbox',
  authMethod: 'session',
  principalId: creatorId,
  tenantId,
} as const;
const transport = (key: string) => ({ correlationId: 'projects-search-outbox', idempotencyKey: key });

const unusedContextAccess: ContextAccessService = {
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
};

it.layer(Layer.succeed(ContextAccess, unusedContextAccess))('Projects search committed outbox requests', (test) => {
  test.effect(
    'every lifecycle Action commits one tenant-wide refresh request in the same transaction as its business event',
    () =>
      Effect.gen(function* lifecycleRequests() {
        const project = yield* projectFixture;
        const harness = yield* makeActionTestHarness({
          actionPermission: 'allowed',
          services: [
            bindActionTestServices(createProjectAction, {
              create: () => Effect.succeed(project),
              ownerEligibility: () => Effect.succeed('allowed'),
            }),
            bindActionTestServices(updateProjectAction, {
              findForLifecycleGuard: () => Effect.succeed({ _tag: 'found', value: project }),
              ownerEligibility: () => Effect.succeed('allowed'),
              update: (values) => Effect.succeed({ ...project, name: values.name }),
            }),
            bindActionTestServices(moveProjectAction, {
              move: (_id, parentProjectId) =>
                Effect.succeed({ ...project, parentProjectId: Option.fromNullOr(parentProjectId) }),
            }),
            bindActionTestServices(archiveProjectAction, {
              archive: () => Effect.succeed({ ...project, lifecycleState: 'archived' }),
            }),
            bindActionTestServices(unarchiveProjectAction, {
              unarchive: () => Effect.succeed(project),
            }),
          ],
          tenantPermission: 'allowed',
        });
        yield* harness.runtime.runAction({
          payload: { name: project.name, ownerPrincipalId: ownerId, prefix: project.prefix },
          principal,
          registration: createProjectAction,
          transport: transport('create'),
        });
        yield* harness.runtime.runAction({
          payload: { name: 'Renamed Project', projectId },
          principal,
          registration: updateProjectAction,
          transport: transport('update'),
        });
        yield* harness.runtime.runAction({
          payload: { parentProjectId: null, projectId },
          principal,
          registration: moveProjectAction,
          transport: transport('move'),
        });
        yield* harness.runtime.runAction({
          payload: { projectId },
          principal,
          registration: archiveProjectAction,
          transport: transport('archive'),
        });
        yield* harness.runtime.runAction({
          payload: { projectId },
          principal,
          registration: unarchiveProjectAction,
          transport: transport('restore'),
        });
        const { committed } = harness.snapshot();
        expect(committed).toHaveLength(5);
        // The business events stay exactly the business events; the request rides them instead of inventing new ones.
        expect(committed.flatMap(({ evidence }) => evidence.domainEvents.map((event) => event.eventType))).toEqual([
          'projects.project.created.v1',
          'projects.project.updated.v1',
          'projects.project.moved.v1',
          'projects.project.archived.v1',
          'projects.project.unarchived.v1',
        ]);
        const requests = committed.flatMap(({ actionInvocationId, evidence }) =>
          evidence.outboxMessages.map(({ domainEventIndex, message }) => ({
            actionInvocationId,
            domainEventIndex,
            payloadJson: message.payloadJson,
            producerModuleKey: message.producerModuleKey,
            topic: message.topic,
          })),
        );
        expect(requests).toHaveLength(5);
        for (const request of requests) {
          expect(request.topic).toBe(refreshTopic);
          expect(request.producerModuleKey).toBe(projectModuleKey);
          // Atomic with the single business event of the same invocation.
          expect(request.domainEventIndex).toBe(0);
          expect(request.payloadJson).toEqual({ requestId: request.actionInvocationId });
          expect(uuidPattern.test(request.actionInvocationId)).toBe(true);
        }
      }),
  );

  test.effect('the authorized rebuild Action commits a QUEUED request and performs no owner read or index write', () =>
    Effect.gen(function* rebuildRequest() {
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [bindActionTestServices(requestSearchRebuildAction, {})],
        tenantPermission: 'allowed',
      });
      const result = yield* harness.runtime.runAction({
        payload: {},
        principal,
        registration: requestSearchRebuildAction,
        transport: transport('rebuild'),
      });
      const { committed } = harness.snapshot();
      expect(committed).toHaveLength(1);
      const [entry] = committed;
      expect(entry?.evidence.domainEvents.map((event) => event.eventType)).toEqual([rebuildTopic]);
      expect(entry?.evidence.dataAccessEvents).toEqual([]);
      expect(entry?.evidence.outboxMessages).toHaveLength(1);
      expect(entry?.evidence.outboxMessages[0]?.domainEventIndex).toBe(0);
      expect(entry?.evidence.outboxMessages[0]?.message.topic).toBe(rebuildTopic);
      expect(entry?.evidence.outboxMessages[0]?.message.producerModuleKey).toBe(projectModuleKey);
      expect(entry?.evidence.outboxMessages[0]?.message.payloadJson).toEqual({ requestId: entry?.actionInvocationId });
      expect(result).toEqual({ requestId: entry?.actionInvocationId, status: 'QUEUED' });
    }),
  );

  test.effect('a denied Action executor commits no rebuild request, no event and no owner write', () =>
    Effect.gen(function* deniedExecutor() {
      const harness = yield* makeActionTestHarness({
        actionPermission: 'denied',
        services: [bindActionTestServices(requestSearchRebuildAction, {})],
        tenantPermission: 'allowed',
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: {},
          principal,
          registration: requestSearchRebuildAction,
          transport: transport('denied-rebuild'),
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
      const snapshot = harness.snapshot();
      // No domain event, no committed outbox request and no owner transaction may escape the denial.
      expect(snapshot.committed).toEqual([]);
      expect(snapshot.stages).not.toContain('handler_executed');
      expect(snapshot.transactionCount).toBe(0);
    }),
  );
});
