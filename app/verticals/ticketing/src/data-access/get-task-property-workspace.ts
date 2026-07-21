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
import { taskPropertyDefinitionFromRow } from '../task-property-definition-projection.ts';
import type { TaskPropertyDefinitionRow } from '../task-property-definition-projection.ts';

interface ValueRow {
  readonly idNumber: string | null;
  readonly idPrefix: string | null;
  readonly idPropertyDefinitionId: string | null;
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
  idAssignment?: {
    displayValue: string;
    number: string;
    propertyDefinitionId: string;
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
        definition.prefix,
        definition.property_definition_id as "propertyDefinitionId",
        definition.revision
      from ticketing.task_property_definitions as definition
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where schema.collection_id = ${input.collectionId}
        and definition.tenant_id = ${context.tenantId}
        and definition.datatype in ('checkbox', 'id')
      order by definition.created_at, definition.property_definition_id
    `);
    const valueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        id_assignment.number::text as "idNumber",
        id_definition.prefix as "idPrefix",
        id_assignment.property_definition_id as "idPropertyDefinitionId",
        value.revision,
        task.task_id as "taskId",
        task.revision as "taskRevision",
        task.title,
        value.value
      from ticketing.tasks as task
      left join ticketing.task_checkbox_values as value
        on value.task_id = task.task_id
        and value.tenant_id = task.tenant_id
      left join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
      left join ticketing.task_id_assignments as id_assignment
        on id_assignment.task_id = task.task_id
        and id_assignment.tenant_id = task.tenant_id
      left join ticketing.task_property_definitions as id_definition
        on id_definition.property_definition_id = id_assignment.property_definition_id
        and id_definition.tenant_id = id_assignment.tenant_id
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
      order by task.created_at, task.creation_ordinal, definition.created_at, value.property_definition_id
    `);
    const definitions = rowsFromResult<TaskPropertyDefinitionRow>(definitionResult);
    const valueRows = rowsFromResult<ValueRow>(valueResult);
    const tasks = new Map<string, TaskRow>();

    for (const row of valueRows) {
      const current: TaskRow = tasks.get(row.taskId) ?? {
        checkboxValues: [],
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
      if (row.idNumber !== null && row.idPrefix !== null && row.idPropertyDefinitionId !== null) {
        current.idAssignment = {
          displayValue:
            row.idPrefix.length === 0 ? row.idNumber : `${row.idPrefix}-${row.idNumber}`,
          number: row.idNumber,
          propertyDefinitionId: row.idPropertyDefinitionId,
        };
      }
      tasks.set(row.taskId, current);
    }

    const propertyDefinitions = definitions.map(taskPropertyDefinitionFromRow);
    const idGroups = [...tasks.values()]
      .filter(
        (task): task is TaskRow & { readonly idAssignment: NonNullable<TaskRow['idAssignment']> } =>
          task.idAssignment !== undefined,
      )
      .map((task) => ({ number: task.idAssignment.number, taskIds: [task.taskId] }));

    return {
      collectionId: input.collectionId,
      idGroups,
      propertyDefinitions,
      tasks: [...tasks.values()],
    };
  },
};
