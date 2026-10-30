import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { createProjectAction } from '../../src/actions/create-project.action.ts';
import { updateProjectAction } from '../../src/actions/update-project.action.ts';
import { creatorId, ownerId, projectFixture, projectId, tenantId } from '../support/project.ts';

const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-runtime',
  authMethod: 'session',
  principalId: creatorId,
  tenantId,
} as const;
const transport = { correlationId: 'projects-runtime', idempotencyKey: 'projects-create-once' };

const unusedContextAccess: ContextAccessService = {
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
};

it.layer(Layer.succeed(ContextAccess, unusedContextAccess))('Projects Action lifecycle', (test) => {
  test.effect('Create uses trusted actor metadata, settles evidence, and never repeats a committed write', () =>
    Effect.gen(function* createThroughRuntime() {
      const project = yield* projectFixture;
      let writes = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(createProjectAction, {
            create: (_payload, createdByPrincipalId) => {
              writes += 1;
              return Effect.succeed({ ...project, createdByPrincipalId });
            },
            ownerEligibility: () => Effect.succeed('allowed'),
          }),
        ],
        tenantPermission: 'allowed',
      });
      const request = {
        payload: { name: 'Project', ownerPrincipalId: ownerId, prefix: 'ONTO' },
        principal,
        registration: createProjectAction,
        transport,
      };
      const result = yield* harness.runtime.runAction(request);
      expect(result.createdByPrincipalId).toBe(creatorId);
      expect(result.ownerPrincipalId).toBe(ownerId);
      const repeated = yield* harness.runtime.runAction(request).pipe(Effect.flip);
      expect(Predicate.isTagged(repeated, 'ActionAlreadyCommitted')).toBe(true);
      expect(writes).toBe(1);
      const snapshot = harness.snapshot();
      expect(snapshot.committed).toHaveLength(1);
      expect(snapshot.stages).toContain('success_evidence_flushed');
      expect(snapshot.committed[0]?.evidence.domainEvents).toHaveLength(1);
      expect(snapshot.committed[0]?.evidence.dataAccessEvents).toHaveLength(1);
    }),
  );

  test.effect('Update permission denial occurs before owner services or writes', () =>
    Effect.gen(function* deniedUpdate() {
      const project = yield* projectFixture;
      let ownerCalls = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'denied',
        services: [
          bindActionTestServices(updateProjectAction, {
            findForLifecycleGuard: () => {
              ownerCalls += 1;
              return Effect.succeed({ _tag: 'found', value: project });
            },
            ownerEligibility: () => Effect.succeed('allowed'),
            update: () => {
              ownerCalls += 1;
              return Effect.succeed(project);
            },
          }),
        ],
        tenantPermission: 'allowed',
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: { name: 'Unauthorized', projectId },
          principal,
          registration: updateProjectAction,
          transport,
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
      expect(ownerCalls).toBe(0);
      expect(harness.snapshot().committed).toHaveLength(0);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
    }),
  );
});
