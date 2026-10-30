import { Schema } from 'effect';
import { ProjectSchema } from '../../shared/domain/project.ts';

export const tenantId = '10000000-0000-4000-8000-000000000001';
export const ownerId = '20000000-0000-4000-8000-000000000001';
export const creatorId = '20000000-0000-4000-8000-000000000002';
export const projectId = '30000000-0000-4000-8000-000000000001';
export const projectFixture = Schema.decodeUnknownEffect(ProjectSchema)({
  createdAt: '2026-09-03T12:00:00.000Z',
  createdByPrincipalId: creatorId,
  lifecycleState: 'active',
  name: 'Project',
  ownerPrincipalId: ownerId,
  parentProjectId: null,
  prefix: 'ONTO',
  projectId,
  shortText: 'Original',
  tenantId,
});
