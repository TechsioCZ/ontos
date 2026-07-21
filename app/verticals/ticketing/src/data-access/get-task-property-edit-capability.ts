import type { DataAccessRegistration } from '@app/core-runtime';
import {
  getTaskPropertyEditCapabilityPayloadSchema,
  taskPropertyEditCapabilitySchema,
} from '../../shared/task-property-edit-capability.ts';
import type {
  GetTaskPropertyEditCapabilityPayload,
  TaskPropertyEditCapability,
} from '../../shared/task-property-edit-capability.ts';

export const getTaskPropertyEditCapabilityDataAccessRegistration: DataAccessRegistration<
  GetTaskPropertyEditCapabilityPayload,
  TaskPropertyEditCapability
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'minimal',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.taskPropertyEditCapability.get',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskPropertyEditCapability.get.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_collection',
    transportRequestSchema: getTaskPropertyEditCapabilityPayloadSchema,
    transportResponseSchema: taskPropertyEditCapabilitySchema,
  },
  handler: () => ({ canEdit: true }),
};
