// @effect-diagnostics asyncFunction:off
import { rejectAction, rowsFromResult } from '@app/core-runtime';
import type { CoreReadonlyDbExecutor } from '@app/core-runtime/db/types';
import { sql } from '@app/core-runtime/db/sql';

interface MandatoryViolationRow {
  readonly hasViolation: boolean;
}

export const rejectTaskEditWithEmptyMandatoryEmail = async ({
  collectionId,
  db,
  taskId,
  tenantId,
}: {
  readonly collectionId: string;
  readonly db: CoreReadonlyDbExecutor;
  readonly taskId: string;
  readonly tenantId: string;
}) => {
  const result = await db.execute(sql`
    select exists (
      select 1
      from ticketing.tasks as task
      inner join ticketing.task_schemas as schema
        on schema.collection_id = task.collection_id
        and schema.tenant_id = task.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.tenant_id = schema.tenant_id
        and definition.datatype = 'email'
        and definition.mandatory
      left join ticketing.task_email_values as value
        on value.task_id = task.task_id
        and value.property_definition_id = definition.property_definition_id
        and value.tenant_id = task.tenant_id
      where task.task_id = ${taskId}
        and task.collection_id = ${collectionId}
        and task.tenant_id = ${tenantId}
        and value.value is null
    ) as "hasViolation"
  `);
  if (rowsFromResult<MandatoryViolationRow>(result).at(0)?.hasViolation === true) {
    throw rejectAction({
      code: 'ticketing.taskEdit.mandatory_email_empty',
      message: 'Complete every Mandatory Email before saving this Task edit.',
    });
  }
};
