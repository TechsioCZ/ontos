// @effect-diagnostics asyncFunction:off
import type { DataAccessRegistration } from '@app/core-runtime';
import {
  getTaskPropertyDeletionImpactPayloadSchema,
  taskPropertyDeletionImpactSchema,
} from '../../shared/task-property-deletion-impact.ts';
import type {
  GetTaskPropertyDeletionImpactPayload,
  TaskPropertyDeletionImpact,
} from '../../shared/task-property-deletion-impact.ts';
import {
  findTaskPropertyDefinitionLifecycleTarget,
  getTaskPropertyDefinitionDeletionImpact,
} from '../task-property-definition-lifecycle.ts';

export const getTaskPropertyDeletionImpactDataAccessRegistration: DataAccessRegistration<
  GetTaskPropertyDeletionImpactPayload,
  TaskPropertyDeletionImpact
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.taskPropertyDeletionImpact.get',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskPropertyDeletionImpact.get.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: getTaskPropertyDeletionImpactPayloadSchema,
    transportResponseSchema: taskPropertyDeletionImpactSchema,
  },
  handler: async (input, { context, db }) => {
    const target = await findTaskPropertyDefinitionLifecycleTarget({
      collectionId: input.collectionId,
      db,
      propertyDefinitionId: input.propertyDefinitionId,
      tenantId: context.tenantId,
    });
    if (target === undefined) {
      throw new Error('Task Property Definition was not found.');
    }
    return getTaskPropertyDefinitionDeletionImpact({ db, target });
  },
};
