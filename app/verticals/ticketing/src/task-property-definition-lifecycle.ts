// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CoreReadonlyDbExecutor, CoreTransaction } from '@app/core-runtime/db/types';
import type {
  SelectOption,
  SelectOptionOrderMode,
  SelectPropertyDefinition,
  StatusOption,
  StatusPropertyDefinition,
  TaskPropertyDefinition,
} from '../shared/task-property-definition.ts';
import type { TaskPropertyDeletionImpact } from '../shared/task-property-deletion-impact.ts';
import { statusDefinitionFromParts, statusGroupLabel } from './status-property.ts';

interface TaskPropertyDefinitionLifecycleTarget {
  readonly cardinality: 'one' | 'unlimited' | null;
  readonly datatype: TaskPropertyDefinition['datatype'];
  readonly dateRangeTimeEnabled: boolean | null;
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly numberFormat: string | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly schemaId: string;
  readonly selectOptionOrderMode: SelectOptionOrderMode | null;
  readonly tenantId: string;
}

interface TaskPropertyLifecycleAdapter {
  readonly copyValues: (input: {
    readonly copyValues: boolean;
    readonly source: TaskPropertyDefinitionLifecycleTarget;
    readonly target: TaskPropertyDefinition;
    readonly tx: CoreTransaction;
  }) => Promise<void>;
  readonly deleteValues: (input: {
    readonly target: TaskPropertyDefinitionLifecycleTarget;
    readonly tx: CoreTransaction;
  }) => Promise<void>;
  readonly getDeletionImpactCount: (input: {
    readonly db: CoreReadonlyDbExecutor;
    readonly target: TaskPropertyDefinitionLifecycleTarget;
  }) => Promise<number>;
  readonly getDeletionImpact?: (input: {
    readonly db: CoreReadonlyDbExecutor;
    readonly target: TaskPropertyDefinitionLifecycleTarget;
  }) => Promise<Pick<TaskPropertyDeletionImpact, 'impactCount' | 'impactRevision'>>;
}

const intrinsicPropertyDatatypeValues = [
  'created_by',
  'created_time',
  'last_edited_by',
  'last_edited_time',
] as const satisfies readonly TaskPropertyDefinition['datatype'][];

type IntrinsicPropertyDatatype = (typeof intrinsicPropertyDatatypeValues)[number];

const intrinsicPropertyDatatypes: ReadonlySet<string> = new Set(intrinsicPropertyDatatypeValues);

const isIntrinsicPropertyDatatype = (datatype: string): datatype is IntrinsicPropertyDatatype =>
  intrinsicPropertyDatatypes.has(datatype);

export const shouldCopyTaskPropertyDefinitionValues = ({
  datatype,
  requestedCopyValues,
}: {
  readonly datatype: string;
  readonly requestedCopyValues: boolean;
}): boolean => {
  if (datatype === 'date_range') {
    return true;
  }
  if (isIntrinsicPropertyDatatype(datatype) || datatype === 'text') {
    return false;
  }
  return requestedCopyValues;
};

interface ImpactCountRow {
  readonly impactCount: number;
}

interface ImpactRevisionRow extends ImpactCountRow {
  readonly impactRevision: string;
}

const checkboxLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    await tx.execute(sql`
      insert into ticketing.task_checkbox_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id,
        case when ${copyValues} then source_value.value else false end
      from ticketing.task_checkbox_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_checkbox_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_checkbox_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const idLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: () => Promise.reject(new Error('ID Task Property Definitions cannot be duplicated.')),
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_id_assignments
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
    await tx.execute(sql`
      delete from ticketing.task_id_sequences
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_id_assignments as assignment
      inner join ticketing.tasks as task
        on task.task_id = assignment.task_id
        and task.tenant_id = assignment.tenant_id
      where assignment.property_definition_id = ${target.propertyDefinitionId}
        and assignment.tenant_id = ${target.tenantId}
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const personLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    if (source.cardinality === null) {
      throw new Error('Person Task Property cardinality is missing.');
    }
    await tx.execute(sql`
      insert into ticketing.task_person_property_configurations (
        cardinality,
        property_definition_id,
        tenant_id
      )
      values (
        ${source.cardinality},
        ${target.propertyDefinitionId},
        ${source.tenantId}
      )
    `);
    await tx.execute(sql`
      insert into ticketing.task_person_values (
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id
      from ticketing.task_person_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
    if (copyValues) {
      await tx.execute(sql`
        insert into ticketing.task_person_assignments (
          principal_id,
          property_definition_id,
          task_id,
          tenant_id
        )
        select
          source_assignment.principal_id,
          ${target.propertyDefinitionId},
          source_assignment.task_id,
          source_assignment.tenant_id
        from ticketing.task_person_assignments as source_assignment
        where source_assignment.property_definition_id = ${source.propertyDefinitionId}
          and source_assignment.tenant_id = ${source.tenantId}
      `);
    }
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_person_assignments
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
    await tx.execute(sql`
      delete from ticketing.task_person_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
    await tx.execute(sql`
      delete from ticketing.task_person_property_configurations
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(distinct assignment.task_id)::integer as "impactCount"
      from ticketing.task_person_assignments as assignment
      inner join ticketing.tasks as task
        on task.task_id = assignment.task_id
        and task.tenant_id = assignment.tenant_id
      where assignment.property_definition_id = ${target.propertyDefinitionId}
        and assignment.tenant_id = ${target.tenantId}
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const dateLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    if (!copyValues) {
      return;
    }
    await tx.execute(sql`
      insert into ticketing.task_date_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id,
        source_value.value
      from ticketing.task_date_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
        and source_value.value is not null
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_date_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_date_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.value is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const dateRangeLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ source, target, tx }) => {
    await tx.execute(sql`
      insert into ticketing.task_date_range_values (
        end_date, end_time, property_definition_id, task_id, tenant_id, start_date, start_time
      )
      select source_value.end_date, source_value.end_time, ${target.propertyDefinitionId},
        source_value.task_id, source_value.tenant_id, source_value.start_date, source_value.start_time
      from ticketing.task_date_range_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_date_range_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_date_range_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.start_date is not null and value.end_date is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const emailLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    if (!copyValues) {
      return;
    }
    await tx.execute(sql`
      insert into ticketing.task_email_values (
        normalized_value,
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        source_value.normalized_value,
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id,
        source_value.value
      from ticketing.task_email_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
        and source_value.value is not null
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_email_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_email_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.value is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const getFilesMediaDeletionImpact = async ({
  db,
  target,
}: {
  readonly db: CoreReadonlyDbExecutor;
  readonly target: TaskPropertyDefinitionLifecycleTarget;
}): Promise<ImpactRevisionRow> => {
  const result = await db.execute(sql`
    select
      count(affected.task_id)::integer as "impactCount",
      md5(coalesce(
        string_agg(affected.task_id::text, ',' order by affected.task_id),
        ''
      )) as "impactRevision"
    from (
      select distinct item.task_id
      from ticketing.task_files_media_items as item
      inner join ticketing.tasks as task
        on task.task_id = item.task_id
        and task.tenant_id = item.tenant_id
      where item.property_definition_id = ${target.propertyDefinitionId}
        and item.tenant_id = ${target.tenantId}
    ) as affected
  `);
  const impact = rowsFromResult<ImpactRevisionRow>(result).at(0);
  if (impact === undefined) {
    throw new Error('Files & media deletion impact could not be read.');
  }
  return impact;
};

const filesMediaLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    if (!copyValues) {
      return;
    }
    await tx.execute(sql`
      insert into ticketing.task_files_media_items (
        external_url,
        media_asset_id,
        position,
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        source_item.external_url,
        source_item.media_asset_id,
        source_item.position,
        ${target.propertyDefinitionId},
        source_item.task_id,
        source_item.tenant_id
      from ticketing.task_files_media_items as source_item
      where source_item.property_definition_id = ${source.propertyDefinitionId}
        and source_item.tenant_id = ${source.tenantId}
      order by source_item.task_id, source_item.position
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_files_media_items
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpact: getFilesMediaDeletionImpact,
  getDeletionImpactCount: async (input) => {
    const impact = await getFilesMediaDeletionImpact(input);
    return impact.impactCount;
  },
};

const phoneLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    if (!copyValues) {
      return;
    }
    await tx.execute(sql`
      insert into ticketing.task_phone_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id,
        source_value.value
      from ticketing.task_phone_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_phone_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_phone_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const textLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ source, target, tx }) => {
    await tx.execute(sql`
      insert into ticketing.task_text_values (
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id
      from ticketing.task_text_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_text_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_text_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.readable_text is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const numberLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    if (!copyValues) {
      return;
    }
    await tx.execute(sql`
      insert into ticketing.task_number_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id,
        source_value.value
      from ticketing.task_number_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
        and source_value.value is not null
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_number_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_number_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.value is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const selectLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    await tx.execute(sql`
      with option_mapping as materialized (
        select
          gen_random_uuid() as target_option_id,
          source_option.color,
          source_option.manual_position,
          source_option.name,
          source_option.normalized_name,
          source_option.option_id as source_option_id
        from ticketing.select_options as source_option
        where source_option.property_definition_id = ${source.propertyDefinitionId}
          and source_option.tenant_id = ${source.tenantId}
      ), copied_options as (
        insert into ticketing.select_options (
          color,
          manual_position,
          name,
          normalized_name,
          option_id,
          property_definition_id,
          tenant_id
        )
        select
          option_mapping.color,
          option_mapping.manual_position,
          option_mapping.name,
          option_mapping.normalized_name,
          option_mapping.target_option_id,
          ${target.propertyDefinitionId},
          ${source.tenantId}
        from option_mapping
        returning option_id
      )
      insert into ticketing.task_select_values (
        option_id,
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        option_mapping.target_option_id,
        ${target.propertyDefinitionId},
        source_value.task_id,
        source_value.tenant_id
      from ticketing.task_select_values as source_value
      inner join option_mapping
        on option_mapping.source_option_id = source_value.option_id
      where ${copyValues}
        and source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_select_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
    await tx.execute(sql`
      delete from ticketing.select_options
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_select_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.option_id is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const statusLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    await tx.execute(sql`
      with option_mapping as materialized (
        select
          gen_random_uuid() as target_option_id,
          source_configuration.default_option_id = source_option.option_id as is_default,
          source_option.color,
          source_option.group_key,
          source_option.name,
          source_option.normalized_name,
          source_option.option_id as source_option_id,
          source_option.position
        from ticketing.status_options as source_option
        inner join ticketing.status_property_configurations as source_configuration
          on source_configuration.property_definition_id = source_option.property_definition_id
          and source_configuration.tenant_id = source_option.tenant_id
        where source_option.property_definition_id = ${source.propertyDefinitionId}
          and source_option.tenant_id = ${source.tenantId}
      ), copied_options as (
        insert into ticketing.status_options (
          color,
          group_key,
          name,
          normalized_name,
          option_id,
          position,
          property_definition_id,
          tenant_id
        )
        select
          option_mapping.color,
          option_mapping.group_key,
          option_mapping.name,
          option_mapping.normalized_name,
          option_mapping.target_option_id,
          option_mapping.position,
          ${target.propertyDefinitionId},
          ${source.tenantId}
        from option_mapping
        returning option_id
      ), copied_configuration as (
        insert into ticketing.status_property_configurations (
          default_option_id,
          property_definition_id,
          tenant_id
        )
        select
          option_mapping.target_option_id,
          ${target.propertyDefinitionId},
          ${source.tenantId}
        from option_mapping
        inner join copied_options
          on copied_options.option_id = option_mapping.target_option_id
        where option_mapping.is_default
        returning property_definition_id
      )
      insert into ticketing.task_status_values (
        collection_id,
        option_id,
        property_definition_id,
        schema_id,
        task_id,
        tenant_id
      )
      select
        source_value.collection_id,
        option_mapping.target_option_id,
        ${target.propertyDefinitionId},
        source_value.schema_id,
        source_value.task_id,
        source_value.tenant_id
      from ticketing.task_status_values as source_value
      inner join option_mapping
        on option_mapping.source_option_id = source_value.option_id
      inner join copied_configuration on true
      where ${copyValues}
        and source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_status_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
    await tx.execute(sql`
      delete from ticketing.status_property_configurations
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
    await tx.execute(sql`
      delete from ticketing.status_options
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_status_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.option_id is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const urlLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: async ({ copyValues, source, target, tx }) => {
    await tx.execute(sql`
      insert into ticketing.task_url_values (
        property_definition_id,
        revision,
        task_id,
        tenant_id,
        value
      )
      select
        ${target.propertyDefinitionId},
        case when ${copyValues} and source_value.value is not null then 1 else 0 end,
        source_value.task_id,
        source_value.tenant_id,
        case when ${copyValues} then source_value.value else null end
      from ticketing.task_url_values as source_value
      where source_value.property_definition_id = ${source.propertyDefinitionId}
        and source_value.tenant_id = ${source.tenantId}
    `);
  },
  deleteValues: async ({ target, tx }) => {
    await tx.execute(sql`
      delete from ticketing.task_url_values
      where property_definition_id = ${target.propertyDefinitionId}
        and tenant_id = ${target.tenantId}
    `);
  },
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.task_url_values as value
      inner join ticketing.tasks as task
        on task.task_id = value.task_id
        and task.tenant_id = value.tenant_id
      where value.property_definition_id = ${target.propertyDefinitionId}
        and value.tenant_id = ${target.tenantId}
        and value.value is not null
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const intrinsicLifecycleAdapter: TaskPropertyLifecycleAdapter = {
  copyValues: () => Promise.resolve(),
  deleteValues: () => Promise.resolve(),
  getDeletionImpactCount: async ({ db, target }) => {
    const result = await db.execute(sql`
      select count(task.task_id)::integer as "impactCount"
      from ticketing.tasks as task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = task.collection_id
        and schema.tenant_id = task.tenant_id
      where schema.schema_id = ${target.schemaId}
        and task.tenant_id = ${target.tenantId}
    `);
    return rowsFromResult<ImpactCountRow>(result).at(0)?.impactCount ?? 0;
  },
};

const lifecycleAdapters = {
  checkbox: checkboxLifecycleAdapter,
  created_by: intrinsicLifecycleAdapter,
  created_time: intrinsicLifecycleAdapter,
  date: dateLifecycleAdapter,
  date_range: dateRangeLifecycleAdapter,
  email: emailLifecycleAdapter,
  files_media: filesMediaLifecycleAdapter,
  id: idLifecycleAdapter,
  last_edited_by: intrinsicLifecycleAdapter,
  last_edited_time: intrinsicLifecycleAdapter,
  number: numberLifecycleAdapter,
  person: personLifecycleAdapter,
  phone: phoneLifecycleAdapter,
  select: selectLifecycleAdapter,
  status: statusLifecycleAdapter,
  text: textLifecycleAdapter,
  url: urlLifecycleAdapter,
} satisfies Readonly<Record<string, TaskPropertyLifecycleAdapter>>;

type SupportedTaskPropertyDatatype = keyof typeof lifecycleAdapters;

const lifecycleAdapterFor = (datatype: string): TaskPropertyLifecycleAdapter | undefined =>
  Object.hasOwn(lifecycleAdapters, datatype)
    ? lifecycleAdapters[datatype as SupportedTaskPropertyDatatype]
    : undefined;

const supportedTargetFromResult = (
  result: Awaited<ReturnType<CoreReadonlyDbExecutor['execute']>>,
): TaskPropertyDefinitionLifecycleTarget | undefined => {
  const target = rowsFromResult<TaskPropertyDefinitionLifecycleTarget>(result).at(0);
  return target !== undefined && lifecycleAdapterFor(target.datatype) !== undefined
    ? target
    : undefined;
};

export const findTaskPropertyDefinitionLifecycleTarget = async ({
  collectionId,
  db,
  propertyDefinitionId,
  tenantId,
}: {
  readonly collectionId: string;
  readonly db: CoreReadonlyDbExecutor;
  readonly propertyDefinitionId: string;
  readonly tenantId: string;
}): Promise<TaskPropertyDefinitionLifecycleTarget | undefined> =>
  supportedTargetFromResult(
    await db.execute(sql`
      select
        configuration.cardinality,
        definition.datatype,
        definition.date_range_time_enabled as "dateRangeTimeEnabled",
        definition.hidden,
        definition.mandatory,
        definition.name,
        definition.number_format as "numberFormat",
        definition.property_definition_id as "propertyDefinitionId",
        definition.revision,
        definition.schema_id as "schemaId",
        definition.select_option_order_mode as "selectOptionOrderMode",
        definition.tenant_id as "tenantId"
      from ticketing.task_property_definitions as definition
      left join ticketing.task_person_property_configurations as configuration
        on configuration.property_definition_id = definition.property_definition_id
        and configuration.tenant_id = definition.tenant_id
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where definition.property_definition_id = ${propertyDefinitionId}
        and definition.tenant_id = ${tenantId}
        and schema.collection_id = ${collectionId}
    `),
  );

export const lockTaskPropertyDefinitionLifecycleTarget = async ({
  collectionId,
  propertyDefinitionId,
  tenantId,
  tx,
}: {
  readonly collectionId: string;
  readonly propertyDefinitionId: string;
  readonly tenantId: string;
  readonly tx: CoreTransaction;
}): Promise<TaskPropertyDefinitionLifecycleTarget | undefined> =>
  supportedTargetFromResult(
    await tx.execute(sql`
      select
        configuration.cardinality,
        definition.datatype,
        definition.date_range_time_enabled as "dateRangeTimeEnabled",
        definition.hidden,
        definition.mandatory,
        definition.name,
        definition.number_format as "numberFormat",
        definition.property_definition_id as "propertyDefinitionId",
        definition.revision,
        definition.schema_id as "schemaId",
        definition.select_option_order_mode as "selectOptionOrderMode",
        definition.tenant_id as "tenantId"
      from ticketing.task_property_definitions as definition
      left join ticketing.task_person_property_configurations as configuration
        on configuration.property_definition_id = definition.property_definition_id
        and configuration.tenant_id = definition.tenant_id
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where definition.property_definition_id = ${propertyDefinitionId}
        and definition.tenant_id = ${tenantId}
        and schema.collection_id = ${collectionId}
      for update of definition
    `),
  );

export const getTaskPropertyDefinitionDeletionImpact = async ({
  db,
  target,
}: {
  readonly db: CoreReadonlyDbExecutor;
  readonly target: TaskPropertyDefinitionLifecycleTarget;
}): Promise<TaskPropertyDeletionImpact> => {
  const adapter = lifecycleAdapterFor(target.datatype);
  if (adapter === undefined) {
    throw new Error(`Unsupported Task Property datatype: ${target.datatype}`);
  }
  const impact =
    adapter.getDeletionImpact === undefined
      ? undefined
      : await adapter.getDeletionImpact({ db, target });
  const impactCount = impact?.impactCount ?? (await adapter.getDeletionImpactCount({ db, target }));
  return {
    impactCount,
    ...(impact === undefined ? {} : { impactRevision: impact.impactRevision }),
    propertyDefinitionId: target.propertyDefinitionId,
    revision: target.revision,
  };
};

const normalizeSelectPropertySchemaPositions = async ({
  source,
  tx,
}: {
  readonly source: TaskPropertyDefinitionLifecycleTarget;
  readonly tx: CoreTransaction;
}): Promise<void> => {
  if (source.datatype !== 'select') {
    return;
  }
  await tx.execute(sql`
    with ranked_positions as materialized (
      select
        sibling.property_definition_id,
        (row_number() over (
          order by sibling.schema_position, sibling.property_definition_id
        ) * 2)::numeric(38, 18) as schema_position
      from ticketing.task_property_definitions as sibling
      where sibling.schema_id = ${source.schemaId}
        and sibling.tenant_id = ${source.tenantId}
    )
    update ticketing.task_property_definitions as sibling
    set schema_position = ranked_positions.schema_position
    from ranked_positions
    where sibling.property_definition_id = ranked_positions.property_definition_id
      and sibling.tenant_id = ${source.tenantId}
  `);
};

const simpleDuplicatedDatatypeValues = [
  ...intrinsicPropertyDatatypeValues,
  'date',
  'email',
  'files_media',
  'phone',
  'text',
  'url',
] as const satisfies readonly TaskPropertyDefinition['datatype'][];

type SimpleDuplicatedDatatype = (typeof simpleDuplicatedDatatypeValues)[number];

const simpleDuplicatedDatatypes = new Set<TaskPropertyDefinition['datatype']>(
  simpleDuplicatedDatatypeValues,
);

const isSimpleDuplicatedDatatype = (
  datatype: TaskPropertyDefinition['datatype'],
): datatype is SimpleDuplicatedDatatype => simpleDuplicatedDatatypes.has(datatype);

// oxlint-disable-next-line eslint/complexity -- Datatype dispatch remains explicit at this deep lifecycle boundary.
export const duplicateTaskPropertyDefinition = async ({
  copyValues,
  source,
  tx,
}: {
  readonly copyValues: boolean;
  readonly source: TaskPropertyDefinitionLifecycleTarget;
  readonly tx: CoreTransaction;
}): Promise<TaskPropertyDefinition | undefined> => {
  const adapter = lifecycleAdapterFor(source.datatype);
  if (adapter === undefined) {
    return undefined;
  }
  const effectiveCopyValues = shouldCopyTaskPropertyDefinitionValues({
    datatype: source.datatype,
    requestedCopyValues: copyValues,
  });
  await normalizeSelectPropertySchemaPositions({ source, tx });
  const result = await tx.execute(sql`
    with available_name as (
      select
        case
          when candidate.ordinal = 1 then ${source.name} || ' Copy'
          else ${source.name} || ' Copy ' || candidate.ordinal::text
        end as name
      from generate_series(1, (
        select count(*)::integer + 1
        from ticketing.task_property_definitions as sibling
        where sibling.schema_id = ${source.schemaId}
      )) as candidate(ordinal)
      where not exists (
        select 1
        from ticketing.task_property_definitions as sibling
        where sibling.schema_id = ${source.schemaId}
          and lower(sibling.name) = lower(
            case
              when candidate.ordinal = 1 then ${source.name} || ' Copy'
              else ${source.name} || ' Copy ' || candidate.ordinal::text
            end
          )
      )
      order by candidate.ordinal
      limit 1
    )
    , positions as (
      select sibling.property_definition_id, sibling.schema_position
      from ticketing.task_property_definitions as sibling
      where sibling.schema_id = ${source.schemaId}
    )
    insert into ticketing.task_property_definitions (
      datatype,
      date_range_time_enabled,
      hidden,
      mandatory,
      name,
      number_format,
      schema_position,
      schema_id,
      select_option_order_mode,
      tenant_id
    )
    select
      ${source.datatype},
      ${source.dateRangeTimeEnabled},
      ${source.datatype === 'text' ? false : source.hidden},
      ${source.mandatory},
      available_name.name,
      ${source.numberFormat},
      case
        when ${source.datatype} = 'select' then (
          select schema_position + 1
          from positions
          where property_definition_id = ${source.propertyDefinitionId}
        )
        else coalesce((select max(schema_position) from positions), 0) + 1
      end,
      ${source.schemaId},
      ${source.selectOptionOrderMode},
      ${source.tenantId}
    from available_name
    returning
      ${source.cardinality}::text as cardinality,
      datatype,
      date_range_time_enabled as "timeEnabled",
      number_format as format,
      hidden,
      mandatory,
      name,
      property_definition_id as "propertyDefinitionId",
      revision,
      select_option_order_mode as "optionOrderMode"
  `);
  const target = rowsFromResult<TaskPropertyDefinition>(result).at(0);
  if (target === undefined) {
    return undefined;
  }
  if (target.datatype === 'number') {
    const definition: TaskPropertyDefinition = {
      datatype: 'number',
      format: target.format,
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
    };
    await adapter.copyValues({ copyValues: effectiveCopyValues, source, target: definition, tx });
    return definition;
  }
  if (target.datatype === 'select') {
    if (source.selectOptionOrderMode === null) {
      throw new Error('Select Task Property option ordering mode is missing.');
    }
    const definition: SelectPropertyDefinition = {
      datatype: 'select',
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      optionOrderMode: source.selectOptionOrderMode,
      options: [],
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
    };
    await adapter.copyValues({ copyValues, source, target: definition, tx });
    const optionsResult = await tx.execute(sql`
      select
        color,
        manual_position as "manualPosition",
        name,
        option_id as "optionId",
        revision
      from ticketing.select_options
      where property_definition_id = ${definition.propertyDefinitionId}
        and tenant_id = ${source.tenantId}
      order by manual_position, option_id
    `);
    return {
      ...definition,
      options: rowsFromResult<SelectOption>(optionsResult),
    };
  }
  if (target.datatype === 'status') {
    const definition: StatusPropertyDefinition = {
      datatype: 'status',
      defaultOptionId: '',
      groups: [],
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
    };
    await adapter.copyValues({ copyValues: effectiveCopyValues, source, target: definition, tx });
    const configurationResult = await tx.execute(sql`
      select
        collection.locale,
        configuration.default_option_id as "defaultOptionId"
      from ticketing.status_property_configurations as configuration
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = configuration.property_definition_id
        and definition.tenant_id = configuration.tenant_id
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      inner join ticketing.task_collections as collection
        on collection.collection_id = schema.collection_id
        and collection.tenant_id = schema.tenant_id
      where configuration.property_definition_id = ${definition.propertyDefinitionId}
        and configuration.tenant_id = ${source.tenantId}
    `);
    const configuration = rowsFromResult<{
      readonly defaultOptionId: string;
      readonly locale: string;
    }>(configurationResult).at(0);
    if (configuration === undefined) {
      throw new Error('Duplicated Status configuration is missing.');
    }
    const optionsResult = await tx.execute(sql`
      select
        color,
        group_key as group,
        name,
        option_id as "optionId",
        position,
        revision
      from ticketing.status_options
      where property_definition_id = ${definition.propertyDefinitionId}
        and tenant_id = ${source.tenantId}
    `);
    return statusDefinitionFromParts({
      ...definition,
      defaultOptionId: configuration.defaultOptionId,
      groupLabel: (group) => statusGroupLabel(group, configuration.locale),
      options: rowsFromResult<StatusOption>(optionsResult),
    });
  }
  if (target.datatype === 'person') {
    if (source.cardinality === null) {
      throw new Error('Person Task Property cardinality is missing.');
    }
    const definition: TaskPropertyDefinition = {
      cardinality: source.cardinality,
      datatype: 'person',
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
    };
    await adapter.copyValues({ copyValues: effectiveCopyValues, source, target: definition, tx });
    return definition;
  }
  if (target.datatype === 'date_range') {
    if (source.dateRangeTimeEnabled === null) {
      throw new Error('Date Range time configuration is missing.');
    }
    const definition: TaskPropertyDefinition = {
      datatype: 'date_range',
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
      timeEnabled: source.dateRangeTimeEnabled,
    };
    await adapter.copyValues({ copyValues: effectiveCopyValues, source, target: definition, tx });
    return definition;
  }
  if (target.datatype === 'checkbox') {
    const definition: TaskPropertyDefinition = {
      datatype: 'checkbox',
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
    };
    await adapter.copyValues({ copyValues: effectiveCopyValues, source, target: definition, tx });
    return definition;
  }
  if (isSimpleDuplicatedDatatype(target.datatype)) {
    const definition: TaskPropertyDefinition = {
      datatype: target.datatype,
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
    };
    await adapter.copyValues({ copyValues: effectiveCopyValues, source, target: definition, tx });
    return definition;
  }
  return undefined;
};

export const deleteTaskPropertyDefinition = async ({
  target,
  tx,
}: {
  readonly target: TaskPropertyDefinitionLifecycleTarget;
  readonly tx: CoreTransaction;
}): Promise<boolean> => {
  const adapter = lifecycleAdapterFor(target.datatype);
  if (adapter === undefined) {
    return false;
  }
  await adapter.deleteValues({ target, tx });
  const result = await tx.execute(sql`
    delete from ticketing.task_property_definitions
    where property_definition_id = ${target.propertyDefinitionId}
      and revision = ${target.revision}
      and schema_id = ${target.schemaId}
      and tenant_id = ${target.tenantId}
    returning property_definition_id as "propertyDefinitionId"
  `);
  return rowsFromResult<{ readonly propertyDefinitionId: string }>(result).length === 1;
};
