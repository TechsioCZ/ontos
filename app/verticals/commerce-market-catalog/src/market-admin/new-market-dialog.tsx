// "Nový trh": the market definition for the signed-in company, then its merchandise price list (DESIGN 4).
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { CheckboxField, FormReact, FormRoot, useAtomSet } from '@app/core-runtime/ui/form';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { DateTime, Effect, Schema } from 'effect';
import { useState } from 'react';
import { CreateMarketPayloadSchema } from '../../shared/actions/create-market.ts';
import { executeCreateMarket } from '../api/create-market-action-client.ts';
import { browserAtomRuntime, browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { newUuid } from './browser-crypto.ts';
import { FormDialogFrame } from './dialog-frame.tsx';
import {
  DefinitionFields,
  LiveChecks,
  PricingFields,
  definitionControls,
  definitionFields,
  pricingControls,
  pricingFields,
  useOpenedValues,
} from './market-fields.tsx';
import {
  MarketPricingFormSchema,
  configureMarketCommand,
  createMarketInput,
  defaultPricingForm,
  emptyDefinitionForm,
  normalizeMarketCode,
} from './market-form.ts';
import type { MarketDefinitionForm } from './market-form.ts';
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

/**
 * The new-market form: the definition, the price list and whether the market launches at once. Typing changes only the
 * form; the dialog's Uložit sends it through the save bar, so the form itself is never submitted.
 */
const newMarketForm = FormReact.make(definitionFields.merge(pricingFields).addField('launchNow', Schema.Boolean), {
  fields: { ...definitionControls, ...pricingControls, launchNow: CheckboxField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

type NewMarketValues = typeof newMarketForm.schema.Encoded;

const isComplete = Schema.is(newMarketForm.schema);

/** A new market starts empty, with the default price list, and launches at once. */
const opened: NewMarketValues = { ...emptyDefinitionForm(), ...defaultPricingForm(), launchNow: true };

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
  const { ready, values } = useOpenedValues(newMarketForm.values, opened);
  const setValues = useAtomSet(newMarketForm.setValues);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  /**
   * The market is created by the first successful save; the price list follows in the same save. A save that stops
   * after the market exists reports the market as created, so a retry never creates a second one.
   */
  const afterCreate = (
    outcome: WriteOutcome<CreateResult>,
    value: NewMarketValues,
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
    // The market already exists; only its price list may wait for approval. The choices offer only valid values.
    return Schema.decodeUnknownEffect(MarketPricingFormSchema)(value).pipe(
      Effect.orDie,
      Effect.flatMap((pricing) =>
        commandOutcome(
          configureMarketCommand({ expectedRevision: 0, form: pricing, marketCode: code, marketId }),
          merchandiseRevision,
        ),
      ),
      Effect.map((configured) => finish(pricingOf(configured))),
    );
  };
  // The price-list fields hold valid defaults until someone who may configure the price list changes them.
  const record = useDraftSave<NewMarketValues, never>({
    isValid: isComplete,
    runtime: browserRuntime,
    save: (value) => {
      const code = normalizeMarketCode(value.code);
      return marketActionEffect(
        createPayload({
          form: value,
          launchNow: value.launchNow,
          legalEntityId,
          reason: text('create.reason', { code }),
          tenantId,
        }),
        executeCreateMarket,
      ).pipe(Effect.flatMap((outcome) => afterCreate(outcome, value, code)));
    },
    value: values,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setValues(record.confirmed),
  });
  const handleSave = record.save;
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
      <FormRoot
        className="flex flex-col gap-200"
        defaultValues={opened}
        form={newMarketForm}
        translateMessage={(message) => text(message)}
      >
        {ready}
        {/* Validation messages appear once the draft is invalid. */}
        <LiveChecks checking={record.status === 'invalid'} form={newMarketForm} />
        <p className="text-sm">
          <span className="font-medium">{text('form.seller')}: </span>
          {text('form.sellerValue')}
        </p>
        <DefinitionFields codeEditable form={newMarketForm} prefix="new-market" />
        <newMarketForm.launchNow id="new-market-launch" label={text('form.launchNow')} />
        {canConfigurePricing && (
          <section className="flex flex-col gap-150">
            <h3 className="font-semibold text-sm">{text('form.pricingTitle')}</h3>
            <PricingFields form={newMarketForm} prefix="new-market" />
          </section>
        )}
      </FormRoot>
    </FormDialogFrame>
  );
};
