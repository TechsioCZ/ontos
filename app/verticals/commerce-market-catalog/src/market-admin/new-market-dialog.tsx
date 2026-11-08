// "Nový trh": the market definition for the signed-in company, then its merchandise price list (DESIGN 4).
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { DateTime, Effect, Schema } from 'effect';
import { useState } from 'react';
import { CreateMarketPayloadSchema } from '../../shared/actions/create-market.ts';
import { executeCreateMarket } from '../api/create-market-action-client.ts';
import { newUuid } from './browser-crypto.ts';
import { DialogFrame } from './dialog-frame.tsx';
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
import { useMarketText } from './market-ui.tsx';
import { runMarketAction, runMerchandiseCommand } from './page-data.ts';
import type { MarketCommandResult, WriteFailure, WriteOutcome } from './page-data.ts';

const isProposal = Schema.is(ActionProposalAcceptedSchema);

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
  const [form, setForm] = useState<MarketDefinitionForm>(() => emptyDefinitionForm());
  const [pricing, setPricing] = useState<MarketPricingForm>(() => defaultPricingForm());
  const [launchNow, setLaunchNow] = useState(true);
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  /** The creation was parked for approval: no market exists yet, and sending it again would propose it twice. */
  const [parked, setParked] = useState(false);
  const issues = definitionIssues(form);
  const priceIssues = canConfigurePricing ? pricingIssues(pricing) : [];
  const submit = () => {
    if (parked) {
      return;
    }
    if (issues.length > 0 || priceIssues.length > 0) {
      setShowIssues(true);
      return;
    }
    const code = normalizeMarketCode(form.code);
    setBusy(true);
    setFailure(null);
    runMarketAction(
      createPayload({ form, launchNow, legalEntityId, reason: text('create.reason', { code }), tenantId }),
      executeCreateMarket,
      (outcome) => {
        if (!outcome.ok) {
          setBusy(false);
          setFailure(outcome.reason);
          return;
        }
        const created = outcome.value;
        if (isProposal(created)) {
          setBusy(false);
          setParked(true);
          return;
        }
        const marketId = created.marketRef.resourceId;
        const finish = (pricingResult: MarketPricing) => {
          setBusy(false);
          onCreated({ code, marketId, pricing: pricingResult });
        };
        if (!canConfigurePricing) {
          finish('notSaved');
          return;
        }
        // The market already exists; only its price list may wait for approval.
        runMerchandiseCommand(
          configureMarketCommand({ expectedRevision: 0, form: pricing, marketCode: code, marketId }),
          merchandiseRevision,
          (configured) => finish(pricingOf(configured)),
        );
      },
    );
  };
  return (
    <DialogFrame
      busy={busy}
      confirmLabel={text('create.submit')}
      confirmVariant="primary"
      description={text('create.description')}
      failure={failure}
      onClose={onClose}
      onConfirm={submit}
      title={text('create.title')}
    >
      <p className="text-sm">
        <span className="font-medium">{text('form.seller')}: </span>
        {text('form.sellerValue')}
      </p>
      <DefinitionFields
        codeEditable
        form={form}
        issues={issues}
        onChange={setForm}
        prefix="new-market"
        showIssues={showIssues}
      />
      <FormCheckbox
        checked={launchNow}
        id="new-market-launch"
        label={text('form.launchNow')}
        onCheckedChange={(checked: boolean) => setLaunchNow(checked)}
      />
      {canConfigurePricing && (
        <section className="flex flex-col gap-150">
          <h3 className="font-semibold text-sm">{text('form.pricingTitle')}</h3>
          <PricingFields
            form={pricing}
            issues={priceIssues}
            onChange={setPricing}
            prefix="new-market"
            showIssues={showIssues}
          />
        </section>
      )}
      {parked && (
        <StatusText showIcon status="warning">
          {text('approvalRequired')}
        </StatusText>
      )}
    </DialogFrame>
  );
};
