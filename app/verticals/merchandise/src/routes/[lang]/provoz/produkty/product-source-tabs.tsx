import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useRouter } from '@modern-js/plugin-tanstack/runtime';
import { useEffect, useState } from 'react';

/** The ERP side of the one "Produkty" screen: the Catalog page of the ERP products (Symmy), opened by the Shell. */
const ERP_PRODUCTS_PATH = '/katalog/produkty';

/**
 * The Shell opens the ERP side for this person in this company: its own page model of that address resolved. A company
 * without the Catalog module, or a person without the ERP product page, gets another state and sees no switch.
 */
const resolvesPage = (matches: unknown): boolean =>
  Array.isArray(matches) &&
  matches.some((match: unknown) => {
    if (typeof match !== 'object' || match === null || !('loaderData' in match)) {
      return false;
    }
    const { loaderData } = match;
    return typeof loaderData === 'object' && loaderData !== null && 'state' in loaderData && loaderData.state === 'resolved';
  });

const tabClass = 'border-b-2 px-150 py-100 text-sm no-underline';
const currentClass = `${tabClass} border-primary font-semibold text-fg-primary`;
const otherClass = `${tabClass} border-transparent text-fg-secondary hover:text-fg-primary`;

/**
 * "Sortiment | Z ERP" at the top of the "Produkty" list: the company's own products here, the products its ERP
 * imported on the ERP side, one screen under one navigation entry. Shown only when the company has the ERP side.
 */
export const ProductSourceTabs = () => {
  const { language, t } = useModernI18n();
  const router = useRouter();
  const navigate = useNavigate();
  const [erp, setErp] = useState(false);
  const href = `/${language ?? 'cs'}${ERP_PRODUCTS_PATH}`;
  useEffect(() => {
    let live = true;
    router
      .preloadRoute({ to: href })
      .then((matches: unknown) => {
        if (live) {
          setErp(resolvesPage(matches));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [href, router]);
  if (!erp) {
    return null;
  }
  return (
    <nav aria-label={t('merchandise.pages.products.sources.label')} className="flex gap-100 border-border-primary border-b">
      <span aria-current="page" className={currentClass}>
        {t('merchandise.pages.products.sources.own')}
      </span>
      <a
        className={otherClass}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void navigate({ to: href });
        }}
      >
        {t('merchandise.pages.products.sources.erp')}
      </a>
    </nav>
  );
};
