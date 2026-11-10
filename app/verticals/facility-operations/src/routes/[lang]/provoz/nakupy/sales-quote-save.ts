// Save of the quote edit panel: one governed update per click on Uložit, its refusals on the save bar.
import { useDraftSave } from '@app/admin-ui';
import type { SavableDraft, SaveOutcome } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { SalesCustomer, SalesQuote } from '../../../../../shared/domain/purchasing.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useDraftBase } from '../../../../ui/draft-base.ts';
import { facilitySaveOutcome } from '../../../../ui/facility-save.ts';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';
import { quoteDraftOf, quoteUpdateCommandOf, sameQuoteDraft } from './sales-quote-draft.ts';
import type { QuoteDraft } from './sales-quote-draft.ts';

/** The draft of an edit of an existing quote, for its save bar and its unsaved-changes guard. */
export interface QuoteDraftSave extends SavableDraft {
  /** "Zahodit změny": puts the version the server last confirmed back into the panel. */
  readonly discard: () => void;
  readonly reloadLatest: () => void;
}

/**
 * Explicit save of one quote edit: nothing is sent until `save()`, and it carries the revision of the read the draft
 * was built on; a settled draft follows a newer read of the quote. `customerOf` resolves the draft's customer (only a
 * ready customer read can), and `applyStored` puts a stored version back into the panel (someone else's change, or a
 * discarded draft).
 */
export const useQuoteDraftSave = ({
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
}): QuoteDraftSave => {
  // Saves carry the revision of the read the draft was built on, so someone else's newer change refuses them.
  const base = useDraftBase(quote, run);
  const record = useDraftSave<QuoteDraft, never>({
    equals: sameQuoteDraft,
    isValid: (value) => quote !== undefined && Option.isSome(quoteUpdateCommandOf(value, quote, customerOf(value))),
    runtime: browserRuntime,
    save: (value) =>
      quote === undefined
        ? Effect.succeed<SaveOutcome>('failed')
        : Option.match(quoteUpdateCommandOf(value, quote, customerOf(value)), {
            onNone: () => Effect.succeed<SaveOutcome>('failed'),
            onSome: (command) => base.confirm(facilitySaveOutcome(base.run(command))),
          }),
    value: draft,
  });
  base.sync({
    onAdopt: () => {
      if (quote === undefined) {
        return;
      }
      const stored = quoteDraftOf(quote);
      if (!sameQuoteDraft(stored, draft)) {
        record.adopt(stored);
        applyStored(stored);
      }
    },
    settled: !record.pending && sameQuoteDraft(draft, record.confirmed),
  });
  const reloadLatest = () => {
    if (quote !== undefined) {
      const stored = quoteDraftOf(quote);
      base.rebase();
      record.adopt(stored);
      applyStored(stored);
    }
  };
  return {
    afterSave: record.afterSave,
    canSave: record.canSave,
    dirty: record.dirty,
    discard: () => {
      applyStored(record.confirmed);
    },
    reloadLatest,
    save: record.save,
    status: record.status,
  };
};
