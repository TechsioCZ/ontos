// Small presentation pieces shared by the E-shop overview and the market detail.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import type { MarketLifecycle } from '../../shared/market-contracts.ts';
import type { MarketChip } from './eshops-model.ts';
import type { WriteFailure } from './page-data.ts';

export const NAMESPACE = 'commerce-market-catalog';

/** Keys of this vertical's locale namespace. */
export const useMarketText = () => {
  const { language, t } = useModernI18n();
  const text = (path: string, values?: Record<string, string | number>) =>
    values === undefined ? t(`${NAMESPACE}.${path}`) : t(`${NAMESPACE}.${path}`, values);
  return { language: language ?? 'cs', text };
};

const lifecycleVariant = {
  ACTIVE: 'success',
  RETIRED: 'outline',
  SUSPENDED: 'warning',
} as const satisfies Record<MarketLifecycle, 'outline' | 'success' | 'warning'>;

export const LifecycleBadge = ({ lifecycle }: { readonly lifecycle: MarketLifecycle }) => {
  const { text } = useMarketText();
  return (
    <Badge size="sm" variant={lifecycleVariant[lifecycle]}>
      {text(`market.lifecycle.${lifecycle}`)}
    </Badge>
  );
};

/** The visible details of a market chip: channel, language, currency (or the missing price list). */
export const chipDetails = (chip: MarketChip, noPriceList: string): string =>
  [chip.channel, chip.locale, chip.currency ?? noPriceList].filter((part) => part !== undefined).join(' · ');

export const MarketChipButton = ({ chip, onOpen }: { readonly chip: MarketChip; readonly onOpen: () => void }) => {
  const { text } = useMarketText();
  const details = chipDetails(chip, text('market.noPriceList'));
  return (
    <button
      aria-label={text('market.chipLabel', { code: chip.code, details })}
      className="flex items-center gap-100 rounded-full border border-border-primary/60 bg-base px-150 py-50 text-sm hover:bg-surface"
      onClick={onOpen}
      type="button"
    >
      <span className="font-semibold">{chip.code}</span>
      <span className="text-fg-secondary">{details}</span>
      <LifecycleBadge lifecycle={chip.lifecycle} />
    </button>
  );
};

export const failureText = (text: (path: string) => string, failure: WriteFailure): string =>
  text(`failures.${failure}`);

/** A failed load: what went wrong and the one way to try again. */
export const LoadFailure = ({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) => {
  const { text } = useMarketText();
  return (
    <div className="flex flex-col items-start gap-150">
      <StatusText showIcon status="error">
        {message}
      </StatusText>
      <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
        {text('eshops.retry')}
      </Button>
    </div>
  );
};
