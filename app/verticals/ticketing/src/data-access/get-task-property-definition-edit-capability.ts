import type { DataAccessRegistration } from '@app/core-runtime';
import {
  getTaskPropertyEditCapabilityPayloadSchema,
  taskPropertyDefinitionEditCapabilitySchema,
} from '../../shared/task-property-edit-capability.ts';
import type {
  GetTaskPropertyEditCapabilityPayload,
  TaskPropertyDefinitionEditCapability,
} from '../../shared/task-property-edit-capability.ts';

export const getTaskPropertyDefinitionEditCapabilityDataAccessRegistration: DataAccessRegistration<
  GetTaskPropertyEditCapabilityPayload,
  TaskPropertyDefinitionEditCapability
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'minimal',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.taskPropertyDefinitionEditCapability.get',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskPropertyDefinitionEditCapability.get.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_collection',
    transportRequestSchema: getTaskPropertyEditCapabilityPayloadSchema,
    transportResponseSchema: taskPropertyDefinitionEditCapabilitySchema,
  },
  handler: () => ({ canEditDefinitions: true }),
};
