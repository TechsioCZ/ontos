// The one Save of the market's "Sortiment a ceník" section: the price list and the e-shop offers its form changed.
import type { PartlySaved, RevisionedSaveResult, SaveOutcome } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Predicate, Schema } from 'effect';
import type { MarketPricingForm } from './market-form.ts';
import { merchandiseCommand } from './page-data.ts';
import type { MarketCommandInput, MarketCommandResult, WriteFailure, WriteOutcome } from './page-data.ts';

const isProposal = Schema.is(ActionProposalAcceptedSchema);

export interface OfferEdit {
  readonly name: string;
  readonly offered: boolean;
}

/** What the section's form keeps on screen: the price list and every offer changed since the server last had it. */
export interface SectionDraft {
  readonly offers: Readonly<Record<string, OfferEdit>>;
  readonly pricing: MarketPricingForm;
}

/** Each changed product's offer, in a stable order. */
const offerStates = (draft: SectionDraft): string =>
  Object.entries(draft.offers)
    .map(([productId, edit]) => `${productId}:${String(edit.offered)}`)
    .toSorted()
    .join('|');

const samePricing = (left: MarketPricingForm, right: MarketPricingForm): boolean =>
  left.currency === right.currency &&
  left.exchangeRate === right.exchangeRate &&
  left.offerMode === right.offerMode &&
  left.roundingMinor === right.roundingMinor;

/** Two drafts are the same when the price list and each offer's state are the same. */
export const sameSectionDraft = (left: SectionDraft, right: SectionDraft): boolean =>
  samePricing(left.pricing, right.pricing) && offerStates(left) === offerStates(right);

/** One price-list save: the market's new revision once committed; a change parked for approval is 'proposed'. */
export const priceListSaveResult = (result: MarketCommandResult): RevisionedSaveResult =>
  isProposal(result) ? 'proposed' : (result.marketRevision ?? 'saved');

/** The commands of a save, each answering with the outcome the screen shows. */
export interface SectionSteps {
  /** Sends the price list over the market revision it is based on. */
  readonly configure: (
    pricing: MarketPricingForm,
    expectedRevision: number,
  ) => Effect.Effect<WriteOutcome<MarketCommandResult>>;
  /** Sends one offer of a product. */
  readonly offer: (productId: string, offered: boolean) => Effect.Effect<WriteOutcome<MarketCommandResult>>;
  /** The offer of each product as the server has it; moved after every offer that went through. */
  readonly serverOffers: Map<string, boolean>;
}

/** A merchandise command as a screen outcome: a failure is a value, not an error. */
export const writeOutcomeEffect = (
  command: Effect.Effect<MarketCommandResult, WriteFailure>,
): Effect.Effect<WriteOutcome<MarketCommandResult>> =>
  command.pipe(
    Effect.match({
      onFailure: (reason): WriteOutcome<MarketCommandResult> => ({ ok: false, reason }),
      onSuccess: (value): WriteOutcome<MarketCommandResult> => ({ ok: true, value }),
    }),
  );

/** Sends a merchandise command over the given revision, as a screen outcome. */
export const commandOutcome = (command: MarketCommandInput, revision: number) =>
  writeOutcomeEffect(merchandiseCommand(command, revision));

const failureOf = (reason: WriteFailure): 'conflict' | 'failed' => (reason === 'conflict' ? 'conflict' : 'failed');

/** How far the offers of one save got. */
interface OfferRun {
  /** Why an offer was refused; the offers after it were not sent. */
  readonly failure: 'conflict' | 'failed' | null;
  /** Some offer was parked for approval. */
  readonly parked: boolean;
  /** Something of this save went through. */
  readonly wrote: boolean;
}

/** Sends each offer the server does not have yet, once, and stops at the first refused one. */
const sendOffers = (steps: SectionSteps, value: SectionDraft, wrote: boolean): Effect.Effect<OfferRun> => {
  const start = (): OfferRun => ({ failure: null, parked: false, wrote });
  return Effect.reduce(
    Object.entries(value.offers).filter(([productId, edit]) => steps.serverOffers.get(productId) !== edit.offered),
    start,
    (run, [productId, edit]) =>
      run.failure === null
        ? steps.offer(productId, edit.offered).pipe(
            Effect.map((sent): OfferRun => {
              if (!sent.ok) {
                return { ...run, failure: failureOf(sent.reason) };
              }
              if (isProposal(sent.value)) {
                return { ...run, parked: true };
              }
              steps.serverOffers.set(productId, edit.offered);
              return { ...run, wrote: true };
            }),
          )
        : Effect.succeed(run),
  );
};

/** What the server holds after the part of a save that went through; the draft stays unsaved for the rest. */
const partlySaved = (
  steps: SectionSteps,
  value: SectionDraft,
  outcome: Exclude<SaveOutcome, 'saved'>,
  revision: number,
): PartlySaved<SectionDraft> => ({
  confirmed: {
    offers: Object.fromEntries(
      Object.entries(value.offers).map(([productId, edit]) => [
        productId,
        { name: edit.name, offered: steps.serverOffers.get(productId) ?? edit.offered },
      ]),
    ),
    pricing: value.pricing,
  },
  outcome,
  revision,
});

/**
 * One save of the section: the price list first when it changed, then each changed offer once. An offer already on
 * the server is not sent again. A failure after something went through is reported as `PartlySaved`, so the draft
 * keeps only what is still missing. An offer parked for approval does not stop the others.
 */
export const saveSectionEffect = Effect.fn('AssortmentSave.saveSection')(function* saveSection(
  steps: SectionSteps,
  value: SectionDraft,
  confirmed: SectionDraft,
  expectedRevision: number,
) {
  const priceChanged = !samePricing(value.pricing, confirmed.pricing);
  const configured = priceChanged ? yield* steps.configure(value.pricing, expectedRevision) : null;
  if (configured !== null && !configured.ok) {
    return failureOf(configured.reason);
  }
  if (configured !== null && isProposal(configured.value)) {
    return 'proposed' as const;
  }
  const priceSaved = configured === null ? null : priceListSaveResult(configured.value);
  const marketRevision = Predicate.isNumber(priceSaved) ? priceSaved : null;
  const run = yield* sendOffers(steps, value, configured !== null);
  const stopped = run.failure ?? (run.parked ? 'proposed' : null);
  if (stopped === null) {
    return marketRevision ?? ('saved' as const);
  }
  return run.wrote ? partlySaved(steps, value, stopped, marketRevision ?? expectedRevision) : stopped;
});
