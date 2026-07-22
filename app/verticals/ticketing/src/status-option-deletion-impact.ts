// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CoreReadonlyDbExecutor } from '@app/core-runtime/db/types';

interface StatusOptionImpactMemberRow {
  readonly revision: number;
  readonly taskId: string;
}

export interface StatusOptionDeletionImpactState {
  readonly impactCount: number;
  readonly impactToken: string;
}

const impactTokenFor = async (members: readonly StatusOptionImpactMemberRow[]) => {
  const serializedMembers = members
    .map(({ revision, taskId }) => `${taskId}:${revision}`)
    .join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializedMembers));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const getStatusOptionDeletionImpactState = async ({
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
}): Promise<StatusOptionDeletionImpactState> => {
  const lockingClause = lockAffectedValues ? sql`for update of value` : sql``;
  const result = await db.execute(sql`
    select
      value.revision,
      value.task_id as "taskId"
    from ticketing.task_status_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    where value.property_definition_id = ${propertyDefinitionId}
      and value.option_id = ${optionId}
      and value.tenant_id = ${tenantId}
    order by value.task_id
    ${lockingClause}
  `);
  const members = rowsFromResult<StatusOptionImpactMemberRow>(result);
  return {
    impactCount: members.length,
    impactToken: await impactTokenFor(members),
  };
};
