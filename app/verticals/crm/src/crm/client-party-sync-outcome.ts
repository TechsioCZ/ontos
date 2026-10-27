import type { CrmCommand } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandResponse } from '../../shared/apis/apply-command-action.ts';
import { Predicate } from 'effect';

export interface CrmCommandOutcome {
  readonly entityIds: readonly string[];
  readonly message?: string;
  readonly ok: boolean;
}

/** Transport/Action success alone does not prove the post-commit registry writes. */
export const commandResultOutcome = (
  command: CrmCommand,
  result: ApplyCommandResponse,
  translate: (key: string, values: { readonly linked: number; readonly remaining: number }) => string,
): CrmCommandOutcome => {
  if (!Predicate.isTagged(command, 'SyncClientParties')) {
    return { entityIds: result.entityIds, ok: true };
  }
  const sync = result.clientPartySync;
  if (sync === undefined || sync.status === 'unavailable') {
    return {
      entityIds: result.entityIds,
      message: translate('crm.registrySync.unavailable', { linked: 0, remaining: 0 }),
      ok: false,
    };
  }
  if (sync.status === 'complete' && sync.linked > 0 && sync.remaining === 0 && sync.failed === 0 && sync.review === 0) {
    return { entityIds: result.entityIds, ok: true };
  }
  let key = 'crm.registrySync.unavailable';
  if (sync.status === 'unchanged') {
    key = 'crm.registrySync.unchanged';
  } else if (sync.status === 'partial') {
    key = 'crm.registrySync.partial';
  }
  return {
    entityIds: result.entityIds,
    message: translate(key, { linked: sync.linked, remaining: sync.remaining }),
    ok: false,
  };
};
