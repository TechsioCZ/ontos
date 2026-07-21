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
import type { TextDocument } from '../../shared/text-property.ts';
import { canonicalizeNumberValue } from '../../shared/number-value.ts';
import type {
  SelectOption,
  SelectOptionOrderMode,
  TaskPropertyDefinition,
} from '../../shared/task-property-definition.ts';
import { orderSelectOptions } from '../select-option-order.ts';

interface DefinitionFields {
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

type DefinitionRow =
  | (DefinitionFields & { readonly datatype: 'checkbox' })
  | (DefinitionFields & { readonly datatype: 'email' })
  | (DefinitionFields & { readonly datatype: 'files_media' })
  | (DefinitionFields & {
      readonly datatype: 'number';
      readonly format: 'number' | 'number_with_separators' | 'percent';
    })
  | (DefinitionFields & {
      readonly datatype: 'select';
      readonly optionOrderMode: SelectOptionOrderMode | null;
    })
  | (DefinitionFields & { readonly datatype: 'phone' })
  | (DefinitionFields & { readonly datatype: 'text' })
  | (DefinitionFields & { readonly datatype: 'url' });

interface OptionRow extends SelectOption {
  readonly propertyDefinitionId: string;
}

const taskPropertyDefinitionFromRow = (
  definition: DefinitionRow,
  optionRows: readonly OptionRow[],
  locale: string,
): TaskPropertyDefinition => {
  if (definition.datatype === 'number') {
    return definition;
  }
  if (definition.datatype === 'select') {
    const optionOrderMode = definition.optionOrderMode ?? 'manual';
    return {
      datatype: 'select',
      hidden: definition.hidden,
      mandatory: definition.mandatory,
      name: definition.name,
      optionOrderMode,
      options: orderSelectOptions(
        optionRows
          .filter((option) => option.propertyDefinitionId === definition.propertyDefinitionId)
          .map(({ propertyDefinitionId: _propertyDefinitionId, ...option }) => option),
        optionOrderMode,
        locale,
      ),
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: definition.revision,
    };
  }
  return {
    datatype: definition.datatype,
    hidden: definition.hidden,
    mandatory: definition.mandatory,
    name: definition.name,
    propertyDefinitionId: definition.propertyDefinitionId,
    revision: definition.revision,
  };
};

interface NumberValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

interface EmailValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

interface PhoneValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string;
}

interface TextValueRow {
  readonly document: TextDocument | null;
  readonly propertyDefinitionId: string;
  readonly readableText: string | null;
  readonly revision: number;
  readonly taskId: string;
}

interface SelectValueRow {
  readonly optionId: string | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
}

interface UrlValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

interface ValueRow {
  readonly propertyDefinitionId: string | null;
  readonly revision: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
  readonly value: boolean;
}

interface FilesMediaItemRow {
  readonly access: 'download';
  readonly byteSize: number;
  readonly displayFilename: string;
  readonly effectiveMimeType: string;
  readonly itemId: string;
  readonly mediaAssetId: string;
  readonly position: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
}

interface TaskRow {
  readonly checkboxValues: {
    propertyDefinitionId: string;
    revision: number;
    value: boolean;
  }[];
  readonly emailValues: {
    propertyDefinitionId: string;
    revision: number;
    value: string | null;
  }[];
  readonly filesMediaItems: Omit<FilesMediaItemRow, 'taskId'>[];
  numberValues?: {
    propertyDefinitionId: string;
    revision: number;
    value: string | null;
  }[];
  readonly phoneValues: {
    propertyDefinitionId: string;
    revision: number;
    value: string;
  }[];
  selectValues?: {
    optionId?: string;
    propertyDefinitionId: string;
    revision: number;
  }[];
  readonly taskId: string;
  readonly taskRevision: number;
  textValues?: {
    document: TextDocument | null;
    propertyDefinitionId: string;
    readableText: string | null;
    revision: number;
  }[];
  readonly title: string;
  readonly urlValues?: {
    propertyDefinitionId: string;
    revision: number;
    value: string | null;
  }[];
}

const appendUrlValues = (tasks: Map<string, TaskRow>, rows: readonly UrlValueRow[]): void => {
  for (const row of rows) {
    const task = tasks.get(row.taskId);
    if (task !== undefined) {
      task.urlValues?.push({
        propertyDefinitionId: row.propertyDefinitionId,
        revision: row.revision,
        value: row.value,
      });
    }
  }
};

const appendSelectValues = (tasks: Map<string, TaskRow>, rows: readonly SelectValueRow[]): void => {
  for (const row of rows) {
    const task = tasks.get(row.taskId);
    if (task === undefined) {
      continue;
    }
    task.selectValues ??= [];
    task.selectValues.push({
      ...(row.optionId === null ? {} : { optionId: row.optionId }),
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
    });
  }
};

const taskRowsFromValues = ({
  definitions,
  emailValueRows,
  filesMediaRows,
  numberValueRows,
  phoneValueRows,
  selectValueRows,
  textValueRows,
  urlValueRows,
  valueRows,
}: {
  readonly definitions: readonly TaskPropertyDefinition[];
  readonly emailValueRows: readonly EmailValueRow[];
  readonly filesMediaRows: readonly FilesMediaItemRow[];
  readonly numberValueRows: readonly NumberValueRow[];
  readonly phoneValueRows: readonly PhoneValueRow[];
  readonly selectValueRows: readonly SelectValueRow[];
  readonly textValueRows: readonly TextValueRow[];
  readonly urlValueRows: readonly UrlValueRow[];
  readonly valueRows: readonly ValueRow[];
}): TaskRow[] => {
  const tasks = new Map<string, TaskRow>();
  const hasNumberDefinitions = definitions.some(({ datatype }) => datatype === 'number');
  const hasTextDefinitions = definitions.some(({ datatype }) => datatype === 'text');
  const hasUrlDefinitions = definitions.some(({ datatype }) => datatype === 'url');

  for (const row of valueRows) {
    const current = tasks.get(row.taskId) ?? {
      checkboxValues: [],
      emailValues: [],
      filesMediaItems: [],
      phoneValues: [],
      ...(hasNumberDefinitions ? { numberValues: [] } : {}),
      taskId: row.taskId,
      taskRevision: row.taskRevision,
      ...(hasTextDefinitions ? { textValues: [] } : {}),
      title: row.title,
      ...(hasUrlDefinitions ? { urlValues: [] } : {}),
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

  for (const row of emailValueRows) {
    tasks.get(row.taskId)?.emailValues.push({
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
      value: row.value,
    });
  }

  for (const row of textValueRows) {
    tasks.get(row.taskId)?.textValues?.push({
      document: row.document,
      propertyDefinitionId: row.propertyDefinitionId,
      readableText: row.readableText,
      revision: row.revision,
    });
  }

  for (const row of numberValueRows) {
    tasks.get(row.taskId)?.numberValues?.push({
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
      value: row.value === null ? null : (canonicalizeNumberValue(row.value) ?? row.value),
    });
  }

  for (const row of phoneValueRows) {
    tasks.get(row.taskId)?.phoneValues.push({
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
      value: row.value,
    });
  }

  for (const row of filesMediaRows) {
    const task = tasks.get(row.taskId);
    if (task !== undefined) {
      const { taskId: _taskId, ...item } = row;
      task.filesMediaItems.push(item);
    }
  }

  appendSelectValues(tasks, selectValueRows);
  appendUrlValues(tasks, urlValueRows);
  return [...tasks.values()];
};

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
        definition.select_option_order_mode as "optionOrderMode",
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
        and definition.datatype in ('checkbox', 'email', 'files_media', 'number', 'phone', 'select', 'text', 'url')
      order by definition.created_at, definition.property_definition_id
    `);
    const valueResult = await db.execute(sql`
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
    const emailValueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId",
        value.value
      from ticketing.task_email_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'email'
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const phoneValueResult = await db.execute(sql`
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
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const textValueResult = await db.execute(sql`
      select
        value.document,
        value.property_definition_id as "propertyDefinitionId",
        value.readable_text as "readableText",
        value.revision,
        value.task_id as "taskId"
      from ticketing.task_text_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'text'
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
        and definition.datatype = 'number'
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const optionResult = await db.execute(sql`
      select
        option.color,
        option.manual_position as "manualPosition",
        option.name,
        option.option_id as "optionId",
        option.property_definition_id as "propertyDefinitionId",
        option.revision
      from ticketing.select_options as option
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = option.property_definition_id
        and definition.tenant_id = option.tenant_id
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where schema.collection_id = ${input.collectionId}
        and option.tenant_id = ${context.tenantId}
    `);
    const selectValueResult = await db.execute(sql`
      select
        value.option_id as "optionId",
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId"
      from ticketing.task_select_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'select'
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const urlValueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId",
        value.value
      from ticketing.task_url_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'url'
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const filesMediaResult = await db.execute(sql`
      select
        'download' as access,
        asset.byte_size::double precision as "byteSize",
        asset.display_filename as "displayFilename",
        asset.mime_type as "effectiveMimeType",
        item.item_id as "itemId",
        item.media_asset_id as "mediaAssetId",
        item.position,
        item.property_definition_id as "propertyDefinitionId",
        item.task_id as "taskId"
      from ticketing.task_files_media_items as item
      inner join core.media_assets as asset
        on asset.media_asset_id = item.media_asset_id
        and asset.tenant_id = item.tenant_id
      inner join ticketing.tasks as task
        on task.task_id = item.task_id
        and task.tenant_id = item.tenant_id
      where task.collection_id = ${input.collectionId}
        and item.tenant_id = ${context.tenantId}
      order by item.task_id, item.property_definition_id, item.position
    `);
    const optionRows = rowsFromResult<OptionRow>(optionResult);
    const locale = input.locale ?? 'en-GB';
    const definitions: TaskPropertyDefinition[] = rowsFromResult<DefinitionRow>(
      definitionResult,
    ).map((definition) => taskPropertyDefinitionFromRow(definition, optionRows, locale));
    return {
      collectionId: input.collectionId,
      propertyDefinitions: [...definitions],
      tasks: taskRowsFromValues({
        definitions,
        emailValueRows: rowsFromResult<EmailValueRow>(emailValueResult),
        filesMediaRows: rowsFromResult<FilesMediaItemRow>(filesMediaResult),
        numberValueRows: rowsFromResult<NumberValueRow>(numberValueResult),
        phoneValueRows: rowsFromResult<PhoneValueRow>(phoneValueResult),
        selectValueRows: rowsFromResult<SelectValueRow>(selectValueResult),
        textValueRows: rowsFromResult<TextValueRow>(textValueResult),
        urlValueRows: rowsFromResult<UrlValueRow>(urlValueResult),
        valueRows: rowsFromResult<ValueRow>(valueResult),
      }),
    };
  },
};
