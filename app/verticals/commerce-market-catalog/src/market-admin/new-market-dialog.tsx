// "Nový trh": the market definition for the signed-in company, then its merchandise price list (DESIGN 4).
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
import type { WriteFailure } from './page-data.ts';

export interface NewMarketDialogProps {
  /** Catalogue managers also set up the price list; everybody else creates the definition only. */
  readonly canConfigurePricing: boolean;
  readonly legalEntityId: string;
  readonly merchandiseRevision: number;
  readonly onClose: () => void;
  /** After the market exists: its code, its id, and whether the price list was saved too. */
  readonly onCreated: (result: { readonly code: string; readonly marketId: string; readonly priced: boolean }) => void;
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
  const issues = definitionIssues(form);
  const priceIssues = canConfigurePricing ? pricingIssues(pricing) : [];
  const submit = () => {
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
        const marketId = outcome.value.marketRef.resourceId;
        const finish = (priced: boolean) => {
          setBusy(false);
          onCreated({ code, marketId, priced });
        };
        if (!canConfigurePricing) {
          finish(false);
          return;
        }
        runMerchandiseCommand(
          configureMarketCommand({ expectedRevision: 0, form: pricing, marketCode: code, marketId }),
          merchandiseRevision,
          (configured) => finish(configured.ok),
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
    </DialogFrame>
  );
};
