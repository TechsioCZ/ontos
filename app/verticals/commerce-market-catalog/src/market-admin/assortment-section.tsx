// "Sortiment a ceník" of the market detail: the merchandise price list of the market and its product exceptions
// (DESIGN 3.2). Price list and offer switches form one draft; its one Save sends the changes.
import {
  SaveBar,
  SaveOutcomeSchema,
  SectionCard,
  UnsavedChangesDialog,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { DraftSaveResult, SaveOutcome } from '@app/admin-ui';
import type { MarketSettings } from '@app/merchandise/domain/market-offers';
import type { RecordsResponse } from '@app/merchandise/contracts/records';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Predicate, Schema } from 'effect';
import { useRef, useState } from 'react';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { commandOutcome, offerCommand, sameSectionDraft, saveSectionEffect } from './assortment-save.ts';
import type { SectionDraft, SectionSteps } from './assortment-save.ts';
import { ExceptionsBlock } from './assortment-exceptions.tsx';
import type { SetOffer } from './assortment-exceptions.tsx';
import type { CurrentMarket } from './eshops-model.ts';
import { PricingFields } from './market-fields.tsx';
import { configureMarketCommand, pricingFormOf, pricingIssues } from './market-form.ts';
import { failureText, useMarketText } from './market-ui.tsx';
import { marketExceptionsData } from './page-data.ts';
import { PriceListSetup } from './price-list-setup.tsx';
import type { ExceptionsInput, MarketInput, WriteFailure, WriteOutcome } from './page-data.ts';

export { priceListSaveResult } from './assortment-save.ts';

interface AssortmentSectionProps {
  readonly input: MarketInput;
  readonly market: CurrentMarket;
  /** A change was parked for approval: nothing changed yet. */
  readonly onAwaitingApproval: () => void;
  readonly onDone: (message: string) => void;
  readonly records: RecordsResponse | undefined;
  readonly recordsFailed: boolean;
  /** Re-reads the price lists (records `markets`). */
  readonly refreshSettings: Effect.Effect<void>;
}

/** The product exceptions shown under the price list, with the page the section is on. */
export interface ExceptionsSpec {
  readonly input: ExceptionsInput;
  /** The offer a product has when it is not an exception. */
  readonly offeredByDefault: boolean;
  readonly onOffset: (offset: number) => void;
}

interface PriceListEditorProps {
  readonly canManage: boolean;
  readonly exceptions?: ExceptionsSpec | undefined;
  readonly market: CurrentMarket;
  readonly onAwaitingApproval: () => void;
  readonly onDone?: ((message: string) => void) | undefined;
  readonly refresh: Effect.Effect<void>;
  /** The catalogue revision of the records the offers are sent over. */
  readonly revision: number;
  readonly settings: MarketSettings;
}

const isSaveOutcome = Schema.is(SaveOutcomeSchema);

const outcomeOf = (result: DraftSaveResult<SectionDraft>): SaveOutcome | number =>
  isSaveOutcome(result) || Predicate.isNumber(result) ? result : result.outcome;

/**
 * The price list and the offers of the section: edits change only the draft on screen, and the one Save sends the
 * changed price list (one ConfigureMarket) and each changed offer once. A change parked for approval is 'proposed'
 * and is not sent again.
 */
export const PriceListEditor = ({
  canManage,
  exceptions,
  market,
  onAwaitingApproval,
  onDone,
  refresh,
  revision,
  settings,
}: PriceListEditorProps) => {
  const { language, text } = useMarketText();
  // The offer of each product as the server has it; a changed product is compared with it on Save.
  const serverOffers = useRef(new Map<string, boolean>());
  const marketId = market.marketRef.resourceId;
  // Why the last command of a save was refused; the save bar names it while the save is failed.
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const noted = <A,>(outcome: WriteOutcome<A>) =>
    Effect.sync(() => {
      setFailure(outcome.ok ? null : outcome.reason);
    });
  const stepsOf = (serverOffersNow: Map<string, boolean>): SectionSteps => ({
    configure: (pricing, expectedRevision) =>
      commandOutcome(
        configureMarketCommand({ expectedRevision, form: pricing, marketCode: market.marketCode, marketId }),
        revision,
      ).pipe(Effect.tap(noted)),
    // Each offer names the offer it was read with, so the owner refuses it when someone changed it in the meantime.
    offer: (productId, offered) =>
      commandOutcome(
        offerCommand({ marketId, offered, productId, read: serverOffersNow.get(productId) }),
        revision,
      ).pipe(Effect.tap(noted)),
    serverOffers: serverOffersNow,
  });
  const announce = (result: DraftSaveResult<SectionDraft>) =>
    Effect.sync(() => {
      const outcome = outcomeOf(result);
      if (outcome === 'proposed') {
        onAwaitingApproval();
        return;
      }
      if (outcome === 'saved' || Predicate.isNumber(outcome)) {
        if (exceptions !== undefined) {
          browserRuntime.runFork(marketExceptionsData.refresh(exceptions.input));
        }
        onDone?.(text('detail.assortment.saved', { code: market.marketCode }));
      }
    });
  const record = useRecordDraft<SectionDraft, never>({
    equals: sameSectionDraft,
    isValid: (value) => pricingIssues(value.pricing).length === 0,
    // "Načíst aktuální verzi" re-reads the offers too, so a conflict shows the other person's offer change and the next
    // switch is checked against it.
    refresh:
      exceptions === undefined ? refresh : Effect.andThen(refresh, marketExceptionsData.refresh(exceptions.input)),
    revision: settings.revision,
    runtime: browserRuntime,
    save: (value, expectedRevision, confirmed) =>
      saveSectionEffect(stepsOf(serverOffers.current), value, confirmed, expectedRevision).pipe(Effect.tap(announce)),
    server: { offers: {}, pricing: pricingFormOf(settings) },
  });
  // Leaving the detail page with unsaved changes asks first; the dialog is the one question for this form.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const labels = saveLabelsFor(language);
  const issues = pricingIssues(record.draft.pricing);
  // A switch or a search result changes the draft only; the section's Save sends it.
  const setOffer: SetOffer = (productId, name, offered, currentlyOffered) => {
    // The offer the product shows now, as last read; a Save compares the draft with it. A search hit does not know
    // the product's offer, so its Save claims no read offer (a plain set, not checked against a stale one).
    if (currentlyOffered === undefined) {
      serverOffers.current.delete(productId);
    } else {
      serverOffers.current.set(productId, currentlyOffered);
    }
    // Switching an offer back to what the server has takes it out of the draft again.
    record.setDraft((current) => {
      const others = Object.fromEntries(Object.entries(current.offers).filter(([id]) => id !== productId));
      return {
        ...current,
        offers: offered === currentlyOffered ? others : { ...others, [productId]: { name, offered } },
      };
    });
  };
  const handleOffset = (offset: number) => exceptions?.onOffset(offset);
  const exceptionsView =
    exceptions === undefined ? null : (
      <ExceptionsBlock
        canManage={canManage}
        input={exceptions.input}
        offeredByDefault={exceptions.offeredByDefault}
        offers={record.draft.offers}
        onOffset={handleOffset}
        onSetOffer={setOffer}
      />
    );
  if (!canManage) {
    const mode = text(`form.offerMode${settings.offerMode}`);
    const summary = text('detail.assortment.summary', {
      currency: settings.currency,
      rate: settings.exchangeRate,
      rounding: settings.roundingMinor,
    });
    return (
      <div className="flex flex-col gap-150">
        <p className="text-sm">{[mode, summary].join(' · ')}</p>
        {exceptionsView}
      </div>
    );
  }
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  return (
    <div className="flex flex-col gap-150">
      <PricingFields
        form={record.draft.pricing}
        issues={issues}
        onChange={(pricing) => record.setDraft((current) => ({ ...current, pricing }))}
        prefix="market-pricing"
        showIssues={issues.length > 0}
        size="sm"
      />
      {exceptionsView}
      <SaveBar
        error={failure === null ? null : failureText(text, failure)}
        labels={labels}
        onReloadLatest={handleReloadLatest}
        onSave={handleSave}
        status={record.status}
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </div>
  );
};
interface PriceListProps {
  readonly canManage: boolean;
  readonly exceptions: ExceptionsSpec | undefined;
  readonly market: CurrentMarket;
  readonly onAwaitingApproval: () => void;
  readonly onDone: (message: string) => void;
  readonly refresh: Effect.Effect<void>;
  readonly revision: number;
  readonly settings: MarketSettings | undefined;
}

const PriceList = ({
  canManage,
  exceptions,
  market,
  onAwaitingApproval,
  onDone,
  refresh,
  revision,
  settings,
}: PriceListProps) => {
  const editable = canManage && market.lifecycle !== 'RETIRED';
  if (settings === undefined) {
    // Creating the price list puts the whole catalogue on the market's e-shops: it asks first.
    return (
      <PriceListSetup
        editable={editable}
        market={market}
        onAwaitingApproval={onAwaitingApproval}
        onDone={onDone}
        revision={revision}
      />
    );
  }
  return (
    <PriceListEditor
      canManage={editable}
      exceptions={exceptions}
      key={market.marketRef.resourceId}
      market={market}
      onAwaitingApproval={onAwaitingApproval}
      onDone={onDone}
      refresh={refresh}
      revision={revision}
      settings={settings}
    />
  );
};

export const AssortmentSection = ({
  input,
  market,
  onAwaitingApproval,
  onDone,
  records,
  recordsFailed,
  refreshSettings,
}: AssortmentSectionProps) => {
  const { text } = useMarketText();
  const [offset, setOffset] = useState(0);
  if (records === undefined) {
    return (
      <SectionCard title={text('detail.assortment.title')}>
        <StatusText status={recordsFailed ? 'error' : 'default'}>
          {text(recordsFailed ? 'detail.assortment.unavailable' : 'detail.loading')}
        </StatusText>
      </SectionCard>
    );
  }
  const page: ExceptionsInput = { ...input, offset };
  const settings = records.markets?.find((candidate) => candidate.marketId === input.marketId);
  const canManage = records.canManageMarkets === true && market.lifecycle !== 'RETIRED';
  const retired = market.lifecycle === 'RETIRED';
  const offeredByDefault = settings?.offerMode !== 'SELECTED_PRODUCTS';
  const exceptions =
    retired || settings === undefined ? undefined : { input: page, offeredByDefault, onOffset: setOffset };
  return (
    <SectionCard title={text('detail.assortment.title')}>
      <PriceList
        canManage={canManage}
        exceptions={exceptions}
        market={market}
        onAwaitingApproval={onAwaitingApproval}
        onDone={onDone}
        refresh={refreshSettings}
        revision={records.revision}
        settings={settings}
      />
      {retired && <p className="text-fg-secondary text-sm">{text('detail.assortment.retired')}</p>}
      {!retired && !canManage && settings !== undefined && (
        <p className="text-fg-secondary text-sm">{text('detail.assortment.readOnly')}</p>
      )}
    </SectionCard>
  );
};
