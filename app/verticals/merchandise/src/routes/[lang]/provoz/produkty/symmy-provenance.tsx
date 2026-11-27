import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';

/**
 * A product the ERP connector Symmy imported is an ordinary product of this list with one mark. The mark and the ERP
 * code are server-owned provenance on the product document; companies without Symmy products never see either.
 */
export const isSymmyImported = (product: Pick<ProductRecord, 'importedVia'>): boolean => product.importedVia === 'symmy';

/** The ERP code of an imported product when it differs from what the SKU already shows. */
export const erpCodeShown = (product: Pick<ProductRecord, 'erpCode' | 'importedVia' | 'sku'>): string | undefined =>
  isSymmyImported(product) && product.erpCode !== undefined && product.erpCode !== product.sku
    ? product.erpCode
    : undefined;

const key = 'merchandise.pages.products.symmy';

/** „Importováno přes Symmy“; nothing for a product that did not come through Symmy. */
export const SymmyImportedBadge = ({ product }: { readonly product: Pick<ProductRecord, 'importedVia'> }) => {
  const { t } = useModernI18n();
  return isSymmyImported(product) ? (
    <span className="shrink-0 whitespace-nowrap" data-imported-via="symmy">
      <Badge severity="info" size="sm" title={t(`${key}.badgeTitle`)}>
        {t(`${key}.badge`)}
      </Badge>
    </span>
  ) : null;
};

/** One line near price and stock: staff changes of an imported product are written to the ERP too. */
export const SymmyWriteThroughNote = ({ product }: { readonly product: Pick<ProductRecord, 'importedVia'> }) => {
  const { t } = useModernI18n();
  return isSymmyImported(product) ? <p className="text-fg-secondary text-sm">{t(`${key}.writeThrough`)}</p> : null;
};

/** The ERP code under the SKU, labelled; nothing when there is none to add. */
export const ErpCodeLine = ({ product }: { readonly product: Pick<ProductRecord, 'erpCode' | 'importedVia' | 'sku'> }) => {
  const { t } = useModernI18n();
  const code = erpCodeShown(product);
  return code === undefined ? null : (
    <span className="truncate text-fg-secondary text-xs" title={`${t(`${key}.erpCode`)}: ${code}`}>
      {t(`${key}.erpCode`)}: {code}
    </span>
  );
};
