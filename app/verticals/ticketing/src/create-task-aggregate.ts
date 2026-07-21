// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CoreTransaction } from '@app/core-runtime/db/types';
import type { TaskCreationRow } from './task-collection-aggregate.ts';

export const createTaskAggregate = async ({
  collectionId,
  createdAt,
  principalId,
  tenantId,
  tx,
}: {
  readonly collectionId: string;
  readonly createdAt: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly tx: CoreTransaction;
}): Promise<TaskCreationRow | undefined> => {
  const creationResult = await tx.execute(sql`
    with created_task as (
      insert into ticketing.tasks (
        collection_id,
        created_at,
        created_by_principal_id,
        last_edited_at,
        last_edited_by_principal_id,
        tenant_id
      )
      select
        collection_id,
        ${createdAt}::timestamptz,
        ${principalId},
        ${createdAt}::timestamptz,
        ${principalId},
        ${tenantId}
      from ticketing.task_collections
      where collection_id = ${collectionId}
        and tenant_id = ${tenantId}
      returning
        collection_id,
        created_at,
        created_by_principal_id,
        last_edited_at,
        last_edited_by_principal_id,
        revision,
        task_id,
        title
    ),
    created_revision as (
      insert into ticketing.task_revisions (
        changed_at,
        changed_by_principal_id,
        reason,
        revision,
        task_id,
        tenant_id
      )
      select
        created_at,
        ${principalId},
        'created',
        revision,
        task_id,
        ${tenantId}
      from created_task
      returning task_id
    ),
    allocated_id as (
      update ticketing.task_id_sequences as sequence
      set next_number = sequence.next_number + 1
      from created_task
      where sequence.collection_id = created_task.collection_id
        and sequence.tenant_id = ${tenantId}
      returning
        sequence.next_number - 1 as number,
        sequence.property_definition_id
    ),
    initialized_id_assignment as (
      insert into ticketing.task_id_assignments (
        number,
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        allocated_id.number,
        allocated_id.property_definition_id,
        created_task.task_id,
        ${tenantId}
      from created_task
      inner join allocated_id on true
      returning task_id
    ),
    initialized_checkbox_values as (
      insert into ticketing.task_checkbox_values (
        property_definition_id,
        task_id,
        tenant_id,
        value
      )
      select
        definition.property_definition_id,
        created_task.task_id,
        ${tenantId},
        false
      from created_task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = created_task.collection_id
        and schema.tenant_id = ${tenantId}
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.tenant_id = ${tenantId}
        and definition.datatype = 'checkbox'
      returning task_id
    ),
    initialized_text_values as (
      insert into ticketing.task_text_values (
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        definition.property_definition_id,
        created_task.task_id,
        ${tenantId}
      from created_task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = created_task.collection_id
        and schema.tenant_id = ${tenantId}
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.tenant_id = ${tenantId}
        and definition.datatype = 'text'
      returning task_id
    ),
    initialized_url_values as (
      insert into ticketing.task_url_values (
        property_definition_id,
        task_id,
        tenant_id
      )
      select
        definition.property_definition_id,
        created_task.task_id,
        ${tenantId}
      from created_task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = created_task.collection_id
        and schema.tenant_id = ${tenantId}
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.tenant_id = ${tenantId}
        and definition.datatype = 'url'
      returning task_id
    )
    select
      created_task.collection_id as "collectionId",
      to_char(
        created_task.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "createdAt",
      created_task.created_by_principal_id as "createdByPrincipalId",
      to_char(
        created_task.last_edited_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as "lastEditedAt",
      created_task.last_edited_by_principal_id as "lastEditedByPrincipalId",
      created_task.revision as "revision",
      created_task.task_id as "taskId",
      created_task.title as "title"
    from created_task
    inner join created_revision using (task_id)
  `);

  return rowsFromResult<TaskCreationRow>(creationResult).at(0);
};
