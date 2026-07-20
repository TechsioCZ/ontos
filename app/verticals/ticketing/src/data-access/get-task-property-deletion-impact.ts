// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  getTaskPropertyDeletionImpactPayloadSchema,
  taskPropertyDeletionImpactSchema,
} from '../../shared/task-property-deletion-impact.ts';
import type {
  GetTaskPropertyDeletionImpactPayload,
  TaskPropertyDeletionImpact,
} from '../../shared/task-property-deletion-impact.ts';

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
    const result = await db.execute(sql`
      select
        count(value.task_id)::integer as "impactCount",
        definition.property_definition_id as "propertyDefinitionId",
        definition.revision
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      left join ticketing.task_checkbox_values as value
        on value.property_definition_id = definition.property_definition_id
        and value.tenant_id = definition.tenant_id
      left join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.datatype = 'checkbox'
        and definition.tenant_id = ${context.tenantId}
        and schema.collection_id = ${input.collectionId}
      group by definition.property_definition_id, definition.revision
    `);
    const impact = rowsFromResult<TaskPropertyDeletionImpact>(result).at(0);
    if (impact === undefined) {
      throw new Error('Task Property Definition was not found.');
    }
    return impact;
  },
};
