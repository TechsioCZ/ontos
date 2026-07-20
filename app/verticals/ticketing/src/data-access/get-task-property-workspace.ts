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
import type {
  CheckboxPropertyDefinition,
  SelectOption,
  SelectOptionOrderMode,
  SelectPropertyDefinition,
  TaskPropertyDefinition,
} from '../../shared/task-property-definition.ts';
import { orderSelectOptions } from '../select-option-order.ts';

interface DefinitionRow {
  readonly datatype: 'checkbox' | 'select';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly optionOrderMode: SelectOptionOrderMode | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}
interface OptionRow extends SelectOption {
  readonly propertyDefinitionId: string;
}
interface TaskRow {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
}
interface CheckboxValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: boolean;
}
interface SelectValueRow {
  readonly optionId: string | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
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
    const [definitionResult, optionResult, taskResult, checkboxValueResult, selectValueResult] =
      await Promise.all([
        db.execute(sql`
          select
            definition.datatype,
            definition.hidden,
            definition.mandatory,
            definition.name,
            definition.select_option_order_mode as "optionOrderMode",
            definition.property_definition_id as "propertyDefinitionId",
            definition.revision
          from ticketing.task_property_definitions as definition
          inner join ticketing.task_schemas as schema
            on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
          where schema.collection_id = ${input.collectionId}
            and definition.tenant_id = ${context.tenantId}
            and definition.datatype in ('checkbox', 'select')
          order by definition.created_at, definition.property_definition_id
        `),
        db.execute(sql`
          select
            option.color,
            option.manual_position as "manualPosition",
            option.name,
            option.option_id as "optionId",
            option.property_definition_id as "propertyDefinitionId",
            option.revision
          from ticketing.select_options as option
          inner join ticketing.task_property_definitions as definition
            on definition.property_definition_id = option.property_definition_id and definition.tenant_id = option.tenant_id
          inner join ticketing.task_schemas as schema
            on schema.schema_id = definition.schema_id and schema.tenant_id = definition.tenant_id
          where schema.collection_id = ${input.collectionId} and option.tenant_id = ${context.tenantId}
        `),
        db.execute(sql`
          select task.task_id as "taskId", task.revision as "taskRevision", task.title
          from ticketing.tasks as task
          where task.collection_id = ${input.collectionId} and task.tenant_id = ${context.tenantId}
          order by task.created_at, task.task_id
        `),
        db.execute(sql`
          select value.property_definition_id as "propertyDefinitionId", value.revision, value.task_id as "taskId", value.value
          from ticketing.task_checkbox_values as value
          inner join ticketing.tasks as task on task.task_id = value.task_id and task.tenant_id = value.tenant_id
          inner join ticketing.task_property_definitions as definition
            on definition.property_definition_id = value.property_definition_id and definition.tenant_id = value.tenant_id
          where task.collection_id = ${input.collectionId} and value.tenant_id = ${context.tenantId}
          order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
        `),
        db.execute(sql`
          select value.option_id as "optionId", value.property_definition_id as "propertyDefinitionId", value.revision, value.task_id as "taskId"
          from ticketing.task_select_values as value
          inner join ticketing.tasks as task on task.task_id = value.task_id and task.tenant_id = value.tenant_id
          inner join ticketing.task_property_definitions as definition
            on definition.property_definition_id = value.property_definition_id and definition.tenant_id = value.tenant_id
          where task.collection_id = ${input.collectionId} and value.tenant_id = ${context.tenantId}
          order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
        `),
      ]);
    const optionRows = rowsFromResult<OptionRow>(optionResult);
    const locale = input.locale ?? 'en-GB';
    const propertyDefinitions: TaskPropertyDefinition[] = rowsFromResult<DefinitionRow>(
      definitionResult,
    ).map((definition) => {
      if (definition.datatype === 'checkbox') {
        const checkbox: CheckboxPropertyDefinition = {
          datatype: 'checkbox',
          hidden: definition.hidden,
          mandatory: definition.mandatory,
          name: definition.name,
          propertyDefinitionId: definition.propertyDefinitionId,
          revision: definition.revision,
        };
        return checkbox;
      }
      const select: SelectPropertyDefinition = {
        datatype: 'select',
        hidden: definition.hidden,
        mandatory: definition.mandatory,
        name: definition.name,
        optionOrderMode: definition.optionOrderMode ?? 'manual',
        options: orderSelectOptions(
          optionRows
            .filter((option) => option.propertyDefinitionId === definition.propertyDefinitionId)
            .map(({ propertyDefinitionId: _propertyDefinitionId, ...option }) => option),
          definition.optionOrderMode ?? 'manual',
          locale,
        ),
        propertyDefinitionId: definition.propertyDefinitionId,
        revision: definition.revision,
      };
      return select;
    });
    const checkboxValues = rowsFromResult<CheckboxValueRow>(checkboxValueResult);
    const selectValues = rowsFromResult<SelectValueRow>(selectValueResult);
    return {
      collectionId: input.collectionId,
      propertyDefinitions,
      tasks: rowsFromResult<TaskRow>(taskResult).map((task) => {
        const taskSelectValues = selectValues
          .filter((value) => value.taskId === task.taskId)
          .map(({ optionId, taskId: _taskId, ...value }) => ({
            ...(optionId === null ? {} : { optionId }),
            ...value,
          }));
        return {
          checkboxValues: checkboxValues
            .filter((value) => value.taskId === task.taskId)
            .map(({ taskId: _taskId, ...value }) => value),
          ...(taskSelectValues.length === 0 ? {} : { selectValues: taskSelectValues }),
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          title: task.title,
        };
      }),
    };
  },
};
