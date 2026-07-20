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
import { canonicalizeNumberValue } from '../../shared/number-value.ts';

interface DefinitionRow {
  readonly datatype: 'checkbox' | 'number';
  readonly format?: 'number' | 'number_with_separators' | 'percent';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

interface CheckboxValueRow {
  readonly propertyDefinitionId: string | null;
  readonly revision: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
  readonly value: boolean;
}

interface NumberValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

interface TaskRow {
  readonly checkboxValues: {
    propertyDefinitionId: string;
    revision: number;
    value: boolean;
  }[];
  readonly numberValues?: {
    propertyDefinitionId: string;
    revision: number;
    value: string;
  }[];
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
        definition.number_format as format,
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
        and definition.datatype in ('checkbox', 'number')
      order by definition.created_at, definition.property_definition_id
    `);
    const checkboxValueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
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
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const numberValueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId",
        value.value::text as value
      from ticketing.task_number_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const definitions = rowsFromResult<DefinitionRow>(definitionResult).map((definition) =>
      definition.datatype === 'number'
        ? definition
        : {
            datatype: definition.datatype,
            hidden: definition.hidden,
            mandatory: definition.mandatory,
            name: definition.name,
            propertyDefinitionId: definition.propertyDefinitionId,
            revision: definition.revision,
          },
    );
    const hasNumberDefinitions = definitions.some(({ datatype }) => datatype === 'number');
    const valueRows = rowsFromResult<CheckboxValueRow>(checkboxValueResult);
    const tasks = new Map<string, TaskRow>();

    for (const row of valueRows) {
      const current = tasks.get(row.taskId) ?? {
        checkboxValues: [],
        ...(hasNumberDefinitions ? { numberValues: [] } : {}),
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

    for (const row of rowsFromResult<NumberValueRow>(numberValueResult)) {
      const current = tasks.get(row.taskId);
      if (current === undefined) {
        continue;
      }
      current.numberValues?.push({
        propertyDefinitionId: row.propertyDefinitionId,
        revision: row.revision,
        value: row.value === null ? null : (canonicalizeNumberValue(row.value) ?? row.value),
      });
    }

    return {
      collectionId: input.collectionId,
      propertyDefinitions: [...definitions],
      tasks: [...tasks.values()],
    };
  },
};
