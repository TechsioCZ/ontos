// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CoreReadonlyDbExecutor, CoreTransaction } from '@app/core-runtime/db/types';
import type { TaskPropertyDefinition } from '../shared/task-property-definition.ts';
import type { TaskPropertyDeletionImpact } from '../shared/task-property-deletion-impact.ts';

interface TaskPropertyDefinitionLifecycleTarget {
  readonly cardinality: 'one' | 'unlimited' | null;
  readonly datatype: TaskPropertyDefinition['datatype'];
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly numberFormat: string | null;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly schemaId: string;
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
}

interface ImpactCountRow {
  readonly impactCount: number;
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
  email: emailLifecycleAdapter,
  id: idLifecycleAdapter,
  last_edited_time: intrinsicLifecycleAdapter,
  number: numberLifecycleAdapter,
  person: personLifecycleAdapter,
  phone: phoneLifecycleAdapter,
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
        definition.hidden,
        definition.mandatory,
        definition.name,
        definition.number_format as "numberFormat",
        definition.property_definition_id as "propertyDefinitionId",
        definition.revision,
        definition.schema_id as "schemaId",
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
        definition.hidden,
        definition.mandatory,
        definition.name,
        definition.number_format as "numberFormat",
        definition.property_definition_id as "propertyDefinitionId",
        definition.revision,
        definition.schema_id as "schemaId",
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
  return {
    impactCount: await adapter.getDeletionImpactCount({ db, target }),
    propertyDefinitionId: target.propertyDefinitionId,
    revision: target.revision,
  };
};

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
    insert into ticketing.task_property_definitions (
      datatype,
      hidden,
      mandatory,
      name,
      number_format,
      schema_id,
      tenant_id
    )
    select
      ${source.datatype},
      ${source.datatype === 'text' ? false : source.hidden},
      ${source.mandatory},
      available_name.name,
      ${source.numberFormat},
      ${source.schemaId},
      ${source.tenantId}
    from available_name
    returning
      ${source.cardinality}::text as cardinality,
      datatype,
      number_format as format,
      hidden,
      mandatory,
      name,
      property_definition_id as "propertyDefinitionId",
      revision
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
    await adapter.copyValues({ copyValues, source, target: definition, tx });
    return definition;
  }
  if (target.datatype === 'select') {
    return undefined;
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
    await adapter.copyValues({ copyValues, source, target: definition, tx });
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
    await adapter.copyValues({ copyValues, source, target: definition, tx });
    return definition;
  }
  if (
    target.datatype === 'date' ||
    target.datatype === 'created_by' ||
    target.datatype === 'created_time' ||
    target.datatype === 'last_edited_time' ||
    target.datatype === 'email' ||
    target.datatype === 'phone' ||
    target.datatype === 'text' ||
    target.datatype === 'url'
  ) {
    const definition: TaskPropertyDefinition = {
      datatype: target.datatype,
      hidden: target.hidden,
      mandatory: target.mandatory,
      name: target.name,
      propertyDefinitionId: target.propertyDefinitionId,
      revision: target.revision,
    };
    await adapter.copyValues({ copyValues, source, target: definition, tx });
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
