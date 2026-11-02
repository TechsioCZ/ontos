// Autosave of the facility edit panels: one governed command per draft, its failure mapped onto the status line.
import type { AutosaveOutcome } from '@app/admin-ui';
import { Effect } from 'effect';
import type { CommandOutcome } from './use-agenda.ts';

/**
 * One facility command as autosave sees it. The agenda refuses a draft built on an outdated revision, which is the
 * conflict the panel offers to resolve; every other failure is retried from the status line.
 */
export const facilityAutosaveOutcome = (run: Effect.Effect<CommandOutcome>): Effect.Effect<AutosaveOutcome> =>
  run.pipe(
    Effect.map((outcome): AutosaveOutcome => {
      if (outcome.ok) {
        return 'saved';
      }
      return outcome.reason === 'conflict' ? 'conflict' : 'failed';
    }),
  );
