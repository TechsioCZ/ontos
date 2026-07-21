// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type { CoreReadonlyDbExecutor } from '@app/core-runtime/db/types';
import { sql } from '@app/core-runtime/db/sql';

interface MandatoryViolationRow {
  readonly datatype: 'email' | 'phone' | 'status';
}

export const rejectTaskEditWithEmptyMandatoryProperty = async ({
  collectionId,
  db,
  proposedValue,
  taskId,
  tenantId,
}: {
  readonly collectionId: string;
  readonly db: CoreReadonlyDbExecutor;
  readonly proposedValue?: {
    readonly datatype?: 'email' | 'phone' | 'status';
    readonly propertyDefinitionId: string;
    readonly value: string | null;
  };
  readonly taskId: string;
  readonly tenantId: string;
}) => {
  const proposedPropertyDefinitionId = proposedValue?.propertyDefinitionId ?? null;
  const proposedIsEmpty = proposedValue?.value === null;
  const result = await db.execute(sql`
    select definition.datatype
    from ticketing.tasks as task
    inner join ticketing.task_schemas as schema
      on schema.collection_id = task.collection_id
      and schema.tenant_id = task.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.schema_id = schema.schema_id
      and definition.tenant_id = schema.tenant_id
      and definition.datatype in ('email', 'phone', 'status')
      and definition.mandatory
    left join ticketing.task_email_values as email_value
      on email_value.task_id = task.task_id
      and email_value.property_definition_id = definition.property_definition_id
      and email_value.tenant_id = task.tenant_id
      and definition.datatype = 'email'
    left join ticketing.task_phone_values as phone_value
      on phone_value.task_id = task.task_id
      and phone_value.property_definition_id = definition.property_definition_id
      and phone_value.tenant_id = task.tenant_id
      and definition.datatype = 'phone'
    left join ticketing.task_status_values as status_value
      on status_value.task_id = task.task_id
      and status_value.property_definition_id = definition.property_definition_id
      and status_value.tenant_id = task.tenant_id
      and definition.datatype = 'status'
    where task.task_id = ${taskId}
      and task.collection_id = ${collectionId}
      and task.tenant_id = ${tenantId}
      and case
        when definition.property_definition_id = ${proposedPropertyDefinitionId}
          then ${proposedIsEmpty}
        when definition.datatype = 'email' then email_value.value is null
        when definition.datatype = 'phone' then phone_value.value is null
        else status_value.option_id is null
      end
    order by definition.created_at, definition.property_definition_id
    limit 1
  `);
  const violation = rowsFromResult<MandatoryViolationRow>(result).at(0);
  if (violation !== undefined) {
    const datatypeLabel = {
      email: 'Email',
      phone: 'Phone',
      status: 'Status',
    }[violation.datatype];
    throw rejectAction({
      code: `ticketing.taskEdit.mandatory_${violation.datatype}_empty`,
      message: `Complete every Mandatory ${datatypeLabel} before saving this Task edit.`,
    });
  }
};
