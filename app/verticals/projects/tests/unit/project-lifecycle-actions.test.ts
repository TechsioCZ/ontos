import { expect, it } from 'effect-rstest';
import { archiveProjectAction } from '../../src/actions/archive-project.action.ts';
import { unarchiveProjectAction } from '../../src/actions/unarchive-project.action.ts';

it('declares separate idempotent governed lifecycle Actions with durable events', () => {
  expect(archiveProjectAction.descriptor.entrypoint.authorization).toEqual({
    kind: 'action_execution',
    provisioning: 'explicit',
  });
  expect(archiveProjectAction.descriptor.idempotency).toBe('required');
  expect(Object.keys(archiveProjectAction.descriptor.domainEvents)).toEqual(['projects.project.archived.v1']);
  expect(Object.keys(unarchiveProjectAction.descriptor.domainEvents)).toEqual(['projects.project.unarchived.v1']);
});
