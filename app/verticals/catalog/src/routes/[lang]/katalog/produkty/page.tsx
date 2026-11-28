import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useEffect } from 'react';

import { catalogI18nResources } from '../../../../i18n/resources';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
/** What the Shell passes the page; a standalone render of the remote passes nothing. */
type ProductsPageProps = Partial<Pick<ModulePageProps, 'context' | 'search'>>;

/** The one products screen: ERP (Symmy) products are ordinary rows of "Produkty" with the mark "Importováno přes Symmy". */
const productsPath = (language: string | undefined) => `/${language ?? 'cs'}/provoz/produkty`;

/** The former ERP products page: an old link or bookmark lands on "Produkty". */
const ProductsRedirect = () => {
  const { language, t } = useModernI18n();
  const target = productsPath(language);
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return (
    <p className="text-fg-secondary text-sm">
      <Link href={target}>{t('catalog.pages.products.moved')}</Link>
    </p>
  );
};

export const ProductsPage = (_props: ProductsPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="catalog"
    fallbackLanguage="en"
    resources={catalogI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <UltramodernRouteHead />
    <ProductsRedirect />
  </FederatedI18nBoundary>
);

export default ProductsPage;
