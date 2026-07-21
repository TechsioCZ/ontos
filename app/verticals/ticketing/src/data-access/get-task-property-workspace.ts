// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  getTaskPropertyWorkspacePayloadSchema,
  taskPropertyWorkspaceSchema,
} from '../../shared/task-property-workspace.ts';
import type {
  GetTaskPropertyWorkspacePayload,
  TaskPropertyWorkspace,
} from '../../shared/task-property-workspace.ts';

interface DefinitionRow {
  readonly datatype: 'checkbox' | 'phone';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

interface CheckboxValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: boolean;
}

interface PhoneValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string;
}

interface TaskDatabaseRow {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
}

interface TaskRow extends TaskDatabaseRow {
  readonly checkboxValues: {
    propertyDefinitionId: string;
    revision: number;
    value: boolean;
  }[];
  readonly phoneValues: {
    propertyDefinitionId: string;
    revision: number;
    value: string;
  }[];
}

export const getTaskPropertyWorkspaceDataAccessRegistration: DataAccessRegistration<
  GetTaskPropertyWorkspacePayload,
  TaskPropertyWorkspace
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'standard',
    authorization: {
      permission: 'view_task_properties',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.taskPropertyWorkspace.get',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskPropertyWorkspace.get.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_collection',
    transportRequestSchema: getTaskPropertyWorkspacePayloadSchema,
    transportResponseSchema: taskPropertyWorkspaceSchema,
  },
  handler: async (input, { context, db }) => {
    const definitionResult = await db.execute(sql`
      select
        definition.datatype,
        definition.hidden,
        definition.mandatory,
        definition.name,
        definition.property_definition_id as "propertyDefinitionId",
        definition.revision
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where schema.collection_id = ${input.collectionId}
        and definition.tenant_id = ${context.tenantId}
        and definition.datatype in ('checkbox', 'phone')
      order by definition.created_at, definition.property_definition_id
    `);
    const taskResult = await db.execute(sql`
      select
        task.task_id as "taskId",
        task.revision as "taskRevision",
        task.title
      from ticketing.tasks as task
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id
    `);
    const checkboxResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId",
        value.value
      from ticketing.task_checkbox_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'checkbox'
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by definition.created_at, value.property_definition_id
    `);
    const phoneResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId",
        value.value
      from ticketing.task_phone_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'phone'
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by definition.created_at, value.property_definition_id
    `);
    const tasks = new Map<string, TaskRow>(
      rowsFromResult<TaskDatabaseRow>(taskResult).map((task) => [
        task.taskId,
        { ...task, checkboxValues: [], phoneValues: [] },
      ]),
    );

    for (const row of rowsFromResult<CheckboxValueRow>(checkboxResult)) {
      tasks.get(row.taskId)?.checkboxValues.push({
        propertyDefinitionId: row.propertyDefinitionId,
        revision: row.revision,
        value: row.value,
      });
    }
    for (const row of rowsFromResult<PhoneValueRow>(phoneResult)) {
      tasks.get(row.taskId)?.phoneValues.push({
        propertyDefinitionId: row.propertyDefinitionId,
        revision: row.revision,
        value: row.value,
      });
    }

    return {
      collectionId: input.collectionId,
      propertyDefinitions: [...rowsFromResult<DefinitionRow>(definitionResult)],
      tasks: [...tasks.values()],
    };
  },
};
