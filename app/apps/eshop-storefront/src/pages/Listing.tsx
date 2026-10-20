import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useApi } from '../api.ts';
import { EmptyState, ErrorState, Icon, ProductCard, SkeletonGrid } from '../components/ui.tsx';
import { Link, navigate, useDocumentTitle, useLocation, withParams } from '../router.tsx';
import type { CatalogResponse } from '../shared/types.ts';
import { formatCzk, plural } from '../shared/text.ts';

const SORTS = [
  { label: 'Název A–Z', value: 'nazev' },
  { label: 'Od nejlevnějšího', value: 'cena-vzestupne' },
  { label: 'Od nejdražšího', value: 'cena-sestupne' },
] as const;

const FILTER_KEYS = ['q', 'cena_od', 'cena_do', 'dostupnost', 'razeni'] as const;

export const ListingPage = ({ categorySlug }: { readonly categorySlug?: string }) => {
  const { search } = useLocation();
  const params = Object.fromEntries(FILTER_KEYS.map((key) => [key, search.get(key) ?? undefined])) as Record<(typeof FILTER_KEYS)[number], string | undefined>;
  const apiPath = withParams('/api/products', { ...params, kategorie: categorySlug });
  const catalog = useApi<CatalogResponse>(apiPath);
  const [drawer, setDrawer] = useState(false);
  const [priceFrom, setPriceFrom] = useState(params.cena_od ?? '');
  const [priceTo, setPriceTo] = useState(params.cena_do ?? '');
  useEffect(() => {
    setPriceFrom(params.cena_od ?? '');
    setPriceTo(params.cena_do ?? '');
  }, [params.cena_od, params.cena_do]);

  const category = catalog.data?.categories.find((item) => item.slug === categorySlug);
  const unknownCategory = catalog.data !== undefined && categorySlug !== undefined && category === undefined;
  useDocumentTitle(category?.name ?? (params.q === undefined ? 'Celá nabídka' : `Hledání „${params.q}“`));

  const basePath = categorySlug === undefined ? '/produkty' : `/kategorie/${categorySlug}`;
  const update = (patch: Partial<Record<(typeof FILTER_KEYS)[number], string | undefined>>, path = basePath) => {
    navigate(withParams(path, { ...params, ...patch }), { keepScroll: true });
  };
  const applyPrice = (event: FormEvent) => {
    event.preventDefault();
    update({ cena_do: priceTo.trim() || undefined, cena_od: priceFrom.trim() || undefined });
    setDrawer(false);
  };
  const activeFilters = [
    params.q === undefined ? null : { key: 'q', label: `„${params.q}“` },
    params.cena_od === undefined ? null : { key: 'cena_od', label: `od ${params.cena_od} Kč` },
    params.cena_do === undefined ? null : { key: 'cena_do', label: `do ${params.cena_do} Kč` },
    params.dostupnost === 'skladem' ? { key: 'dostupnost', label: 'jen skladem' } : null,
  ].filter((item): item is { key: (typeof FILTER_KEYS)[number]; label: string } => item !== null);
  const hasFilters = activeFilters.length > 0 || categorySlug !== undefined;
  const bounds = catalog.data?.priceBounds;

  return (
    <div className="container listing">
      <nav aria-label="Drobečková navigace" className="breadcrumbs">
        <Link to="/">Úvod</Link>
        <span aria-hidden="true">/</span>
        {category === undefined ? <span>Celá nabídka</span> : <Link to="/produkty">Celá nabídka</Link>}
        {category === undefined ? null : (
          <>
            <span aria-hidden="true">/</span>
            <span>{category.name}</span>
          </>
        )}
      </nav>
      <header className="listing__head">
        <div>
          <h1>{category?.name ?? (unknownCategory ? 'Neznámá kategorie' : 'Celá nabídka')}</h1>
          <p className="listing__count" aria-live="polite">
            {catalog.data === undefined
              ? catalog.error === undefined
                ? 'Načítám nabídku…'
                : 'Nabídku se nepodařilo načíst'
              : `${catalog.data.total} ${plural(catalog.data.total, 'produkt', 'produkty', 'produktů')}`}
            {catalog.loading && catalog.data !== undefined ? ' · aktualizuji…' : ''}
          </p>
        </div>
        <div className="listing__tools">
          <button className="button button--ghost listing__filter-toggle" onClick={() => setDrawer(true)} type="button">
            <Icon name="filter" size={18} /> Filtry{activeFilters.length > 0 ? ` (${activeFilters.length})` : ''}
          </button>
          <label className="select">
            <span>Řazení</span>
            <select onChange={(event) => update({ razeni: event.target.value === 'nazev' ? undefined : event.target.value })} value={params.razeni ?? 'nazev'}>
              {SORTS.map((sort) => (
                <option key={sort.value} value={sort.value}>
                  {sort.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="listing__layout">
        <aside className={`filters${drawer ? ' filters--open' : ''}`}>
          <div className="filters__panel">
            <div className="filters__head">
              <h2>Filtry</h2>
              <button aria-label="Zavřít filtry" className="icon-button" onClick={() => setDrawer(false)} type="button">
                <Icon name="close" />
              </button>
            </div>
            <form
              className="filters__group"
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get('q');
                update({ q: typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined });
                setDrawer(false);
              }}
            >
              <label className="filters__label" htmlFor="filter-q">
                Hledat
              </label>
              <div className="input-with-icon">
                <Icon name="search" size={18} />
                <input defaultValue={params.q ?? ''} id="filter-q" key={params.q ?? ''} name="q" placeholder="Název nebo kód" type="search" />
              </div>
            </form>
            <div className="filters__group">
              <span className="filters__label">Kategorie</span>
              <div className="filters__options">
                <Link className={`chip${categorySlug === undefined ? ' chip--active' : ''}`} to={withParams('/produkty', params)}>
                  Vše
                </Link>
                {(catalog.data?.categories ?? []).map((item) => (
                  <Link className={`chip${item.slug === categorySlug ? ' chip--active' : ''}`} key={item.slug} to={withParams(`/kategorie/${item.slug}`, params)}>
                    {item.name} <small>{item.productCount}</small>
                  </Link>
                ))}
              </div>
            </div>
            <form className="filters__group" onSubmit={applyPrice}>
              <span className="filters__label">Cena (Kč s DPH)</span>
              <div className="price-range">
                <input aria-label="Cena od" inputMode="numeric" onChange={(event) => setPriceFrom(event.target.value)} placeholder={bounds === null || bounds === undefined ? 'od' : `od ${Math.floor(bounds.minMinor / 100)}`} value={priceFrom} />
                <span aria-hidden="true">–</span>
                <input aria-label="Cena do" inputMode="numeric" onChange={(event) => setPriceTo(event.target.value)} placeholder={bounds === null || bounds === undefined ? 'do' : `do ${Math.ceil(bounds.maxMinor / 100)}`} value={priceTo} />
              </div>
              {bounds === null || bounds === undefined ? null : (
                <p className="filters__hint">
                  V nabídce od {formatCzk(bounds.minMinor)} do {formatCzk(bounds.maxMinor)}
                </p>
              )}
              <button className="button button--secondary button--sm" type="submit">
                Použít cenu
              </button>
            </form>
            <div className="filters__group">
              <span className="filters__label">Dostupnost</span>
              <label className="checkbox">
                <input checked={params.dostupnost === 'skladem'} onChange={(event) => update({ dostupnost: event.target.checked ? 'skladem' : undefined })} type="checkbox" />
                <span>Jen skladem</span>
              </label>
            </div>
            {hasFilters ? (
              <Link className="button button--ghost button--sm filters__clear" onClick={() => setDrawer(false)} to={params.razeni === undefined ? '/produkty' : `/produkty?razeni=${params.razeni}`}>
                <Icon name="close" size={16} /> Vymazat filtry
              </Link>
            ) : null}
          </div>
          <button aria-label="Zavřít filtry" className="filters__backdrop" onClick={() => setDrawer(false)} type="button" />
        </aside>

        <section className="listing__results" aria-label="Výsledky">
          {activeFilters.length > 0 ? (
            <div className="active-filters">
              {activeFilters.map((filter) => (
                <button className="chip chip--removable" key={filter.key} onClick={() => update({ [filter.key]: undefined })} type="button">
                  {filter.label} <Icon name="close" size={14} />
                </button>
              ))}
            </div>
          ) : null}
          {catalog.error !== undefined ? (
            <ErrorState error={catalog.error} onRetry={catalog.reload} title="Katalog se nepodařilo načíst" />
          ) : catalog.data === undefined ? (
            <SkeletonGrid count={9} />
          ) : unknownCategory ? (
            <EmptyState action={<Link className="button button--primary" to="/produkty">Zobrazit celou nabídku</Link>} title="Tato kategorie v e-shopu neexistuje">
              <p>Odkaz je možná zastaralý nebo kategorie zatím nemá žádné zveřejněné produkty.</p>
            </EmptyState>
          ) : catalog.data.products.length === 0 ? (
            <EmptyState
              action={
                <Link className="button button--primary" to={categorySlug === undefined ? '/produkty' : `/kategorie/${categorySlug}`}>
                  Vymazat filtry
                </Link>
              }
              title="Nenalezeny žádné produkty"
            >
              <p>Zkuste upravit hledaný výraz nebo rozšířit cenové rozpětí.</p>
            </EmptyState>
          ) : (
            <div className={`product-grid${catalog.loading ? ' is-refreshing' : ''}`}>
              {catalog.data.products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
