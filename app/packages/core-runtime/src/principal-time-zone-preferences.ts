// @effect-diagnostics asyncFunction:off
import { sql } from './db/sql.ts';
import type { CoreReadonlyDbExecutor } from './db/types.ts';
import { rejectAction } from './core-sdk.ts';
import type { ActionHandler } from './core-sdk.ts';
import type { OperationContext } from './operation-context.ts';
import { rowsFromResult } from './sql-result.ts';

export interface EffectiveTimeZone {
  readonly source: 'browser_fallback' | 'configured' | 'system_fallback';
  readonly timeZone: string;
}

interface PrincipalPreferenceRow {
  readonly kind: 'agent' | 'human' | 'integration' | 'service' | 'system';
  readonly status: 'active' | 'archived' | 'disabled';
  readonly timeZone: string | null;
}

export interface ConfigurePrincipalTimeZonePreferencePayload {
  readonly timeZone: string;
}

export interface ConfigurePrincipalTimeZonePreferenceResponse extends EffectiveTimeZone {
  readonly principalId: string;
  readonly source: 'configured';
}

const canonicalIanaTimeZone = (candidate: string): string | undefined => {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export const configurePrincipalTimeZonePreferenceActionHandler: ActionHandler<
  ConfigurePrincipalTimeZonePreferencePayload,
  ConfigurePrincipalTimeZonePreferenceResponse
> = async (input, { context, tx }) => {
  const canonicalTimeZone = canonicalIanaTimeZone(input.timeZone.trim());
  if (canonicalTimeZone === undefined) {
    throw rejectAction({
      code: 'core.principalPreferences.invalid_time_zone',
      message: 'Core Principal Preferences requires a recognized IANA time zone.',
    });
  }
  const result = await tx.execute(sql`
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
    returning principal_id as "principalId", time_zone as "timeZone"
  `);
  const configured = rowsFromResult<{
    readonly principalId: string;
    readonly timeZone: string;
  }>(result).at(0);
  if (configured === undefined) {
    throw rejectAction({
      code: 'core.principalPreferences.active_human_required',
      message: 'Core Principal Preferences requires an active human Principal.',
    });
  }
  return { ...configured, source: 'configured' };
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
    select
      principal.kind,
      principal.status,
      preference.time_zone as "timeZone"
    from core.principals as principal
    left join core.principal_time_zone_preferences as preference
      on preference.principal_id = principal.principal_id
      and preference.tenant_id = principal.tenant_id
    where principal.principal_id = ${context.principalId}
      and principal.tenant_id = ${context.tenantId}
    limit 1
  `);
  const principal = rowsFromResult<PrincipalPreferenceRow>(result).at(0);
  if (principal?.kind !== 'human' || principal.status !== 'active') {
    return { source: 'system_fallback', timeZone: 'UTC' };
  }
  if (principal.timeZone !== null) {
    const configuredTimeZone = canonicalIanaTimeZone(principal.timeZone);
    if (configuredTimeZone !== undefined) {
      return { source: 'configured', timeZone: configuredTimeZone };
    }
  }
  const browserFallback =
    browserTimeZone === undefined ? undefined : canonicalIanaTimeZone(browserTimeZone.trim());
  return browserFallback === undefined
    ? { source: 'system_fallback', timeZone: 'UTC' }
    : { source: 'browser_fallback', timeZone: browserFallback };
};
