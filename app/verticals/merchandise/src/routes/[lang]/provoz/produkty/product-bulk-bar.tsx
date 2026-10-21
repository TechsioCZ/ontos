import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';

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

/** Shown only while rows are selected. Write actions are hidden for read-only roles. */
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
  const k = (path: string) => t(`merchandise.pages.products.${path}`);
  if (count === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-150 rounded-lg bg-overlay p-150">
      <span className="font-medium text-sm tabular-nums">
        {t('merchandise.pages.products.bulk.selected', { total: count })}
      </span>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-100">
          <Button disabled={busy} onClick={onChangePrice} size="sm" theme="outlined" variant="secondary">
            {k('bulk.changePrice')}
          </Button>
          <Button disabled={busy} onClick={onChangeCategory} size="sm" theme="outlined" variant="secondary">
            {k('bulk.changeCategory')}
          </Button>
          <Button disabled={busy} onClick={() => onSetActive(true)} size="sm" theme="outlined" variant="secondary">
            {k('bulk.activate')}
          </Button>
          <Button disabled={busy} onClick={() => onSetActive(false)} size="sm" theme="outlined" variant="secondary">
            {k('bulk.deactivate')}
          </Button>
          <Button disabled={busy} onClick={onTags} size="sm" theme="outlined" variant="secondary">
            {k('bulk.tags')}
          </Button>
        </div>
      )}
      <Button className="ms-auto" onClick={onClear} size="sm" theme="borderless" variant="secondary">
        {k('bulk.clear')}
      </Button>
    </div>
  );
};
