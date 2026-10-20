import { useApi } from '../api.ts';
import { ErrorState, Icon, ProductCard, SkeletonGrid } from '../components/ui.tsx';
import { Link, useDocumentTitle } from '../router.tsx';
import type { HomeResponse } from '../shared/types.ts';
import { plural } from '../shared/text.ts';

const CATEGORY_COPY: Record<string, string> = {
  'kategorie-caj': 'Zelené, černé i bylinné čaje z malých zahrad.',
  'kategorie-darky': 'Sady a kazety pro radost – i pro sebe.',
  'kategorie-mleta': 'Namleto přesně pro váš překapávač, moka konvičku i džezvu.',
  'kategorie-kava': 'Výběrová zrna pražená v Brně pro filtr i espresso.',
  'kategorie-vybaveni': 'Drippery, konvice a mlýnky pro domácí baristy.',
};

export const HomePage = () => {
  useDocumentTitle('Výběrová káva a čaj');
  const home = useApi<HomeResponse>('/api/home');
  return (
    <>
      <section className="hero">
        <div className="container hero__inner">
          <div className="hero__copy">
            <span className="eyebrow">
              <Icon name="leaf" size={16} /> Čerstvě praženo v Brně
            </span>
            <h1>
              Dobrá káva začíná <em>doma.</em>
            </h1>
            <p>
              Vybíráme zrna od farmářů, které známe jménem, pražíme v malých várkách a k tomu přidáme všechno, co potřebujete na
              přípravu. Ceny i dostupnost tu vidíte živě ze systému OntOS.
            </p>
            <div className="hero__actions">
              <Link className="button button--primary button--lg" to="/produkty">
                Prohlédnout nabídku <Icon name="arrow" size={18} />
              </Link>
              {home.data?.categories[0] === undefined ? null : (
                <Link className="button button--ghost-light button--lg" to={`/kategorie/${home.data.categories[0].slug}`}>
                  {home.data.categories[0].name}
                </Link>
              )}
            </div>
            <ul className="hero__facts">
              <li>
                <strong>{home.data?.productCount ?? '–'}</strong> {plural(home.data?.productCount ?? 0, 'produkt', 'produkty', 'produktů')} v nabídce
              </li>
              <li>
                <strong>{home.data?.categories.length ?? '–'}</strong>{' '}
                {plural(home.data?.categories.length ?? 0, 'kategorie', 'kategorie', 'kategorií')} sortimentu
              </li>
              <li>
                <strong>0 Kč</strong> nic neplatíte (DEMO)
              </li>
            </ul>
          </div>
          <div className="hero__art">
            <img alt="Balíček výběrové kávy a šálek" height={800} src="/img/hero.svg" width={800} />
          </div>
        </div>
      </section>

      <section className="section container">
        <div className="section__head">
          <div>
            <span className="eyebrow">Kategorie</span>
            <h2>Co si dnes uvaříte?</h2>
          </div>
          <Link className="text-link" to="/produkty">
            Celá nabídka <Icon name="arrow" size={16} />
          </Link>
        </div>
        {home.error !== undefined ? (
          <ErrorState error={home.error} onRetry={home.reload} />
        ) : (
          <div className="category-grid">
            {(home.data?.categories ?? [undefined, undefined, undefined]).map((category, index) =>
              category === undefined ? (
                <div className="category-card category-card--skeleton skeleton" key={index} />
              ) : (
                <Link className="category-card" key={category.slug} to={`/kategorie/${category.slug}`}>
                  <img alt="" height={800} loading="lazy" src={`/img/${category.art}.svg`} width={800} />
                  <div className="category-card__body">
                    <h3>{category.name}</h3>
                    <p>{CATEGORY_COPY[category.art] ?? 'Vybrané produkty Kavárny Doma.'}</p>
                    <span>
                      {category.productCount} {plural(category.productCount, 'produkt', 'produkty', 'produktů')} <Icon name="arrow" size={16} />
                    </span>
                  </div>
                </Link>
              ),
            )}
          </div>
        )}
      </section>

      <section className="section section--tinted">
        <div className="container">
          <div className="section__head">
            <div>
              <span className="eyebrow">Nejprodávanější</span>
              <h2>Oblíbené u našich zákazníků</h2>
            </div>
            <Link className="text-link" to="/produkty?razeni=nazev">
              Všechny produkty <Icon name="arrow" size={16} />
            </Link>
          </div>
          {home.error !== undefined ? null : home.data === undefined ? (
            <SkeletonGrid count={8} />
          ) : (
            <div className="product-grid">
              {home.data.bestsellers.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section container story">
        <div className="story__card">
          <Icon name="leaf" size={26} />
          <h3>Od farmy po šálek</h3>
          <p>Ke každé kávě uvádíme původ, zpracování a chuťový profil. Sezónní šarže střídáme podle sklizní.</p>
        </div>
        <div className="story__card">
          <Icon name="truck" size={26} />
          <h3>Doprava jen jako simulace</h3>
          <p>V demu si vyberete dopravce, ale nic se neodesílá. Objednávka se pouze uloží do administrace.</p>
        </div>
        <div className="story__card">
          <Icon name="shield" size={26} />
          <h3>Žádná platba, žádná data navíc</h3>
          <p>Používejte fiktivní údaje. E-shop nepřijímá platby ani čísla karet a nikomu nic neposílá.</p>
        </div>
      </section>

      {home.data !== undefined && home.data.newest.length > 0 ? (
        <section className="section container">
          <div className="section__head">
            <div>
              <span className="eyebrow">Novinky</span>
              <h2>Čerstvě v nabídce</h2>
            </div>
          </div>
          <div className="product-grid product-grid--four">
            {home.data.newest.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
};
