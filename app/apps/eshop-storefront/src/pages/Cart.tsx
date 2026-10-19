import { useCart } from '../cart.tsx';
import type { CartItem } from '../cart.tsx';
import { AvailabilityBadge, EmptyState, ErrorState, Icon, Price, QuantityStepper } from '../components/ui.tsx';
import { Link, navigate, useDocumentTitle } from '../router.tsx';
import type { CartLineCheck } from '../shared/types.ts';
import { formatCzk, plural } from '../shared/text.ts';
import { useCartValidation } from '../useCartValidation.ts';

const BLOCKING: Record<string, string> = {
  INSUFFICIENT_STOCK: 'Nedostatek zboží',
  NOT_FOUND: 'Už není v nabídce',
  NO_PRICE: 'Cena není dostupná',
  OUT_OF_STOCK: 'Není skladem',
  UNKNOWN_AVAILABILITY: 'Dostupnost nelze ověřit',
};

const CartLine = ({ item, check }: { readonly item: CartItem; readonly check: CartLineCheck | undefined }) => {
  const cart = useCart();
  const status = check?.status;
  const unit = check?.currentPriceMinor ?? item.priceMinor;
  return (
    <li className={`cart-line${status !== undefined && status !== 'OK' && status !== 'PRICE_CHANGED' ? ' cart-line--blocked' : ''}`}>
      <Link className="cart-line__image" to={`/produkt/${item.slug}`}>
        <img alt="" height={160} src={check?.image ?? item.image} width={160} />
      </Link>
      <div className="cart-line__info">
        <Link className="cart-line__name" to={`/produkt/${item.slug}?varianta=${encodeURIComponent(item.variantId)}`}>
          {check?.name ?? item.name}
        </Link>
        {(check?.variantLabel ?? item.variantLabel) === null ? null : <span className="cart-line__variant">{check?.variantLabel ?? item.variantLabel}</span>}
        <div className="cart-line__meta">
          {check?.availability === null || check?.availability === undefined ? null : <AvailabilityBadge quantity={check.availableQuantity} value={check.availability} />}
          {check?.sku === null || check?.sku === undefined || check.sku === '' ? null : <span className="sku">Kód: {check.sku}</span>}
        </div>
        {status === 'PRICE_CHANGED' && check?.currentPriceMinor !== null && check?.currentPriceMinor !== undefined ? (
          <div className="notice notice--warning cart-line__notice" role="alert">
            <Icon name="warning" size={18} />
            <div>
              <strong>Cena se změnila</strong>
              <span>
                {item.priceMinor === null ? 'Nová cena: ' : (
                  <>
                    Původně <s>{formatCzk(item.priceMinor)}</s>, nyní{' '}
                  </>
                )}
                <b>{formatCzk(check.currentPriceMinor)}</b> za kus.
              </span>
            </div>
            <button className="button button--secondary button--sm" onClick={() => cart.acceptPrice(item.productId, item.variantId, check.currentPriceMinor as number)} type="button">
              Přijmout novou cenu
            </button>
          </div>
        ) : null}
        {status !== undefined && status in BLOCKING ? (
          <div className="notice notice--danger cart-line__notice" role="alert">
            <Icon name="warning" size={18} />
            <div>
              <strong>{BLOCKING[status]}</strong>
              <span>{check?.message}</span>
            </div>
            {status === 'INSUFFICIENT_STOCK' && check?.availableQuantity ? (
              <button className="button button--secondary button--sm" onClick={() => cart.setQuantity(item.productId, item.variantId, check.availableQuantity as number)} type="button">
                Upravit na {check.availableQuantity} ks
              </button>
            ) : (
              <button className="button button--secondary button--sm" onClick={() => cart.remove(item.productId, item.variantId)} type="button">
                Odebrat
              </button>
            )}
          </div>
        ) : null}
      </div>
      <div className="cart-line__qty">
        <QuantityStepper onChange={(value) => cart.setQuantity(item.productId, item.variantId, value)} size="sm" value={item.quantity} />
        <button className="text-link text-link--muted" onClick={() => cart.remove(item.productId, item.variantId)} type="button">
          <Icon name="trash" size={15} /> Odebrat
        </button>
      </div>
      <div className="cart-line__price">
        <Price minor={unit === null ? null : unit * item.quantity} />
        {unit === null || item.quantity === 1 ? null : <small>{formatCzk(unit)} / ks</small>}
      </div>
    </li>
  );
};

export const CartPage = () => {
  useDocumentTitle('Košík');
  const cart = useCart();
  const check = useCartValidation(cart.items);
  const changed = check.validation?.lines.filter((line) => line.status === 'PRICE_CHANGED' && line.currentPriceMinor !== null) ?? [];

  if (cart.items.length === 0) {
    return (
      <div className="container page-pad">
        <h1 className="page-title">Košík</h1>
        <EmptyState action={<Link className="button button--primary" to="/produkty">Vybrat kávu</Link>} title="Košík je prázdný">
          <p>Demonstrační košík – nejde o skutečný nákup. Vložte do něj cokoli z nabídky.</p>
        </EmptyState>
      </div>
    );
  }

  const lineOf = (item: CartItem) => check.validation?.lines.find((line) => line.productId === item.productId && line.variantId === item.variantId);
  const canContinue = check.current && check.validation?.canCheckout === true;

  return (
    <div className="container page-pad cart-page">
      <h1 className="page-title">
        Košík <small>{cart.count} {plural(cart.count, 'kus', 'kusy', 'kusů')}</small>
      </h1>
      <div className="notice notice--demo">
        <span className="demo-ribbon__pill">DEMO</span>
        <span>Demonstrační košík – nejde o skutečný nákup. Košík nic nerezervuje; ceny a dostupnost ověřujeme živě v OntOS.</span>
      </div>
      {changed.length > 1 ? (
        <div className="notice notice--warning" role="alert">
          <Icon name="warning" size={18} />
          <div>
            <strong>Změnily se ceny {changed.length} položek.</strong>
            <span>Před pokračováním je potřeba nové ceny výslovně potvrdit.</span>
          </div>
          <button className="button button--secondary button--sm" onClick={() => changed.forEach((line) => cart.acceptPrice(line.productId, line.variantId, line.currentPriceMinor as number))} type="button">
            Přijmout všechny nové ceny
          </button>
        </div>
      ) : null}
      <div className="cart-page__grid">
        <ul className="cart-lines">
          {cart.items.map((item) => (
            <CartLine check={lineOf(item)} item={item} key={`${item.productId}:${item.variantId}`} />
          ))}
        </ul>
        <aside className="summary">
          <h2>Souhrn</h2>
          {check.error !== undefined ? (
            <ErrorState error={check.error} onRetry={check.revalidate} title="Košík nelze ověřit" />
          ) : (
            <>
              <dl className="summary__rows">
                <div>
                  <dt>Zboží</dt>
                  <dd>{check.validation?.subtotalMinor === null || check.validation === undefined ? '–' : formatCzk(check.validation.subtotalMinor)}</dd>
                </div>
                <div>
                  <dt>Doprava</dt>
                  <dd className="muted">vyberete v dalším kroku</dd>
                </div>
              </dl>
              <div className="summary__total">
                <span>Celkem s DPH</span>
                <strong>{check.validation?.subtotalMinor === null || check.validation === undefined ? '–' : formatCzk(check.validation.subtotalMinor)}</strong>
              </div>
              <p className="summary__status" aria-live="polite">
                {check.checking ? (
                  <>
                    <span className="dot dot--pulse" /> Ověřuji ceny a dostupnost v OntOS…
                  </>
                ) : canContinue ? (
                  <>
                    <Icon name="check" size={16} /> Ceny a dostupnost ověřeny
                  </>
                ) : (
                  <>
                    <Icon name="warning" size={16} /> Před pokračováním vyřešte upozornění u položek.
                  </>
                )}
              </p>
            </>
          )}
          <button className="button button--primary button--lg button--block" disabled={!canContinue} onClick={() => navigate('/pokladna')} type="button">
            Pokračovat <Icon name="arrow" size={18} />
          </button>
          <Link className="button button--ghost button--block" to="/produkty">
            Pokračovat v nákupu
          </Link>
        </aside>
      </div>
    </div>
  );
};
