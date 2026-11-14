// "Nový trh": the market definition for the signed-in company, then its merchandise price list (DESIGN 4).
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { DateTime, Effect, Schema } from 'effect';
import { useState } from 'react';
import { CreateMarketPayloadSchema } from '../../shared/actions/create-market.ts';
import { executeCreateMarket } from '../api/create-market-action-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { newUuid } from './browser-crypto.ts';
import { FormDialogFrame } from './dialog-frame.tsx';
import { DefinitionFields, PricingFields } from './market-fields.tsx';
import {
  configureMarketCommand,
  createMarketInput,
  defaultPricingForm,
  definitionIssues,
  emptyDefinitionForm,
  normalizeMarketCode,
  pricingIssues,
} from './market-form.ts';
import type { MarketDefinitionForm, MarketPricingForm } from './market-form.ts';
import { failureText, useMarketText } from './market-ui.tsx';
import { commandOutcome } from './assortment-save.ts';
import { marketActionEffect } from './page-data.ts';
import type { MarketCommandResult, WriteFailure, WriteOutcome } from './page-data.ts';

const isProposal = Schema.is(ActionProposalAcceptedSchema);

type CreateResult = Effect.Success<ReturnType<typeof executeCreateMarket>>;

/** The price list of a newly created market: saved, parked for approval, or not saved. */
const MarketPricingSchema = Schema.Literals(['awaitingApproval', 'notSaved', 'saved']);
type MarketPricing = typeof MarketPricingSchema.Type;

const pricingOf = (configured: WriteOutcome<MarketCommandResult>): MarketPricing => {
  if (!configured.ok) {
    return 'notSaved';
  }
  return isProposal(configured.value) ? 'awaitingApproval' : 'saved';
};

export interface NewMarketDialogProps {
  /** Catalogue managers also set up the price list; everybody else creates the definition only. */
  readonly canConfigurePricing: boolean;
  readonly legalEntityId: string;
  readonly merchandiseRevision: number;
  readonly onClose: () => void;
  /** After the market exists: its code, its id, and whether its price list was saved, awaits approval or is missing. */
  readonly onCreated: (result: {
    readonly code: string;
    readonly marketId: string;
    readonly pricing: MarketPricing;
  }) => void;
  readonly tenantId: string;
}

/** The draft of the new-market form: the definition, the price list and whether the market launches at once. */
interface NewMarketDraft {
  readonly form: MarketDefinitionForm;
  readonly launchNow: boolean;
  readonly pricing: MarketPricingForm;
}

interface CreateRequest {
  readonly form: MarketDefinitionForm;
  readonly launchNow: boolean;
  readonly legalEntityId: string;
  readonly reason: string;
  readonly tenantId: string;
}

const createPayload = (request: CreateRequest) =>
  Effect.all({ marketId: newUuid, now: DateTime.now }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ marketId, now }) =>
      Schema.decodeUnknownEffect(CreateMarketPayloadSchema)(createMarketInput({ ...request, marketId, now })),
    ),
  );

export const NewMarketDialog = ({
  canConfigurePricing,
  legalEntityId,
  merchandiseRevision,
  onClose,
  onCreated,
  tenantId,
}: NewMarketDialogProps) => {
  const { text } = useMarketText();
  const [draft, setDraft] = useState<NewMarketDraft>(() => ({
    form: emptyDefinitionForm(),
    launchNow: true,
    pricing: defaultPricingForm(),
  }));
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  /**
   * The market is created by the first successful save; the price list follows in the same save. A save that stops
   * after the market exists reports the market as created, so a retry never creates a second one.
   */
  const afterCreate = (
    outcome: WriteOutcome<CreateResult>,
    value: NewMarketDraft,
    code: string,
  ): Effect.Effect<SaveOutcome> => {
    if (!outcome.ok) {
      return Effect.sync((): SaveOutcome => {
        setFailure(outcome.reason);
        return 'failed';
      });
    }
    const created = outcome.value;
    if (isProposal(created)) {
      return Effect.succeed('proposed');
    }
    const marketId = created.marketRef.resourceId;
    const finish = (pricing: MarketPricing): SaveOutcome => {
      onCreated({ code, marketId, pricing });
      return 'saved';
    };
    if (!canConfigurePricing) {
      return Effect.sync(() => finish('notSaved'));
    }
    // The market already exists; only its price list may wait for approval.
    return commandOutcome(
      configureMarketCommand({ expectedRevision: 0, form: value.pricing, marketCode: code, marketId }),
      merchandiseRevision,
    ).pipe(Effect.map((configured) => finish(pricingOf(configured))));
  };
  const record = useDraftSave<NewMarketDraft, never>({
    isValid: (value) =>
      definitionIssues(value.form).length === 0 && (!canConfigurePricing || pricingIssues(value.pricing).length === 0),
    runtime: browserRuntime,
    save: (value) => {
      const code = normalizeMarketCode(value.form.code);
      return marketActionEffect(
        createPayload({
          form: value.form,
          launchNow: value.launchNow,
          legalEntityId,
          reason: text('create.reason', { code }),
          tenantId,
        }),
        executeCreateMarket,
      ).pipe(Effect.flatMap((outcome) => afterCreate(outcome, value, code)));
    },
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setDraft(record.confirmed),
  });
  const handleSave = record.save;
  const issues = definitionIssues(draft.form);
  const priceIssues = canConfigurePricing ? pricingIssues(draft.pricing) : [];
  const showIssues = record.status === 'invalid';
  return (
    <FormDialogFrame
      description={text('create.description')}
      error={failure === null ? null : failureText(text, failure)}
      guard={guard}
      onClose={onClose}
      onSave={handleSave}
      status={record.status}
      title={text('create.title')}
    >
      <p className="text-sm">
        <span className="font-medium">{text('form.seller')}: </span>
        {text('form.sellerValue')}
      </p>
      <DefinitionFields
        codeEditable
        form={draft.form}
        issues={issues}
        onChange={(form) => setDraft((current) => ({ ...current, form }))}
        prefix="new-market"
        showIssues={showIssues}
      />
      <FormCheckbox
        checked={draft.launchNow}
        id="new-market-launch"
        label={text('form.launchNow')}
        onCheckedChange={(checked: boolean) => setDraft((current) => ({ ...current, launchNow: checked }))}
      />
      {canConfigurePricing && (
        <section className="flex flex-col gap-150">
          <h3 className="font-semibold text-sm">{text('form.pricingTitle')}</h3>
          <PricingFields
            form={draft.pricing}
            issues={priceIssues}
            onChange={(pricing) => setDraft((current) => ({ ...current, pricing }))}
            prefix="new-market"
            showIssues={showIssues}
          />
        </section>
      )}
    </FormDialogFrame>
  );
};
