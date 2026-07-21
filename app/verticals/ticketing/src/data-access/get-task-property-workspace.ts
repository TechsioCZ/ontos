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
  readonly datatype: 'checkbox' | 'created_by' | 'created_time';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

interface ValueRow {
  readonly createdAt: string;
  readonly createdByDisplayName: string;
  readonly createdByPrincipalId: string;
  readonly createdByStatus: 'active' | 'archived' | 'disabled';
  readonly propertyDefinitionId: string | null;
  readonly revision: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
  readonly value: boolean;
}

interface TaskRow {
  readonly checkboxValues: {
    propertyDefinitionId: string;
    revision: number;
    value: boolean;
  }[];
  readonly createdAt: string;
  readonly createdBy: {
    displayName: string;
    inactive: boolean;
    principalId: string;
  };
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
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
        and definition.datatype in ('checkbox', 'created_time', 'created_by')
      order by definition.created_at, definition.property_definition_id
    `);
    const valueResult = await db.execute(sql`
      select
        to_char(
          task.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as "createdAt",
        creator.display_name as "createdByDisplayName",
        task.created_by_principal_id as "createdByPrincipalId",
        creator.status as "createdByStatus",
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        task.task_id as "taskId",
        task.revision as "taskRevision",
        task.title,
        value.value
      from ticketing.tasks as task
      inner join core.principals as creator
        on creator.principal_id = task.created_by_principal_id
        and creator.tenant_id = task.tenant_id
      left join ticketing.task_checkbox_values as value
        on value.task_id = task.task_id
        and value.tenant_id = task.tenant_id
      left join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const definitions = rowsFromResult<DefinitionRow>(definitionResult);
    const valueRows = rowsFromResult<ValueRow>(valueResult);
    const tasks = new Map<string, TaskRow>();

    for (const row of valueRows) {
      const current = tasks.get(row.taskId) ?? {
        checkboxValues: [],
        createdAt: row.createdAt,
        createdBy: {
          displayName: row.createdByDisplayName,
          inactive: row.createdByStatus !== 'active',
          principalId: row.createdByPrincipalId,
        },
        taskId: row.taskId,
        taskRevision: row.taskRevision,
        title: row.title,
      };
      if (row.propertyDefinitionId !== null) {
        current.checkboxValues.push({
          propertyDefinitionId: row.propertyDefinitionId,
          revision: row.revision,
          value: row.value,
        });
      }
      tasks.set(row.taskId, current);
    }

    return {
      collectionId: input.collectionId,
      propertyDefinitions: [...definitions],
      tasks: [...tasks.values()],
    };
  },
};
