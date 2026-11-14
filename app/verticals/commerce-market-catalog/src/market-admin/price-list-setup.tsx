// A market without a price list: "Nastavit ceník" creates it from the defaults (whole catalogue, catalogue prices),
// which makes the market's e-shops offer every product. It changes what a live e-shop sells, so it asks first.
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Schema } from 'effect';
import { useState } from 'react';
import { DialogFrame } from './dialog-frame.tsx';
import type { CurrentMarket } from './eshops-model.ts';
import { configureMarketCommand, defaultPricingForm } from './market-form.ts';
import { useMarketText } from './market-ui.tsx';
import { runMerchandiseCommand } from './page-data.ts';
import type { WriteFailure } from './page-data.ts';

const isProposal = Schema.is(ActionProposalAcceptedSchema);

export interface PriceListSetupProps {
  readonly editable: boolean;
  readonly market: CurrentMarket;
  /** The change was parked for approval: nothing changed yet. */
  readonly onAwaitingApproval: () => void;
  readonly onDone: (message: string) => void;
  /** The catalogue revision of the records the command is sent over. */
  readonly revision: number;
}

/** The notice of a market without a price list, with the confirmed command that creates it. */
export const PriceListSetup = ({ editable, market, onAwaitingApproval, onDone, revision }: PriceListSetupProps) => {
  const { text } = useMarketText();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const pricing = defaultPricingForm();
  const configure = () => {
    setBusy(true);
    setFailure(null);
    runMerchandiseCommand(
      configureMarketCommand({
        expectedRevision: 0,
        form: pricing,
        marketCode: market.marketCode,
        marketId: market.marketRef.resourceId,
      }),
      revision,
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          // The question stays open with the reason, so the user can try again or cancel.
          setFailure(outcome.reason);
          return;
        }
        setAsking(false);
        if (isProposal(outcome.value)) {
          onAwaitingApproval();
          return;
        }
        onDone(text('detail.assortment.saved', { code: market.marketCode }));
      },
    );
  };
  const handleAsk = () => {
    setFailure(null);
    setAsking(true);
  };
  const handleClose = () => {
    setAsking(false);
    setFailure(null);
  };
  return (
    <div className="flex flex-col gap-150">
      <div className="flex flex-wrap items-center justify-between gap-150">
        <p className="text-sm">{text('detail.assortment.notConfigured')}</p>
        {editable && (
          <Button data-testid="market-price-list-setup" onClick={handleAsk} size="sm" variant="secondary">
            {text('detail.assortment.configure')}
          </Button>
        )}
      </div>
      {asking && (
        <DialogFrame
          busy={busy}
          confirmLabel={text('detail.assortment.configureConfirm')}
          confirmVariant="primary"
          description={text('detail.assortment.configureDescription', {
            code: market.marketCode,
            currency: pricing.currency,
          })}
          failure={failure}
          onClose={handleClose}
          onConfirm={configure}
          title={text('detail.assortment.configureTitle', { code: market.marketCode })}
        />
      )}
    </div>
  );
};
