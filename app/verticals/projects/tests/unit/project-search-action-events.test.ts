import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { ProjectPersistenceUnavailable } from '../../shared/domain/project.ts';
import { archiveProjectAction } from '../../src/actions/archive-project.action.ts';
import { createProjectAction } from '../../src/actions/create-project.action.ts';
import { moveProjectAction } from '../../src/actions/move-project.action.ts';
import { unarchiveProjectAction } from '../../src/actions/unarchive-project.action.ts';
import { updateProjectAction } from '../../src/actions/update-project.action.ts';
import { creatorId, ownerId, projectFixture, projectId, tenantId } from '../support/project.ts';

const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-search-events',
  authMethod: 'session',
  principalId: creatorId,
  tenantId,
} as const;
const transport = (key: string) => ({ correlationId: 'projects-search-events', idempotencyKey: key });

const unusedContextAccess: ContextAccessService = {
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
};

it.layer(Layer.succeed(ContextAccess, unusedContextAccess))('Projects search lifecycle Action events', (test) => {
  test.effect('all five real Actions commit an owner Domain Event suitable for an atomic generated search outbox', () =>
    Effect.gen(function* actionEvents() {
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
      expect(committed.flatMap(({ evidence }) => evidence.domainEvents.map((event) => event.eventType))).toEqual([
        'projects.project.created.v1',
        'projects.project.updated.v1',
        'projects.project.moved.v1',
        'projects.project.archived.v1',
        'projects.project.unarchived.v1',
      ]);
      expect(
        committed
          .flatMap(({ evidence }) => evidence.domainEvents)
          .every((event) => event.producerModuleKey === 'projects.core' && event.subjectResourceId === projectId),
      ).toBe(true);
    }),
  );

  test.effect(
    'failed owner persistence commits no event and never publishes a projection from the Action transaction',
    () =>
      Effect.gen(function* rollbackSafety() {
        const project = yield* projectFixture;
        const harness = yield* makeActionTestHarness({
          actionPermission: 'allowed',
          services: [
            bindActionTestServices(updateProjectAction, {
              findForLifecycleGuard: () => Effect.succeed({ _tag: 'found', value: project }),
              ownerEligibility: () => Effect.succeed('allowed'),
              update: () =>
                Effect.fail(
                  new ProjectPersistenceUnavailable({
                    code: 'project_persistence_unavailable',
                    reason: 'Test transaction failure',
                  }),
                ),
            }),
          ],
          tenantPermission: 'allowed',
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: { name: 'Must not appear in search', projectId },
            principal,
            registration: updateProjectAction,
            transport: transport('failure'),
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ProjectPersistenceUnavailable')).toBe(true);
        expect(harness.snapshot().committed).toEqual([]);
        // The scripted harness records the transient running stage without native rollback semantics.
        // No succeeded marker or committed business/event evidence may escape this failed attempt.
        expect(harness.snapshot().invocations[0]?.status).not.toBe('succeeded');
      }),
  );

  test.effect('current Action denial or uncertainty resolves before any owner mutation or event', () =>
    Effect.gen(function* currentAuthorization() {
      for (const actionPermission of ['denied', 'unavailable'] as const) {
        const harness = yield* makeActionTestHarness({
          actionPermission,
          services: [
            bindActionTestServices(moveProjectAction, {
              move: () => Effect.die('Denied or indeterminate Action must not move a Project'),
            }),
          ],
          tenantPermission: 'allowed',
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: { parentProjectId: null, projectId },
            principal,
            registration: moveProjectAction,
            transport: transport(actionPermission),
          })
          .pipe(Effect.flip);
        expect(
          Predicate.isTagged(
            failure,
            actionPermission === 'denied' ? 'ActionPermissionDenied' : 'ActionPermissionCheckError',
          ),
        ).toBe(true);
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }
    }),
  );
});
