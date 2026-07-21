// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CoreReadonlyDbExecutor } from '@app/core-runtime/db/types';
import type {
  StatusGroupKey,
  StatusOption,
  StatusPropertyDefinition,
} from '../shared/task-property-definition.ts';

interface StatusDefinitionRow {
  readonly collectionLocale: string;
  readonly defaultOptionId: string;
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

type StatusOptionRow = StatusOption;

const groupOrder: readonly StatusGroupKey[] = ['todo', 'in_progress', 'complete'];

const englishLabels: Readonly<Record<StatusGroupKey, string>> = {
  complete: 'Complete',
  in_progress: 'In progress',
  todo: 'To-do',
};

const czechLabels: Readonly<Record<StatusGroupKey, string>> = {
  complete: 'Dokončeno',
  in_progress: 'Probíhá',
  todo: 'K vyřízení',
};

export const statusGroupLabel = (group: StatusGroupKey, locale: string): string =>
  (locale.toLowerCase().startsWith('cs') ? czechLabels : englishLabels)[group];

export const statusDefinitionFromParts = ({
  defaultOptionId,
  groupLabel,
  options,
  hidden,
  mandatory,
  name,
  propertyDefinitionId,
  revision,
}: {
  readonly defaultOptionId: string;
  readonly groupLabel: (group: StatusGroupKey) => string;
  readonly options: readonly StatusOption[];
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}): StatusPropertyDefinition => ({
  datatype: 'status',
  defaultOptionId,
  groups: groupOrder.map((group) => ({
    group,
    label: groupLabel(group),
    options: options
      .filter((option) => option.group === group)
      .toSorted(
        (left, right) =>
          left.position - right.position || left.optionId.localeCompare(right.optionId),
      ),
  })),
  hidden,
  mandatory,
  name,
  propertyDefinitionId,
  revision,
});

export const getStatusDefinition = async ({
  collectionId,
  db,
  locale,
  propertyDefinitionId,
  tenantId,
}: {
  readonly collectionId: string;
  readonly db: CoreReadonlyDbExecutor;
  readonly locale?: string;
  readonly propertyDefinitionId: string;
  readonly tenantId: string;
}): Promise<StatusPropertyDefinition | undefined> => {
  const definitionResult = await db.execute(sql`
    select
      collection.locale as "collectionLocale",
      configuration.default_option_id as "defaultOptionId",
      definition.hidden,
      definition.mandatory,
      definition.name,
      definition.property_definition_id as "propertyDefinitionId",
      definition.revision
    from ticketing.task_property_definitions as definition
    inner join ticketing.task_schemas as schema
      on schema.schema_id = definition.schema_id
      and schema.tenant_id = definition.tenant_id
    inner join ticketing.task_collections as collection
      on collection.collection_id = schema.collection_id
      and collection.tenant_id = schema.tenant_id
    inner join ticketing.status_property_configurations as configuration
      on configuration.property_definition_id = definition.property_definition_id
      and configuration.tenant_id = definition.tenant_id
    where definition.property_definition_id = ${propertyDefinitionId}
      and definition.datatype = 'status'
      and definition.tenant_id = ${tenantId}
      and schema.collection_id = ${collectionId}
  `);
  const definition = rowsFromResult<StatusDefinitionRow>(definitionResult).at(0);
  if (definition === undefined) {
    return undefined;
  }
  const optionResult = await db.execute(sql`
    select
      color,
      group_key as "group",
      name,
      option_id as "optionId",
      position,
      revision
    from ticketing.status_options
    where property_definition_id = ${propertyDefinitionId}
      and tenant_id = ${tenantId}
    order by group_key, position, option_id
  `);
  const effectiveLocale = locale ?? definition.collectionLocale;
  return statusDefinitionFromParts({
    ...definition,
    groupLabel: (group) => statusGroupLabel(group, effectiveLocale),
    options: rowsFromResult<StatusOptionRow>(optionResult),
  });
};
