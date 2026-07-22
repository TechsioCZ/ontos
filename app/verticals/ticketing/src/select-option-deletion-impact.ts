// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CoreReadonlyDbExecutor } from '@app/core-runtime/db/types';
import { buildOptionDeletionImpactState } from './option-deletion-impact.ts';
import type {
  OptionDeletionImpactMember,
  OptionDeletionImpactState,
} from './option-deletion-impact.ts';

export type SelectOptionDeletionImpactState = OptionDeletionImpactState;

export const getSelectOptionDeletionImpactState = async ({
  db,
  lockAffectedValues = false,
  optionId,
  propertyDefinitionId,
  tenantId,
}: {
  readonly db: CoreReadonlyDbExecutor;
  readonly lockAffectedValues?: boolean;
  readonly optionId: string;
  readonly propertyDefinitionId: string;
  readonly tenantId: string;
}): Promise<SelectOptionDeletionImpactState> => {
  const lockingClause = lockAffectedValues ? sql`for update of value` : sql``;
  const result = await db.execute(sql`
    select
      value.revision,
      value.task_id as "taskId"
    from ticketing.task_select_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    where value.property_definition_id = ${propertyDefinitionId}
      and value.option_id = ${optionId}
      and value.tenant_id = ${tenantId}
    order by value.task_id
    ${lockingClause}
  `);
  const members = rowsFromResult<OptionDeletionImpactMember>(result);
  return buildOptionDeletionImpactState(members);
};
