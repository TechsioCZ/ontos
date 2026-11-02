import { sql } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import type { CoreTransaction } from '../db/types.ts';

/**
 * Live change notifications: an invalidation key published inside a committing Core transaction.
 *
 * PostgreSQL delivers a `NOTIFY` only when its transaction commits, so a listener learns about committed changes only.
 * The payload names the scope that changed (tenant, legal entity or the whole tenant, module ids) and never carries
 * data or the actor. The Shell's single listener fans it out to the browser sessions allowed to read those modules,
 * which then revalidate what they show.
 */
export const LIVE_CHANGE_CHANNEL = 'ontos_live_changes';

export interface LiveChange {
  /** `null` when the change is tenant-wide (every legal entity of the tenant revalidates). */
  readonly legalEntityId: string | null;
  readonly moduleKeys: readonly string[];
  readonly tenantId: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const moduleKey = /^[a-z][a-z0-9_.-]{0,199}$/u;
/** Keeps the payload far below PostgreSQL's 8000-byte NOTIFY limit; a larger set is not published (callers name 1-3). */
const MAX_MODULES = 64;

/** `tenant|legalEntity-or-empty|module,module`: identifiers only, so no escaping is needed. */
export const encodeLiveChange = ({ legalEntityId, moduleKeys, tenantId }: LiveChange): Option.Option<string> => {
  const modules = [...new Set(moduleKeys)].filter((key) => moduleKey.test(key)).toSorted();
  if (
    !uuid.test(tenantId) ||
    (legalEntityId !== null && !uuid.test(legalEntityId)) ||
    modules.length === 0 ||
    modules.length > MAX_MODULES
  ) {
    return Option.none();
  }
  return Option.some(`${tenantId}|${legalEntityId ?? ''}|${modules.join(',')}`);
};

export const decodeLiveChange = (payload: string): Option.Option<LiveChange> => {
  const [tenantId, legalEntityId, modules, ...rest] = payload.split('|');
  if (rest.length > 0 || tenantId === undefined || legalEntityId === undefined || modules === undefined) {
    return Option.none();
  }
  const moduleKeys = modules.split(',');
  if (
    !uuid.test(tenantId) ||
    (legalEntityId !== '' && !uuid.test(legalEntityId)) ||
    moduleKeys.length > MAX_MODULES ||
    !moduleKeys.every((key) => moduleKey.test(key))
  ) {
    return Option.none();
  }
  return Option.some({ legalEntityId: legalEntityId === '' ? null : legalEntityId, moduleKeys, tenantId });
};

/** Queues the notification on the transaction's own connection; it is delivered only if the transaction commits. */
export const notifyLiveChange = (transaction: CoreTransaction, change: LiveChange) => {
  const payload = encodeLiveChange(change);
  return Option.isNone(payload)
    ? Effect.void
    : transaction.execute(sql`select pg_notify(${LIVE_CHANGE_CHANNEL}, ${payload.value})`).pipe(Effect.asVoid);
};
