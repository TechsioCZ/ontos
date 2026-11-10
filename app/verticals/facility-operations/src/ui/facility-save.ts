// Save of the facility edit panels: one governed command per Save click, its failure mapped onto the save bar.
import type { SaveOutcome } from '@app/admin-ui';
import { Effect } from 'effect';
import type { CommandOutcome } from './use-agenda.ts';

/**
 * One facility command as the save bar sees it. The agenda refuses a draft built on an outdated revision, which is
 * the conflict the panel offers to resolve. A change the agenda parked for approval is `proposed`: it is not saved
 * and the same draft is never sent again. Every other failure leaves the draft for the next click on Uložit.
 */
export const facilitySaveOutcome = (run: Effect.Effect<CommandOutcome>): Effect.Effect<SaveOutcome> =>
  run.pipe(
    Effect.map((outcome): SaveOutcome => {
      if (outcome.ok) {
        return 'saved';
      }
      if (outcome.reason === 'approval_required') {
        return 'proposed';
      }
      return outcome.reason === 'conflict' ? 'conflict' : 'failed';
    }),
  );
