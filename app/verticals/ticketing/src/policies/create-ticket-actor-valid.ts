// @effect-diagnostics asyncFunction:off
import { allowPolicy, denyPolicy, rowsFromResult } from '@app/core-runtime';
import type { PolicyCheck } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import type { CreateTicketActionPayload } from '../../shared/actions/create-ticket.ts';

const policyKey = 'ticketing.createTicket.actor.valid';

export const createTicketActorValid: PolicyCheck<CreateTicketActionPayload> = async ({
  db,
  operation,
}) => {
  const result = await db.execute(sql`
    select principal_id as "principalId"
    from core.principals
    where principal_id = ${operation.principalId}
      and tenant_id = ${operation.tenantId}
      and status = 'active'
    limit 1
  `);
  const actor = rowsFromResult<{ readonly principalId: string }>(result).at(0);

  return actor === undefined
    ? denyPolicy({
        code: 'ticketing.createTicket.actor_invalid',
        message: 'Task creation requires a valid Actor.',
        policyKey,
        reason: 'Trusted operation context did not resolve an active tenant Principal.',
        state: {},
      })
    : allowPolicy({
        policyKey,
        reason: 'Trusted operation context resolved an active tenant Principal.',
      });
};
