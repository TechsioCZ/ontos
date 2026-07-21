// @effect-diagnostics asyncFunction:off
import { sql } from './db/sql.ts';
import type { CoreDbExecutor, CoreReadonlyDbExecutor } from './db/types.ts';
import type { OperationContext } from './operation-context.ts';
import { rowsFromResult } from './sql-result.ts';

export interface EffectiveTimeZone {
  readonly source: 'browser_fallback' | 'configured' | 'system_fallback';
  readonly timeZone: string;
}

interface PreferenceRow {
  readonly timeZone: string;
}

const canonicalIanaTimeZone = (candidate: string): string | undefined => {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export const configurePrincipalTimeZonePreference = async ({
  context,
  db,
  timeZone,
}: {
  readonly context: Pick<OperationContext<unknown>, 'principalId' | 'tenantId'>;
  readonly db: CoreDbExecutor;
  readonly timeZone: string;
}): Promise<EffectiveTimeZone> => {
  const canonicalTimeZone = canonicalIanaTimeZone(timeZone.trim());
  if (canonicalTimeZone === undefined) {
    throw new Error('Core Principal Preferences requires a recognized IANA time zone.');
  }
  const result = await db.execute(sql`
    insert into core.principal_time_zone_preferences (
      principal_id,
      tenant_id,
      time_zone
    )
    select
      principal.principal_id,
      principal.tenant_id,
      ${canonicalTimeZone}
    from core.principals as principal
    where principal.principal_id = ${context.principalId}
      and principal.tenant_id = ${context.tenantId}
      and principal.kind = 'human'
      and principal.status = 'active'
    on conflict (tenant_id, principal_id) do update
      set time_zone = excluded.time_zone,
          updated_at = now()
    returning time_zone as "timeZone"
  `);
  const configured = rowsFromResult<PreferenceRow>(result).at(0);
  if (configured === undefined) {
    throw new Error('Core Principal Preferences requires an active human Principal.');
  }
  return { source: 'configured', timeZone: configured.timeZone };
};

export const resolveEffectiveTimeZone = async ({
  browserTimeZone,
  context,
  db,
}: {
  readonly browserTimeZone?: string;
  readonly context: Pick<OperationContext<unknown>, 'principalId' | 'tenantId'>;
  readonly db: CoreReadonlyDbExecutor;
}): Promise<EffectiveTimeZone> => {
  const result = await db.execute(sql`
    select preference.time_zone as "timeZone"
    from core.principal_time_zone_preferences as preference
    inner join core.principals as principal
      on principal.principal_id = preference.principal_id
      and principal.tenant_id = preference.tenant_id
    where preference.principal_id = ${context.principalId}
      and preference.tenant_id = ${context.tenantId}
      and principal.kind = 'human'
    limit 1
  `);
  const configured = rowsFromResult<PreferenceRow>(result).at(0);
  if (configured !== undefined) {
    return { source: 'configured', timeZone: configured.timeZone };
  }
  const browserFallback =
    browserTimeZone === undefined ? undefined : canonicalIanaTimeZone(browserTimeZone.trim());
  return browserFallback === undefined
    ? { source: 'system_fallback', timeZone: 'UTC' }
    : { source: 'browser_fallback', timeZone: browserFallback };
};
