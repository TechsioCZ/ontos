// @effect-diagnostics asyncFunction:off
import { sql } from './db/sql.ts';
import type { CoreReadonlyDbExecutor } from './db/types.ts';
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

const canonicalIanaTimeZone = (candidate: string): string | undefined => {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
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
