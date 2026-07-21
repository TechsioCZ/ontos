// @effect-diagnostics asyncFunction:off
import { createPersonDirectory, getMediaAssetProjections, rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration, ResolvedPersonDirectoryEntry } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import { resolveEffectiveTimeZone } from '@app/core-runtime/principal-time-zone-preferences';
import {
  getTaskPropertyWorkspacePayloadSchema,
  taskPropertyWorkspaceSchema,
} from '../../shared/task-property-workspace.ts';
import type {
  GetTaskPropertyWorkspacePayload,
  IdAssignment,
  TaskPropertyWorkspace,
} from '../../shared/task-property-workspace.ts';
import type { TextDocument } from '../../shared/text-property.ts';
import { canonicalizeNumberValue } from '../../shared/number-value.ts';
import type {
  MultiSelectOption,
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
  | (DefinitionFields & { readonly datatype: 'date' })
  | (DefinitionFields & { readonly datatype: 'created_by' | 'created_time' })
  | (DefinitionFields & { readonly datatype: 'email' })
  | (DefinitionFields & { readonly datatype: 'files_media' })
  | (DefinitionFields & { readonly datatype: 'id'; readonly prefix: string })
  | (DefinitionFields & {
      readonly datatype: 'number';
      readonly format: 'number' | 'number_with_separators' | 'percent';
    })
  | (DefinitionFields & {
      readonly cardinality: 'one' | 'unlimited';
      readonly datatype: 'person';
    })
  | (DefinitionFields & {
      readonly datatype: 'multi_select';
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

interface MultiSelectOptionRow extends MultiSelectOption {
  readonly propertyDefinitionId: string;
}

const taskPropertyDefinitionFromRow = (
  definition: DefinitionRow,
  multiSelectOptionRows: readonly MultiSelectOptionRow[],
  optionRows: readonly OptionRow[],
  locale: string,
): TaskPropertyDefinition => {
  if (definition.datatype === 'id' || definition.datatype === 'number') {
    return definition;
  }
  if (definition.datatype === 'multi_select') {
    return {
      datatype: 'multi_select',
      hidden: definition.hidden,
      mandatory: definition.mandatory,
      name: definition.name,
      options: multiSelectOptionRows
        .filter((option) => option.propertyDefinitionId === definition.propertyDefinitionId)
        .map(({ propertyDefinitionId: _propertyDefinitionId, ...option }) => option),
      propertyDefinitionId: definition.propertyDefinitionId,
      revision: definition.revision,
    };
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
  if (definition.datatype === 'person') {
    return {
      cardinality: definition.cardinality,
      datatype: 'person',
      hidden: definition.hidden,
      mandatory: definition.mandatory,
      name: definition.name,
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

interface DateValueRow {
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

interface PersonValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
}

interface PersonAssignmentRow {
  readonly principalId: string;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
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

interface MultiSelectValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
}

interface MultiSelectSelectionRow {
  readonly optionId: string;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
}

interface UrlValueRow {
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

interface ValueRow {
  readonly createdAt: string;
  readonly createdByDisplayName: string;
  readonly createdByPrincipalId: string;
  readonly createdByStatus: 'active' | 'archived' | 'disabled';
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

interface StoredFilesMediaItemRow {
  readonly itemId: string;
  readonly mediaAssetId: string;
  readonly position: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
}

interface FilesMediaItemRow extends StoredFilesMediaItemRow {
  readonly access: 'download';
  readonly byteSize: number;
  readonly displayFilename: string;
  readonly effectiveMimeType: string;
}

interface TaskRow {
  readonly checkboxValues: {
    propertyDefinitionId: string;
    revision: number;
    value: boolean;
  }[];
  readonly dateValues: {
    propertyDefinitionId: string;
    revision: number;
    value: string | null;
  }[];
  readonly emailValues: {
    propertyDefinitionId: string;
    revision: number;
    value: string | null;
  }[];
  readonly filesMediaItems: Omit<FilesMediaItemRow, 'taskId'>[];
  idAssignment?: IdAssignment;
  readonly createdAt?: string;
  readonly createdBy?: {
    displayName: string;
    inactive: boolean;
    principalId: string;
  };
  numberValues?: {
    propertyDefinitionId: string;
    revision: number;
    value: string | null;
  }[];
  multiSelectValues?: {
    optionIds: string[];
    propertyDefinitionId: string;
    revision: number;
  }[];
  readonly phoneValues: {
    propertyDefinitionId: string;
    revision: number;
    value: string;
  }[];
  personValues?: {
    people: ResolvedPersonDirectoryEntry[];
    principalIds: string[];
    propertyDefinitionId: string;
    revision: number;
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

const optionalTaskValueArraysFactory = (
  definitions: readonly TaskPropertyDefinition[],
): (() => Partial<Pick<TaskRow, 'numberValues' | 'personValues' | 'textValues' | 'urlValues'>>) => {
  const hasNumberDefinitions = definitions.some(({ datatype }) => datatype === 'number');
  const hasPersonDefinitions = definitions.some(({ datatype }) => datatype === 'person');
  const hasTextDefinitions = definitions.some(({ datatype }) => datatype === 'text');
  const hasUrlDefinitions = definitions.some(({ datatype }) => datatype === 'url');
  return () => ({
    ...(hasNumberDefinitions ? { numberValues: [] } : {}),
    ...(hasPersonDefinitions ? { personValues: [] } : {}),
    ...(hasTextDefinitions ? { textValues: [] } : {}),
    ...(hasUrlDefinitions ? { urlValues: [] } : {}),
  });
};

const appendMultiSelectValues = (
  tasks: Map<string, TaskRow>,
  rows: readonly MultiSelectValueRow[],
  selections: readonly MultiSelectSelectionRow[],
): void => {
  for (const row of rows) {
    const task = tasks.get(row.taskId);
    if (task === undefined) {
      continue;
    }
    task.multiSelectValues ??= [];
    task.multiSelectValues.push({
      optionIds: selections
        .filter(
          (selection) =>
            selection.taskId === row.taskId &&
            selection.propertyDefinitionId === row.propertyDefinitionId,
        )
        .map(({ optionId }) => optionId),
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
    });
  }
};

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

const appendDateValues = (tasks: Map<string, TaskRow>, rows: readonly DateValueRow[]): void => {
  for (const row of rows) {
    tasks.get(row.taskId)?.dateValues.push({
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
      value: row.value,
    });
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

const appendFilesMediaItems = (
  tasks: Map<string, TaskRow>,
  rows: readonly FilesMediaItemRow[],
): void => {
  for (const row of rows) {
    const task = tasks.get(row.taskId);
    if (task !== undefined) {
      const { taskId: _taskId, ...item } = row;
      task.filesMediaItems.push(item);
    }
  }
};

const intrinsicTaskFacts = (
  row: ValueRow,
  exposesCreatedBy: boolean,
  exposesCreatedTime: boolean,
): Pick<TaskRow, 'createdAt' | 'createdBy'> => ({
  ...(exposesCreatedTime ? { createdAt: row.createdAt } : {}),
  ...(exposesCreatedBy
    ? {
        createdBy: {
          displayName: row.createdByDisplayName,
          inactive: row.createdByStatus !== 'active',
          principalId: row.createdByPrincipalId,
        },
      }
    : {}),
});

const idAssignmentFromValueRow = (row: ValueRow): IdAssignment | undefined => {
  if (row.idNumber === null || row.idPrefix === null || row.idPropertyDefinitionId === null) {
    return undefined;
  }
  return {
    displayValue: row.idPrefix.length === 0 ? row.idNumber : `${row.idPrefix}-${row.idNumber}`,
    number: row.idNumber,
    propertyDefinitionId: row.idPropertyDefinitionId,
  };
};

const taskRowsFromValues = ({
  dateValueRows,
  definitions,
  emailValueRows,
  filesMediaRows,
  numberValueRows,
  multiSelectSelectionRows,
  multiSelectValueRows,
  personAssignmentRows,
  personValueRows,
  phoneValueRows,
  resolvedPeople,
  selectValueRows,
  textValueRows,
  urlValueRows,
  valueRows,
}: {
  readonly dateValueRows: readonly DateValueRow[];
  readonly definitions: readonly TaskPropertyDefinition[];
  readonly emailValueRows: readonly EmailValueRow[];
  readonly filesMediaRows: readonly FilesMediaItemRow[];
  readonly numberValueRows: readonly NumberValueRow[];
  readonly multiSelectSelectionRows: readonly MultiSelectSelectionRow[];
  readonly multiSelectValueRows: readonly MultiSelectValueRow[];
  readonly personAssignmentRows: readonly PersonAssignmentRow[];
  readonly personValueRows: readonly PersonValueRow[];
  readonly phoneValueRows: readonly PhoneValueRow[];
  readonly resolvedPeople: readonly ResolvedPersonDirectoryEntry[];
  readonly selectValueRows: readonly SelectValueRow[];
  readonly textValueRows: readonly TextValueRow[];
  readonly urlValueRows: readonly UrlValueRow[];
  readonly valueRows: readonly ValueRow[];
}): TaskRow[] => {
  const tasks = new Map<string, TaskRow>();
  const optionalTaskValueArrays = optionalTaskValueArraysFactory(definitions);
  const exposesCreatedTime = definitions.some(
    (definition) => definition.datatype === 'created_time' && !definition.hidden,
  );
  const exposesCreatedBy = definitions.some(
    (definition) => definition.datatype === 'created_by' && !definition.hidden,
  );

  for (const row of valueRows) {
    const current = tasks.get(row.taskId) ?? {
      checkboxValues: [],
      dateValues: [],
      ...intrinsicTaskFacts(row, exposesCreatedBy, exposesCreatedTime),
      emailValues: [],
      filesMediaItems: [],
      phoneValues: [],
      ...optionalTaskValueArrays(),
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
    const idAssignment = idAssignmentFromValueRow(row);
    if (idAssignment !== undefined) {
      current.idAssignment = idAssignment;
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

  const resolvedById = new Map(resolvedPeople.map((person) => [person.principalId, person]));
  for (const row of personValueRows) {
    const principalIds = personAssignmentRows
      .filter(
        (assignment) =>
          assignment.taskId === row.taskId &&
          assignment.propertyDefinitionId === row.propertyDefinitionId,
      )
      .map(({ principalId }) => principalId);
    tasks.get(row.taskId)?.personValues?.push({
      people: principalIds
        .map((principalId) => resolvedById.get(principalId))
        .filter((person) => person !== undefined),
      principalIds,
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
    });
  }

  appendSelectValues(tasks, selectValueRows);
  appendMultiSelectValues(tasks, multiSelectValueRows, multiSelectSelectionRows);
  appendDateValues(tasks, dateValueRows);
  appendFilesMediaItems(tasks, filesMediaRows);
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
        configuration.cardinality,
        definition.datatype,
        definition.number_format as format,
        definition.select_option_order_mode as "optionOrderMode",
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
      left join ticketing.task_person_property_configurations as configuration
        on configuration.property_definition_id = definition.property_definition_id
        and configuration.tenant_id = definition.tenant_id
      where schema.collection_id = ${input.collectionId}
        and definition.tenant_id = ${context.tenantId}
        and definition.datatype in ('checkbox', 'created_time', 'created_by', 'date', 'email', 'files_media', 'id', 'multi_select', 'number', 'person', 'phone', 'select', 'text', 'url')
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
        id_assignment.number::text as "idNumber",
        id_definition.prefix as "idPrefix",
        id_assignment.property_definition_id as "idPropertyDefinitionId",
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
    const dateValueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId",
        value.value::text as value
      from ticketing.task_date_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'date'
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
    const personValueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId"
      from ticketing.task_person_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'person'
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const personAssignmentResult = await db.execute(sql`
      select
        assignment.principal_id as "principalId",
        assignment.property_definition_id as "propertyDefinitionId",
        assignment.task_id as "taskId"
      from ticketing.task_person_assignments as assignment
      inner join ticketing.tasks as task
        on task.task_id = assignment.task_id
        and task.tenant_id = assignment.tenant_id
      where task.collection_id = ${input.collectionId}
        and assignment.tenant_id = ${context.tenantId}
      order by assignment.task_id, assignment.property_definition_id, assignment.principal_id
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
    const multiSelectOptionResult = await db.execute(sql`
      select
        option.catalog_position as "catalogPosition",
        option.color,
        option.name,
        option.option_id as "optionId",
        option.property_definition_id as "propertyDefinitionId",
        option.revision
      from ticketing.multi_select_options as option
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = option.property_definition_id
        and definition.tenant_id = option.tenant_id
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where schema.collection_id = ${input.collectionId}
        and option.tenant_id = ${context.tenantId}
      order by option.catalog_position, option.option_id
    `);
    const multiSelectValueResult = await db.execute(sql`
      select
        value.property_definition_id as "propertyDefinitionId",
        value.revision,
        value.task_id as "taskId"
      from ticketing.task_multi_select_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = value.property_definition_id
        and definition.tenant_id = value.tenant_id
        and definition.datatype = 'multi_select'
      where task.collection_id = ${input.collectionId}
        and value.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id, definition.created_at, value.property_definition_id
    `);
    const multiSelectSelectionResult = await db.execute(sql`
      select
        selection.option_id as "optionId",
        selection.property_definition_id as "propertyDefinitionId",
        selection.task_id as "taskId"
      from ticketing.task_multi_select_selections as selection
      inner join ticketing.tasks as task
        on task.task_id = selection.task_id
        and task.tenant_id = selection.tenant_id
      inner join ticketing.multi_select_options as option
        on option.option_id = selection.option_id
        and option.property_definition_id = selection.property_definition_id
        and option.tenant_id = selection.tenant_id
      where task.collection_id = ${input.collectionId}
        and selection.tenant_id = ${context.tenantId}
      order by selection.task_id, selection.property_definition_id, option.catalog_position, option.option_id
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
        item.item_id as "itemId",
        item.media_asset_id as "mediaAssetId",
        item.position,
        item.property_definition_id as "propertyDefinitionId",
        item.task_id as "taskId"
      from ticketing.task_files_media_items as item
      inner join ticketing.tasks as task
        on task.task_id = item.task_id
        and task.tenant_id = item.tenant_id
      where task.collection_id = ${input.collectionId}
        and item.tenant_id = ${context.tenantId}
      order by item.task_id, item.property_definition_id, item.position
    `);
    const optionRows = rowsFromResult<OptionRow>(optionResult);
    const multiSelectOptionRows = rowsFromResult<MultiSelectOptionRow>(multiSelectOptionResult);
    const locale = input.locale ?? 'en-GB';
    const definitions: TaskPropertyDefinition[] = rowsFromResult<DefinitionRow>(
      definitionResult,
    ).map((definition) =>
      taskPropertyDefinitionFromRow(definition, multiSelectOptionRows, optionRows, locale),
    );
    const personAssignmentRows = rowsFromResult<PersonAssignmentRow>(personAssignmentResult);
    const resolvedPeople = await createPersonDirectory({
      db,
      tenantId: context.tenantId,
    }).resolveStoredPrincipalIds([
      ...new Set(personAssignmentRows.map(({ principalId }) => principalId)),
    ]);
    const storedFilesMediaRows = rowsFromResult<StoredFilesMediaItemRow>(filesMediaResult);
    const assetProjections = await getMediaAssetProjections(
      {
        mediaAssetIds: storedFilesMediaRows.map(({ mediaAssetId }) => mediaAssetId),
        tenantId: context.tenantId,
      },
      { db },
    );
    const assetsById = new Map(assetProjections.map((asset) => [asset.mediaAssetId, asset]));
    const filesMediaRows: FilesMediaItemRow[] = [];
    for (const item of storedFilesMediaRows) {
      const asset = assetsById.get(item.mediaAssetId);
      if (asset !== undefined) {
        filesMediaRows.push({ ...asset, ...item });
      }
    }
    const exposesCreatedTime = definitions.some(
      (definition) => definition.datatype === 'created_time' && !definition.hidden,
    );
    const effectiveTimeZone = exposesCreatedTime
      ? await resolveEffectiveTimeZone({
          browserTimeZone: input.browserTimeZone,
          context,
          db,
        })
      : undefined;
    const tasks = taskRowsFromValues({
      dateValueRows: rowsFromResult<DateValueRow>(dateValueResult),
      definitions,
      emailValueRows: rowsFromResult<EmailValueRow>(emailValueResult),
      filesMediaRows,
      multiSelectSelectionRows: rowsFromResult<MultiSelectSelectionRow>(multiSelectSelectionResult),
      multiSelectValueRows: rowsFromResult<MultiSelectValueRow>(multiSelectValueResult),
      numberValueRows: rowsFromResult<NumberValueRow>(numberValueResult),
      personAssignmentRows,
      personValueRows: rowsFromResult<PersonValueRow>(personValueResult),
      phoneValueRows: rowsFromResult<PhoneValueRow>(phoneValueResult),
      resolvedPeople,
      selectValueRows: rowsFromResult<SelectValueRow>(selectValueResult),
      textValueRows: rowsFromResult<TextValueRow>(textValueResult),
      urlValueRows: rowsFromResult<UrlValueRow>(urlValueResult),
      valueRows: rowsFromResult<ValueRow>(valueResult),
    });
    const idGroups = tasks
      .filter(
        (task): task is TaskRow & { readonly idAssignment: IdAssignment } =>
          task.idAssignment !== undefined,
      )
      .map(({ idAssignment, taskId }) => ({
        number: idAssignment.number,
        taskIds: [taskId],
      }));
    return {
      collectionId: input.collectionId,
      ...(effectiveTimeZone === undefined ? {} : { effectiveTimeZone }),
      idGroups,
      propertyDefinitions: [...definitions],
      tasks,
    };
  },
};
