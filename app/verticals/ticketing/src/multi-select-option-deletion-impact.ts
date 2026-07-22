// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CoreReadonlyDbExecutor } from '@app/core-runtime/db/types';

interface MultiSelectOptionImpactMemberRow {
  readonly revision: number;
  readonly taskId: string;
}

export interface MultiSelectOptionDeletionImpactState {
  readonly impactCount: number;
  readonly impactToken: string;
}

const impactTokenFor = async (members: readonly MultiSelectOptionImpactMemberRow[]) => {
  const serializedMembers = members
    .map(({ revision, taskId }) => `${taskId}:${revision}`)
    .join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializedMembers));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const getMultiSelectOptionDeletionImpactState = async ({
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
}): Promise<MultiSelectOptionDeletionImpactState> => {
  const lockingClause = lockAffectedValues ? sql`for update of value` : sql``;
  const result = await db.execute(sql`
    select
      value.revision,
      value.task_id as "taskId"
    from ticketing.task_multi_select_values as value
    inner join ticketing.task_multi_select_selections as selection
      on selection.task_id = value.task_id
      and selection.property_definition_id = value.property_definition_id
      and selection.tenant_id = value.tenant_id
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    where value.property_definition_id = ${propertyDefinitionId}
      and selection.option_id = ${optionId}
      and value.tenant_id = ${tenantId}
    order by value.task_id
    ${lockingClause}
  `);
  const members = rowsFromResult<MultiSelectOptionImpactMemberRow>(result);
  return {
    impactCount: members.length,
    impactToken: await impactTokenFor(members),
  };
};
