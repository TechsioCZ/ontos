// @effect-diagnostics asyncFunction:off
// Runs `agenda` commands against the current agenda revision; on a stale revision it re-reads the agenda once and
// retries (all agenda commands are safe to retry: delivery is deduplicated, mark-read is idempotent).
import { useCallback } from 'react';
import type { OpsCommand } from '../../../shared/agendas.ts';
import { loadRecords, runCommand } from '../use-agenda.ts';
import type { CommandOutcome } from '../use-agenda.ts';
import type { SiamparkSources } from './sources.ts';

export const useAgendaCommands = (sources: SiamparkSources, reload: () => Promise<void>) => {
  const revision = sources.ops.data?.agendas.agenda?.revision ?? 0;
  const run = useCallback(
    async (command: OpsCommand, options: { readonly reload?: boolean } = {}): Promise<CommandOutcome> => {
      let outcome = await runCommand(command, revision);
      if (!outcome.ok && outcome.reason === 'conflict') {
        const fresh = await loadRecords({ agendas: ['agenda'] });
        if (fresh.ok) {
          outcome = await runCommand(command, fresh.data.agendas.agenda?.revision ?? 0);
        }
      }
      if (options.reload !== false) {
        await reload();
      }
      return outcome;
    },
    [revision, reload],
  );
  return { canWrite: sources.ops.data?.agendas.agenda?.canWrite === true, revision, run };
};
