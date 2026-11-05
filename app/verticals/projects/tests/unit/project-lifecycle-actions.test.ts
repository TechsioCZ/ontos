import { ActionPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { projectsRegistration } from '../../vertical.registration.ts';

import { archiveProjectAction } from '../../src/actions/archive-project.action.ts';
import { unarchiveProjectAction } from '../../src/actions/unarchive-project.action.ts';
import { creatorId, projectFixture, projectId, tenantId } from '../support/project.ts';

const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-runtime',
  authMethod: 'session',
  principalId: creatorId,
  tenantId,
} as const;

/** The trusted scope a record target is resolved in; the payload-derived target reads only its record. */
const scope = Object.freeze({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:projects-runtime',
    authMethod: 'session',
    principalId: creatorId,
    tenantId,
  }),
  correlationId: 'projects-target',
});

it('declares separate idempotent protected lifecycle Actions whose gate names the Project record', () => {
  expect(archiveProjectAction.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(archiveProjectAction.descriptor.idempotency).toBe('required');
  expect(archiveProjectAction.descriptor.accessDeclaration?.key).toBe('projects.core.project.archive');
  expect(archiveProjectAction.descriptor.accessDeclaration?.selectors).toEqual(['all', 'assigned']);
  expect(archiveProjectAction.descriptor.accessTarget?.({ projectId }, scope)).toEqual({
    moduleKey: 'projects.core',
    recordKey: projectId,
  });
  expect(unarchiveProjectAction.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(unarchiveProjectAction.descriptor.accessDeclaration?.key).toBe('projects.core.project.unarchive');
  expect(Object.keys(archiveProjectAction.descriptor.domainEvents)).toEqual(['projects.project.archived.v1']);
  expect(Object.keys(unarchiveProjectAction.descriptor.domainEvents)).toEqual(['projects.project.unarchived.v1']);
});

it.effect('refuses an archived Project whose gate denies the record and runs it when allowed', () =>
  Effect.gen(function* archiveGate() {
    const project = yield* projectFixture;
    let transitions = 0;
    const services = [
      bindActionTestServices(archiveProjectAction, {
        archive: () => {
          transitions += 1;
          return Effect.succeed(project);
        },
      }),
    ];
    const request = {
      payload: { projectId },
      principal,
      registration: archiveProjectAction,
      transport: { correlationId: 'projects-archive', idempotencyKey: 'projects-archive-once' },
    };
    const denied = yield* makeActionTestHarness({
      access: 'denied',
      ownerRegistration: projectsRegistration,
      services,
    });
    const refusal = yield* denied.runtime.runAction(request).pipe(Effect.flip);
    expect(Schema.is(ActionPermissionDenied)(refusal)).toBe(true);
    expect(transitions).toBe(0);
    expect(denied.snapshot().stages).not.toContain('handler_executed');
    expect(denied.snapshot().committed).toHaveLength(0);

    const allowed = yield* makeActionTestHarness({
      access: 'allowed',
      ownerRegistration: projectsRegistration,
      services,
    });
    expect((yield* allowed.runtime.runAction(request)).projectId).toBe(projectId);
    expect(transitions).toBe(1);
    expect(allowed.snapshot().committed).toHaveLength(1);
  }),
);
