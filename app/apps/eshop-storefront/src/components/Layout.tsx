import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useApi } from '../api.ts';
import { useCart } from '../cart.tsx';
import { Link, navigate, useLocation } from '../router.tsx';
import type { StoreCategory } from '../shared/types.ts';
import { DEMO_DISCLAIMER, DEMO_RIBBON } from '../shared/types.ts';
import { formatCzk } from '../shared/text.ts';
import { Icon } from './ui.tsx';

export const Logo = () => (
  <Link aria-label="Kavárna Doma – úvod" className="logo" to="/">
    <svg aria-hidden="true" height="38" viewBox="0 0 48 48" width="38">
      <circle cx="24" cy="24" r="23" fill="#2b1d16" />
      <path d="M13 22h20l-1.6 11.2A4 4 0 0 1 27.4 37h-8.8a4 4 0 0 1-4-3.8Z" fill="#f4e9dc" />
      <path d="M33 24.5c4.5 0 4.5 7 0 7" fill="none" stroke="#f4e9dc" strokeWidth="2.2" />
      <path d="M19 18c-1.6-2.4 1.6-3.6 0-6M24 18c-1.6-2.4 1.6-3.6 0-6M29 18c-1.6-2.4 1.6-3.6 0-6" fill="none" stroke="#e0a93b" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
    <span>
      Kavárna <em>Doma</em>
    </span>
  </Link>
);

const DemoRibbon = () => (
  <div className="demo-ribbon" role="note">
    <span className="demo-ribbon__pill">DEMO</span>
    <span className="demo-ribbon__text">{DEMO_RIBBON}</span>
  </div>
);

const SearchBox = ({ onDone }: { readonly onDone?: () => void }) => {
  const { path, search } = useLocation();
  const [value, setValue] = useState(path === '/produkty' || path.startsWith('/kategorie/') ? (search.get('q') ?? '') : '');
  useEffect(() => {
    if (path === '/produkty' || path.startsWith('/kategorie/')) setValue(search.get('q') ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, search.get('q')]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const params = new URLSearchParams(path === '/produkty' ? search : undefined);
    if (value.trim() === '') params.delete('q');
    else params.set('q', value.trim());
    const query = params.toString();
    navigate(query === '' ? '/produkty' : `/produkty?${query}`);
    onDone?.();
  };
  return (
    <form className="search" onSubmit={submit} role="search">
      <Icon name="search" size={18} />
      <input aria-label="Hledat v e-shopu" onChange={(event) => setValue(event.target.value)} placeholder="Hledat kávu, čaj, dripper…" type="search" value={value} />
    </form>
  );
};

const Header = () => {
  const { count } = useCart();
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  const categories = useApi<{ categories: StoreCategory[] }>('/api/categories');
  useEffect(() => setOpen(false), [path]);
  return (
    <header className="site-header">
      <div className="site-header__inner container">
        <button aria-expanded={open} aria-label="Menu" className="icon-button site-header__menu" onClick={() => setOpen(!open)} type="button">
          <Icon name={open ? 'close' : 'menu'} />
        </button>
        <Logo />
        <nav aria-label="Kategorie" className={`site-nav${open ? ' site-nav--open' : ''}`}>
          <Link className={path === '/produkty' ? 'is-active' : undefined} to="/produkty">
            Celá nabídka
          </Link>
          {(categories.data?.categories ?? []).map((category) => (
            <Link className={path === `/kategorie/${category.slug}` ? 'is-active' : undefined} key={category.slug} to={`/kategorie/${category.slug}`}>
              {category.name}
            </Link>
          ))}
          <div className="site-nav__search">
            <SearchBox onDone={() => setOpen(false)} />
          </div>
        </nav>
        <div className="site-header__search">
          <SearchBox />
        </div>
        <Link aria-label={`Košík, ${count} ks`} className="cart-button" to="/kosik">
          <Icon name="bag" size={22} />
          <span className="cart-button__label">Košík</span>
          {count > 0 ? <span className="cart-button__badge">{count}</span> : null}
        </Link>
      </div>
    </header>
  );
};

const AddedToast = () => {
  const { lastAdded, dismissAdded } = useCart();
  useEffect(() => {
    if (lastAdded === null) return;
    const timer = window.setTimeout(dismissAdded, 6000);
    return () => window.clearTimeout(timer);
  }, [lastAdded, dismissAdded]);
  if (lastAdded === null) return null;
  return (
    <div aria-live="polite" className="toast" role="status">
      <img alt="" src={lastAdded.image} />
      <div>
        <strong>
          <Icon name="check" size={16} /> Přidáno do košíku
        </strong>
        <span>
          {lastAdded.quantity}× {lastAdded.name}
          {lastAdded.variantLabel === null ? '' : ` · ${lastAdded.variantLabel}`}
          {lastAdded.priceMinor === null ? '' : ` · ${formatCzk(lastAdded.priceMinor)}/ks`}
        </span>
        <div className="toast__actions">
          <button className="button button--ghost button--sm" onClick={dismissAdded} type="button">
            Pokračovat v nákupu
          </button>
          <Link className="button button--primary button--sm" onClick={dismissAdded} to="/kosik">
            Do košíku
          </Link>
        </div>
      </div>
      <button aria-label="Zavřít" className="icon-button toast__close" onClick={dismissAdded} type="button">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
};

const Footer = () => (
  <footer className="site-footer">
    <div className="container site-footer__grid">
      <div>
        <Logo />
        <p className="site-footer__claim">Výběrová káva, čaje a pomůcky na přípravu. Pražíme v malých várkách – v tomto demu jen naoko.</p>
      </div>
      <div>
        <h4>Nakupování</h4>
        <Link to="/produkty">Celá nabídka</Link>
        <Link to="/kosik">Košík</Link>
        <span>Doprava: jen simulace</span>
        <span>Platba: nic neplatíte</span>
      </div>
      <div>
        <h4>Kavárna Doma s.r.o.</h4>
        <span>Fiktivní demonstrační společnost</span>
        <span>Údolní 12, 602 00 Brno (smyšlená adresa)</span>
        <span>ahoj@kavarna-doma.example</span>
      </div>
      <div className="site-footer__demo">
        <h4>Prezentační demo</h4>
        <p>{DEMO_DISCLAIMER}</p>
        <p>Katalog, ceny a dostupnost se načítají živě z platformy OntOS. Objednávky se ukládají jen do izolované DEMO evidence.</p>
      </div>
    </div>
    <div className="container site-footer__bottom">
      <span>© 2026 Kavárna Doma · DEMO bez právních účinků</span>
      <span>Běží na OntOS</span>
    </div>
  </footer>
);

export const Layout = ({ children }: { readonly children: ReactNode }) => (
  <>
    <a className="skip-link" href="#main">
      Přeskočit na obsah
    </a>
    <DemoRibbon />
    <Header />
    <main id="main">{children}</main>
    <Footer />
    <AddedToast />
  </>
);
