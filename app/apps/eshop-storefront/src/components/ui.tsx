import type { ReactNode } from 'react';
import { Link } from '../router.tsx';
import type { ApiError } from '../api.ts';
import type { Availability, StoreProductSummary } from '../shared/types.ts';
import { formatCzk, plural } from '../shared/text.ts';

// ------------------------------------------------------------------ icons

const paths = {
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  bag: 'M6 7h12l-1 13H7L6 7Zm3 0a3 3 0 0 1 6 0',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  filter: 'M4 6h16M7 12h10M10 18h4',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  leaf: 'M5 19c0-8 6-14 15-14 0 9-6 15-14 15M5 19l7-7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  minus: 'M6 12h12',
  plus: 'M12 6v12M6 12h12',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.2-4.2',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z',
  trash: 'M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3',
  truck: 'M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  warning: 'M12 4l9 16H3L12 4Zm0 6v4m0 3h.01',
} as const;

export type IconName = keyof typeof paths;

export const Icon = ({ name, size = 20, className }: { readonly name: IconName; readonly size?: number; readonly className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} viewBox="0 0 24 24" width={size}>
    <path d={paths[name]} />
  </svg>
);

// ------------------------------------------------------------------ price & availability

export const Price = ({ minor, from = false, className }: { readonly minor: number | null; readonly from?: boolean; readonly className?: string }) =>
  minor === null ? (
    <span className={`price price--missing ${className ?? ''}`}>Cena není dostupná</span>
  ) : (
    <span className={`price ${className ?? ''}`}>
      {from ? <small>od </small> : null}
      {formatCzk(minor)}
    </span>
  );

const AVAILABILITY: Record<Availability, { label: string; tone: string }> = {
  IN_STOCK: { label: 'Skladem', tone: 'ok' },
  LOW_STOCK: { label: 'Poslední kusy', tone: 'low' },
  OUT_OF_STOCK: { label: 'Není skladem', tone: 'out' },
  UNKNOWN: { label: 'Dostupnost nelze ověřit', tone: 'unknown' },
};

export const AvailabilityBadge = ({ value, quantity }: { readonly value: Availability; readonly quantity?: number | null }) => (
  <span className={`availability availability--${AVAILABILITY[value].tone}`}>
    <i aria-hidden="true" />
    {AVAILABILITY[value].label}
    {value === 'LOW_STOCK' && quantity !== undefined && quantity !== null ? ` (${quantity} ks)` : ''}
  </span>
);

export const availabilityLabel = (value: Availability): string => AVAILABILITY[value].label;

// ------------------------------------------------------------------ states

export const Spinner = ({ label = 'Načítám…' }: { readonly label?: string }) => (
  <div className="spinner" role="status">
    <span aria-hidden="true" />
    {label}
  </div>
);

export const SkeletonGrid = ({ count = 8 }: { readonly count?: number }) => (
  <div aria-busy="true" aria-label="Načítám produkty" className="product-grid">
    {Array.from({ length: count }, (_, index) => (
      <div className="product-card product-card--skeleton" key={index}>
        <div className="skeleton skeleton--image" />
        <div className="skeleton skeleton--line" />
        <div className="skeleton skeleton--line skeleton--short" />
      </div>
    ))}
  </div>
);

export const ErrorState = ({ error, onRetry, title }: { readonly error: ApiError | undefined; readonly onRetry?: () => void; readonly title?: string }) => {
  const forbidden = error?.status === 403;
  return (
    <div className={`state state--error${forbidden ? ' state--forbidden' : ''}`} role="alert">
      <div className="state__icon">
        <Icon name={forbidden ? 'shield' : 'warning'} size={28} />
      </div>
      <h2>{title ?? (forbidden ? 'Nepovoleno' : 'Data se nepodařilo načíst')}</h2>
      <p>{error?.problem.message ?? 'Neznámá chyba.'}</p>
      <p className="state__hint">Nezobrazujeme žádná náhradní ani smyšlená data. {error?.problem.code === undefined ? '' : `Kód: ${error.problem.code}`}</p>
      {onRetry === undefined ? null : (
        <button className="button button--primary" onClick={onRetry} type="button">
          <Icon name="refresh" size={18} /> Zkusit znovu
        </button>
      )}
    </div>
  );
};

export const EmptyState = ({ title, children, action }: { readonly title: string; readonly children?: ReactNode; readonly action?: ReactNode }) => (
  <div className="state state--empty">
    <div className="state__art" aria-hidden="true">
      <svg viewBox="0 0 120 90" width="120">
        <ellipse cx="60" cy="80" rx="44" ry="6" fill="#2b1d16" opacity="0.08" />
        <path d="M30 34h56l-5 40a6 6 0 0 1-6 5H41a6 6 0 0 1-6-5Z" fill="#f4e9dc" stroke="#c07a3a" strokeWidth="2.5" />
        <path d="M86 42c12 0 12 20 0 20" fill="none" stroke="#c07a3a" strokeWidth="2.5" />
        <path d="M48 24c-4-6 4-10 0-16M60 24c-4-6 4-10 0-16M72 24c-4-6 4-10 0-16" fill="none" stroke="#c9b49c" strokeLinecap="round" strokeWidth="2.5" />
      </svg>
    </div>
    <h2>{title}</h2>
    {children === undefined ? null : <div className="state__body">{children}</div>}
    {action}
  </div>
);

// ------------------------------------------------------------------ inputs

export const QuantityStepper = ({ value, onChange, max = 999, label = 'Množství', size = 'md' }: { readonly value: number; readonly onChange: (value: number) => void; readonly max?: number; readonly label?: string; readonly size?: 'sm' | 'md' }) => (
  <div aria-label={label} className={`stepper stepper--${size}`} role="group">
    <button aria-label="Ubrat kus" disabled={value <= 1} onClick={() => onChange(value - 1)} type="button">
      <Icon name="minus" size={16} />
    </button>
    <input
      aria-label={label}
      inputMode="numeric"
      max={max}
      min={1}
      onChange={(event) => {
        const next = Number(event.target.value.replace(/\D/gu, ''));
        if (Number.isFinite(next) && next >= 1) onChange(Math.min(max, next));
      }}
      type="text"
      value={value}
    />
    <button aria-label="Přidat kus" disabled={value >= max} onClick={() => onChange(value + 1)} type="button">
      <Icon name="plus" size={16} />
    </button>
  </div>
);

// ------------------------------------------------------------------ product card

export const ProductCard = ({ product }: { readonly product: StoreProductSummary }) => (
  <article className="product-card">
    <Link aria-label={product.name} className="product-card__media" to={`/produkt/${product.slug}`}>
      <img alt="" decoding="async" height={800} loading="lazy" src={product.image} width={800} />
      {product.availability === 'OUT_OF_STOCK' ? <span className="product-card__flag product-card__flag--out">Vyprodáno</span> : null}
      {product.variantCount > 1 ? <span className="product-card__flag">{product.variantCount} {plural(product.variantCount, 'varianta', 'varianty', 'variant')}</span> : null}
    </Link>
    <div className="product-card__body">
      <span className="product-card__category">{product.category.name}</span>
      <h3>
        <Link to={`/produkt/${product.slug}`}>{product.name}</Link>
      </h3>
      {product.shortDescription === null ? null : <p>{product.shortDescription}</p>}
      <div className="product-card__footer">
        <Price from={product.priceVaries} minor={product.priceFromMinor} />
        <AvailabilityBadge value={product.availability} />
      </div>
    </div>
  </article>
);
