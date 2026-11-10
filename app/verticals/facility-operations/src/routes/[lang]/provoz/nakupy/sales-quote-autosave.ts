// Save of the quote edit panel: one governed update per draft, its refusals on the inline status line.
import { useDraftSave } from '@app/admin-ui';
import type { SaveOutcome, SaveState } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { SalesCustomer, SalesQuote } from '../../../../../shared/domain/purchasing.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { facilityAutosaveOutcome } from '../../../../ui/facility-autosave.ts';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';
import { quoteDraftOf, quoteUpdateCommandOf, sameQuoteDraft } from './sales-quote-draft.ts';
import type { QuoteDraft } from './sales-quote-draft.ts';

/** What an edit of an existing quote renders instead of its save button. */
export interface QuoteAutosave {
  readonly reloadLatest: () => void;
  readonly save: () => void;
  readonly status: SaveState;
}

/**
 * Save of one quote edit. `customerOf` resolves the draft's customer (only a ready customer read can), and
 * `applyStored` puts the server version back into the panel when someone else changed the quote.
 */
export const useQuoteAutosave = ({
  applyStored,
  customerOf,
  draft,
  quote,
  run,
}: {
  readonly applyStored: (value: QuoteDraft) => void;
  readonly customerOf: (value: QuoteDraft) => SalesCustomer | undefined;
  readonly draft: QuoteDraft;
  readonly quote: SalesQuote | undefined;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}): QuoteAutosave => {
  const autosave = useDraftSave<QuoteDraft, never>({
    equals: sameQuoteDraft,
    isValid: (value) => quote !== undefined && Option.isSome(quoteUpdateCommandOf(value, quote, customerOf(value))),
    runtime: browserRuntime,
    save: (value) =>
      quote === undefined
        ? Effect.succeed<SaveOutcome>('failed')
        : Option.match(quoteUpdateCommandOf(value, quote, customerOf(value)), {
            onNone: () => Effect.succeed<SaveOutcome>('failed'),
            onSome: (command) => facilityAutosaveOutcome(run(command)),
          }),
    value: draft,
  });
  const reloadLatest = () => {
    if (quote !== undefined) {
      const stored = quoteDraftOf(quote);
      autosave.adopt(stored);
      applyStored(stored);
    }
  };
  return { reloadLatest, save: autosave.save, status: autosave.status };
};
