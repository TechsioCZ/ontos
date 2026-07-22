// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  getTaskCollectionPayloadSchema,
  taskCollectionAggregateSchema,
} from '../../shared/task-collection.ts';
import type {
  GetTaskCollectionPayload,
  TaskCollectionAggregate,
} from '../../shared/task-collection.ts';
import { taskCollectionAggregateFromRow } from '../task-collection-aggregate.ts';
import type { TaskCollectionAggregateRow } from '../task-collection-aggregate.ts';

export const getTaskCollectionDataAccessRegistration: DataAccessRegistration<
  GetTaskCollectionPayload,
  TaskCollectionAggregate
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'standard',
    dataAccessKey: 'ticketing.taskCollection.get',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskCollection.get.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_collection',
    transportRequestSchema: getTaskCollectionPayloadSchema,
    transportResponseSchema: taskCollectionAggregateSchema,
  },
  handler: async (input, { context, db }) => {
    const result = await db.execute(sql`
      select
        task.canvas,
        collection.collection_id as "collectionId",
        to_char(
          collection.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as "collectionCreatedAt",
        collection.name as "collectionName",
        schema.schema_id as "schemaId",
        definition.datatype as "datatype",
        definition.mandatory as "mandatory",
        definition.name as "name",
        definition.property_definition_id as "propertyDefinitionId",
        to_char(
          task.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as "createdAt",
        task.created_by_principal_id as "createdByPrincipalId",
        to_char(
          task.last_edited_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as "lastEditedAt",
        task.last_edited_by_principal_id as "lastEditedByPrincipalId",
        task.revision as "revision",
        task.task_id as "taskId",
        task.title as "title"
      from ticketing.task_collections as collection
      inner join ticketing.task_schemas as schema
        on schema.collection_id = collection.collection_id
        and schema.tenant_id = collection.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.tenant_id = collection.tenant_id
        and definition.datatype = 'title'
      inner join ticketing.tasks as task
        on task.collection_id = collection.collection_id
        and task.tenant_id = collection.tenant_id
      where collection.collection_id = ${input.collectionId}
        and collection.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id
      limit 1
    `);
    const aggregate = rowsFromResult<TaskCollectionAggregateRow>(result).at(0);

    if (aggregate === undefined || aggregate.datatype !== 'title') {
      throw new Error('Task Collection was not found or is incomplete.');
    }

    return taskCollectionAggregateFromRow(aggregate);
  },
};
