import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useState } from 'react';
import { LiveShopConfirm } from './live-shop-confirm.tsx';

export interface ProductBulkBarProps {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly count: number;
  readonly onChangeCategory: () => void;
  readonly onChangePrice: () => void;
  readonly onClear: () => void;
  readonly onSetActive: (active: boolean) => void;
  readonly onTags: () => void;
}

/**
 * Shown only while rows are selected. Write actions are hidden for read-only roles. Aktivovat and Deaktivovat put the
 * selected products on or take them off the public e-shop, so they ask first, naming how many products change.
 */
export const ProductBulkBar = ({
  busy,
  canWrite,
  count,
  onChangeCategory,
  onChangePrice,
  onClear,
  onSetActive,
  onTags,
}: ProductBulkBarProps) => {
  const { t } = useModernI18n();
  const k = (path: string, values?: Record<string, number>) => t(`merchandise.pages.products.${path}`, values);
  // The state the selected products would get, while the question about it is open.
  const [asking, setAsking] = useState<boolean | null>(null);
  if (count === 0) {
    return null;
  }
  const kind = asking === false ? 'deactivate' : 'activate';
  const handleConfirm = () => {
    if (asking !== null) {
      onSetActive(asking);
    }
    setAsking(null);
  };
  return (
    <div className="flex flex-wrap items-center gap-150 rounded-lg bg-overlay p-150">
      <span className="font-medium text-sm tabular-nums">
        {t('merchandise.pages.products.bulk.selected', { total: count })}
      </span>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-100">
          <Button appearance="outline" disabled={busy} onClick={onChangePrice} severity="secondary" size="sm">
            {k('bulk.changePrice')}
          </Button>
          <Button appearance="outline" disabled={busy} onClick={onChangeCategory} severity="secondary" size="sm">
            {k('bulk.changeCategory')}
          </Button>
          <Button appearance="outline" disabled={busy} onClick={() => setAsking(true)} severity="secondary" size="sm">
            {k('bulk.activate')}
          </Button>
          <Button appearance="outline" disabled={busy} onClick={() => setAsking(false)} severity="secondary" size="sm">
            {k('bulk.deactivate')}
          </Button>
          <Button appearance="outline" disabled={busy} onClick={onTags} severity="secondary" size="sm">
            {k('bulk.tags')}
          </Button>
        </div>
      )}
      <Button appearance="ghost" className="ms-auto" onClick={onClear} severity="secondary" size="sm">
        {k('bulk.clear')}
      </Button>
      <LiveShopConfirm
        confirmLabel={k(`bulk.${kind}Confirm`, { total: count })}
        description={k(`bulk.${kind}Description`, { total: count })}
        destructive={asking === false}
        onCancel={() => setAsking(null)}
        onConfirm={handleConfirm}
        open={asking !== null}
        title={k(`bulk.${kind}Title`, { total: count })}
      />
    </div>
  );
};
