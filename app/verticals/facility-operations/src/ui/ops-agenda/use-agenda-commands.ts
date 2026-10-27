// Retrying a stale agenda command first reloads its revision. Delivery commands remain idempotent.
import { DateTime, Effect } from 'effect';

import type { OpsCommand } from '../../../shared/agendas.ts';
import { loadRecords, runCommand } from '../use-agenda.ts';
import type { CommandOutcome } from '../use-agenda.ts';
import type { RentalOverviewSources } from './sources.ts';

interface AgendaCommandContext {
  readonly base: string | undefined;
  readonly reload: () => Effect.Effect<void>;
  readonly revision: number;
  readonly shouldReload: boolean;
}
const executeAgendaCommand = Effect.fn('FacilityOperations.runOverviewAgendaCommand')(function* overviewAgendaCommand(
  command: OpsCommand,
  context: AgendaCommandContext,
): Effect.fn.Return<CommandOutcome> {
  let outcome = yield* runCommand(command, context.revision, context.base);
  if (!outcome.ok && outcome.reason === 'conflict') {
    const fresh = yield* loadRecords({ agendas: ['agenda'] });
    if (fresh.ok) {
      outcome = yield* runCommand(command, fresh.data.agendas.agenda?.revision ?? 0);
    }
  }
  if (context.shouldReload) {
    yield* context.reload();
  }
  return outcome;
});

export const useAgendaCommands = (sources: RentalOverviewSources, reload: () => Effect.Effect<void>) => {
  const revision = sources.ops.data?.agenda?.revision ?? 0;
  const loadedAt = sources.ops.data?.agenda?.updatedAt;
  const base = loadedAt === undefined ? undefined : DateTime.formatIso(loadedAt);
  const run = (command: OpsCommand, options: { readonly reload?: boolean } = {}) =>
    executeAgendaCommand(command, { base, reload, revision, shouldReload: options.reload !== false });
  return { canWrite: sources.ops.data?.agenda?.canWrite === true, revision, run };
};
