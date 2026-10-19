import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api.ts';
import { useCart } from '../cart.tsx';
import { AvailabilityBadge, EmptyState, ErrorState, Icon, Price, ProductCard, QuantityStepper, Spinner } from '../components/ui.tsx';
import { Link, navigate, useDocumentTitle, useLocation, withParams } from '../router.tsx';
import type { StoreProduct, StoreProductSummary, StoreVariant } from '../shared/types.ts';
import { formatDateTime } from '../shared/text.ts';

interface ProductResponse {
  readonly product: StoreProduct;
  readonly related: readonly StoreProductSummary[];
  readonly fetchedAt: string;
}

const blockReason = (variant: StoreVariant): string | null => {
  if (variant.priceMinor === null) return 'Cena není dostupná, produkt teď nelze objednat.';
  if (variant.availability === 'OUT_OF_STOCK') return 'Varianta není skladem, nelze ji objednat.';
  if (variant.availability === 'UNKNOWN') return 'Dostupnost nyní nelze ověřit, proto produkt teď nelze objednat.';
  return null;
};

const purchasable = (variant: StoreVariant) => blockReason(variant) === null;

/** Option dimensions shared by every variant (e.g. Balení × Mletí); empty when variants are flat labels. */
const dimensionsOf = (variants: readonly StoreVariant[]): string[] => {
  if (variants.length < 2) return [];
  const keys = Object.keys(variants[0].options);
  if (keys.length < 2) return [];
  return variants.every((variant) => keys.every((key) => key in variant.options) && Object.keys(variant.options).length === keys.length) ? keys : [];
};

const Gallery = ({ images, name }: { readonly images: readonly string[]; readonly name: string }) => {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [images]);
  return (
    <div className="gallery">
      <div className="gallery__main">
        <img alt={`${name} – obrázek ${active + 1} z ${images.length}`} height={800} src={images[active]} width={800} />
      </div>
      {images.length > 1 ? (
        <div className="gallery__thumbs" role="tablist" aria-label="Obrázky produktu">
          {images.map((image, index) => (
            <button aria-label={`Obrázek ${index + 1}`} aria-selected={index === active} className={index === active ? 'is-active' : undefined} key={image} onClick={() => setActive(index)} role="tab" type="button">
              <img alt="" height={160} loading="lazy" src={image} width={160} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export const ProductPage = ({ slug }: { readonly slug: string }) => {
  const { search, path } = useLocation();
  const response = useApi<ProductResponse>(`/api/products/${encodeURIComponent(slug)}`);
  const cart = useCart();
  const [quantity, setQuantity] = useState(1);
  const product = response.data?.product;
  useDocumentTitle(product?.name ?? 'Produkt');

  const requested = search.get('varianta');
  const variant = useMemo(() => {
    if (product === undefined) return undefined;
    return product.variants.find((item) => item.id === requested) ?? product.variants.find(purchasable) ?? product.variants[0];
  }, [product, requested]);
  useEffect(() => setQuantity(1), [variant?.id]);

  if (response.error !== undefined) {
    if (response.error.status === 404) {
      return (
        <div className="container page-pad">
          <EmptyState action={<Link className="button button--primary" to="/produkty">Zpět do nabídky</Link>} title="Produkt nenalezen">
            <p>Tento produkt v nabídce e-shopu neexistuje nebo už není dostupný pro prodej.</p>
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="container page-pad">
        <ErrorState error={response.error} onRetry={response.reload} />
      </div>
    );
  }
  if (product === undefined || variant === undefined) {
    return (
      <div className="container page-pad">
        <Spinner label="Načítám produkt z OntOS…" />
      </div>
    );
  }

  const selectVariant = (next: StoreVariant) => navigate(withParams(path, { varianta: next.id }), { keepScroll: true, replace: true });
  const dimensions = dimensionsOf(product.variants);
  const reason = blockReason(variant);
  const hasVariants = product.variants.length > 1 || variant.id !== product.id;
  const maxQuantity = variant.availableQuantity !== null && variant.availableQuantity > 0 ? Math.min(999, variant.availableQuantity) : 999;

  return (
    <div className="container product-page">
      <nav aria-label="Drobečková navigace" className="breadcrumbs">
        <Link to="/">Úvod</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/kategorie/${product.category.slug}`}>{product.category.name}</Link>
        <span aria-hidden="true">/</span>
        <span>{product.name}</span>
      </nav>
      <div className="product-page__grid">
        <Gallery images={product.images} name={product.name} />
        <div className="product-info">
          <span className="eyebrow">{product.category.name}</span>
          <h1>{product.name}</h1>
          {product.shortDescription === null ? null : <p className="product-info__lead">{product.shortDescription}</p>}

          {hasVariants ? (
            dimensions.length > 0 ? (
              dimensions.map((dimension) => {
                const values = [...new Set(product.variants.map((item) => item.options[dimension]))];
                return (
                  <fieldset className="variant-picker" key={dimension}>
                    <legend>{dimension}</legend>
                    <div className="variant-picker__options">
                      {values.map((value) => {
                        const wanted = { ...variant.options, [dimension]: value };
                        const match = product.variants.find((item) => dimensions.every((key) => item.options[key] === wanted[key])) ?? product.variants.find((item) => item.options[dimension] === value);
                        const selected = variant.options[dimension] === value;
                        return (
                          <button aria-pressed={selected} className={`variant${selected ? ' is-selected' : ''}${match !== undefined && !purchasable(match) ? ' is-unavailable' : ''}`} key={value} onClick={() => match !== undefined && selectVariant(match)} type="button">
                            {value}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                );
              })
            ) : (
              <fieldset className="variant-picker">
                <legend>Varianta</legend>
                <div className="variant-picker__options">
                  {product.variants.map((item) => (
                    <button aria-pressed={item.id === variant.id} className={`variant${item.id === variant.id ? ' is-selected' : ''}${purchasable(item) ? '' : ' is-unavailable'}`} key={item.id} onClick={() => selectVariant(item)} type="button">
                      {item.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            )
          ) : null}

          <div className="buy-box">
            <div className="buy-box__price">
              <Price className="price--xl" minor={variant.priceMinor} />
              {variant.priceMinor === null ? null : <span className="buy-box__vat">včetně {product.vatRate} % DPH · za {hasVariants ? variant.label : product.unit}</span>}
            </div>
            <div className="buy-box__meta">
              <AvailabilityBadge quantity={variant.availableQuantity} value={variant.availability} />
              {variant.sku === '' ? null : <span className="sku">Kód: {variant.sku}</span>}
            </div>
            <div className="buy-box__actions">
              <QuantityStepper max={maxQuantity} onChange={setQuantity} value={quantity} />
              <button
                className="button button--primary button--lg buy-box__cta"
                disabled={reason !== null}
                onClick={() =>
                  cart.add({
                    image: product.image,
                    name: product.name,
                    priceMinor: variant.priceMinor,
                    productId: product.id,
                    quantity,
                    slug: product.slug,
                    variantId: variant.id,
                    variantLabel: hasVariants ? variant.label : null,
                  })
                }
                type="button"
              >
                <Icon name="bag" size={20} /> Do košíku
              </button>
            </div>
            {reason === null ? (
              <p className="buy-box__note">
                <Icon name="info" size={16} /> Demonstrační košík – nejde o skutečný nákup. Nic se nerezervuje ani neplatí.
              </p>
            ) : (
              <p className="buy-box__blocked" role="status">
                <Icon name="warning" size={16} /> {reason}
              </p>
            )}
            <p className="buy-box__source">
              Cena a dostupnost: živě z OntOS ({formatDateTime(response.data?.fetchedAt ?? new Date().toISOString())}).{' '}
              <button className="text-link" onClick={response.reload} type="button">
                Obnovit
              </button>
            </p>
          </div>

          <div className="product-info__perks">
            <span>
              <Icon name="truck" size={18} /> Doprava jen jako simulace
            </span>
            <span>
              <Icon name="shield" size={18} /> Nic neplatíte, nic nedoručíme
            </span>
          </div>
        </div>
      </div>

      <section className="product-details">
        <div className="product-details__description">
          <h2>Popis</h2>
          {product.description === null ? (
            <p className="muted">Popis produktu nebyl v katalogu vyplněn.</p>
          ) : (
            product.description.split(/\n{2,}/u).map((paragraph, index) => <p key={index}>{paragraph}</p>)
          )}
        </div>
        <aside className="product-details__facts">
          <h2>Parametry</h2>
          <dl>
            {hasVariants ? (
              <div>
                <dt>Zvolená varianta</dt>
                <dd>{variant.label}</dd>
              </div>
            ) : null}
            {product.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
            <div>
              <dt>Kategorie</dt>
              <dd>{product.category.name}</dd>
            </div>
          </dl>
        </aside>
      </section>

      {response.data !== undefined && response.data.related.length > 0 ? (
        <section className="section">
          <div className="section__head">
            <h2>Mohlo by vás zajímat</h2>
          </div>
          <div className="product-grid product-grid--four">
            {response.data.related.map((item) => (
              <ProductCard key={item.id} product={item} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
};
