// AKROS brand (default, `STOREFRONT_BRAND=akros` or unset): Kai Uwe's original content (Czech, unchanged), with
// Slovak and English versions of the editorial pages.
import "server-only";
import type { ReactNode } from "react";
import { ContentGallery } from "@/components/content-gallery";
import StoreLink from "@/components/store-link";
import { blogArticles } from "@/content/editorial";
import { akrosCopy } from "./akros-copy";
import type { Brand, GalleryImage, PerLocale } from "./types";

const aboutGalleryCs: readonly GalleryImage[] = [
  {
    src: "/akros/content/about-certificate.png",
    alt: "Certifikát systému jakosti ISO 9001:2016",
    caption: "Certifikát systému jakosti ISO 9001:2016",
  },
  {
    src: "/akros/content/about-branch.png",
    alt: "Žlutá budova pobočky AKROS",
    caption: "Pobočka AKROS",
  },
  {
    src: "/storefront/content/about-fastener-warehouse.png",
    alt: "Sklad nerezového spojovacího materiálu",
    caption: "Sklad spojovacího materiálu",
  },
  {
    src: "/storefront/content/about-steel-warehouse.png",
    alt: "Nerezový hutní materiál ve skladu",
    caption: "Nerezový materiál ve skladu",
  },
];

const aboutGallerySk: readonly GalleryImage[] = [
  {
    src: "/akros/content/about-certificate.png",
    alt: "Certifikát systému kvality ISO 9001:2016",
    caption: "Certifikát systému kvality ISO 9001:2016",
  },
  {
    src: "/akros/content/about-branch.png",
    alt: "Žltá budova pobočky AKROS",
    caption: "Pobočka AKROS",
  },
  {
    src: "/storefront/content/about-fastener-warehouse.png",
    alt: "Sklad nerezového spojovacieho materiálu",
    caption: "Sklad spojovacieho materiálu",
  },
  {
    src: "/storefront/content/about-steel-warehouse.png",
    alt: "Nerezový hutnícky materiál na sklade",
    caption: "Nerezový materiál na sklade",
  },
];

const aboutGalleryEn: readonly GalleryImage[] = [
  {
    src: "/akros/content/about-certificate.png",
    alt: "ISO 9001:2016 quality management system certificate",
    caption: "ISO 9001:2016 quality management certificate",
  },
  {
    src: "/akros/content/about-branch.png",
    alt: "Yellow building of the AKROS branch",
    caption: "AKROS branch",
  },
  {
    src: "/storefront/content/about-fastener-warehouse.png",
    alt: "Warehouse of stainless fasteners",
    caption: "Fastener warehouse",
  },
  {
    src: "/storefront/content/about-steel-warehouse.png",
    alt: "Stainless steel material in the warehouse",
    caption: "Stainless steel in stock",
  },
];

const manufacturingGalleryCs: readonly GalleryImage[] = [
  {
    src: "/storefront/content/about-welding.png",
    alt: "Svářeč při práci v provozu AKROS",
    caption: "Svařování",
  },
  {
    src: "/storefront/content/about-railing.png",
    alt: "Instalované nerezové zábradlí",
    caption: "Instalace nerezových zábradlí",
  },
  {
    src: "/storefront/content/about-powder-coating.png",
    alt: "Práškově lakované kovové díly",
    caption: "Práškové lakování",
  },
];

const manufacturingGallerySk: readonly GalleryImage[] = [
  {
    src: "/storefront/content/about-welding.png",
    alt: "Zvárač pri práci v prevádzke AKROS",
    caption: "Zváranie",
  },
  {
    src: "/storefront/content/about-railing.png",
    alt: "Nainštalované nerezové zábradlie",
    caption: "Inštalácia nerezových zábradlí",
  },
  {
    src: "/storefront/content/about-powder-coating.png",
    alt: "Práškovo lakované kovové diely",
    caption: "Práškové lakovanie",
  },
];

const manufacturingGalleryEn: readonly GalleryImage[] = [
  {
    src: "/storefront/content/about-welding.png",
    alt: "Welder at work in the AKROS production hall",
    caption: "Welding",
  },
  {
    src: "/storefront/content/about-railing.png",
    alt: "Installed stainless steel railing",
    caption: "Installed stainless steel railings",
  },
  {
    src: "/storefront/content/about-powder-coating.png",
    alt: "Powder-coated metal parts",
    caption: "Powder coating",
  },
];

const aboutCs = (
  <>
    <header className="sf-content-page__heading">
      <h1>O nás</h1>
      <p>
        AKROS je předním dodavatelem nerezového, hutního a spojovacího materiálu pro průmyslové
        aplikace. Naším cílem je kvalitní sortiment, profesionální poradenství a rychlé dodání ze
        skladů v Praze, Ostravě a Údlicích.
      </p>
    </header>

    <section className="sf-content-panel" aria-labelledby="company-history-title">
      <h2 id="company-history-title">AKROS, s.r.o.</h2>
      <p>
        Společnost AKROS, s.r.o. se specializuje na dodávky nerezového materiálu, hutního materiálu
        a spojovacího materiálu. Nabízíme standardní sortiment i zakázkovou výrobu pro průmysl,
        stavebnictví a technické projekty.
      </p>
      <p>
        Od roku 1994 rozvíjíme sklady, výrobu a odborné poradenství tak, aby zákazníci dostali
        správný materiál ve správné kvalitě a bez zbytečného čekání.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="certification-title">
      <h2 id="certification-title">Certifikace</h2>
      <p>Certifikát systému jakosti ISO 9001:2016</p>
      <ContentGallery items={aboutGalleryCs} />
    </section>

    <section className="sf-content-panel">
      <p>
        Společnost AKROS CZ, s.r.o. disponuje vlastními výrobními kapacitami pro zakázkovou výrobu,
        laserové řezání, svařování a tváření plechů. Moderní technologické zázemí zajišťuje vysokou
        kvalitu finálních produktů.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="services-title">
      <h2 id="services-title">Výrobní služby</h2>
      <ul className="sf-service-list">
        <li>Zakázková výroba</li>
        <li>Laserové řezání</li>
        <li>Svařování</li>
        <li>Tváření plechů</li>
      </ul>
    </section>

    <section className="sf-content-section" aria-labelledby="finishing-title">
      <div className="sf-content-panel">
        <h2 id="finishing-title">Galvanické povrchové úpravy</h2>
        <p>Nabízíme také galvanické povrchové úpravy pro vybrané materiály.</p>
      </div>
      <ContentGallery items={manufacturingGalleryCs} />
    </section>
  </>
);

const aboutSk = (
  <>
    <header className="sf-content-page__heading">
      <h1>O nás</h1>
      <p>
        AKROS je popredným dodávateľom nerezového, hutníckeho a spojovacieho materiálu pre
        priemyselné aplikácie. Naším cieľom je kvalitný sortiment, profesionálne poradenstvo a
        rýchle dodanie zo skladov v Prahe, Ostrave a Údliciach.
      </p>
    </header>

    <section className="sf-content-panel" aria-labelledby="company-history-title">
      <h2 id="company-history-title">AKROS, s.r.o.</h2>
      <p>
        Spoločnosť AKROS, s.r.o. sa špecializuje na dodávky nerezového materiálu, hutníckeho
        materiálu a spojovacieho materiálu. Ponúkame štandardný sortiment aj zákazkovú výrobu pre
        priemysel, stavebníctvo a technické projekty.
      </p>
      <p>
        Od roku 1994 rozvíjame sklady, výrobu a odborné poradenstvo tak, aby zákazníci dostali
        správny materiál v správnej kvalite a bez zbytočného čakania.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="certification-title">
      <h2 id="certification-title">Certifikácia</h2>
      <p>Certifikát systému kvality ISO 9001:2016</p>
      <ContentGallery items={aboutGallerySk} />
    </section>

    <section className="sf-content-panel">
      <p>
        Spoločnosť AKROS CZ, s.r.o. disponuje vlastnými výrobnými kapacitami na zákazkovú výrobu,
        laserové rezanie, zváranie a tvárnenie plechov. Moderné technologické zázemie zabezpečuje
        vysokú kvalitu finálnych produktov.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="services-title">
      <h2 id="services-title">Výrobné služby</h2>
      <ul className="sf-service-list">
        <li>Zákazková výroba</li>
        <li>Laserové rezanie</li>
        <li>Zváranie</li>
        <li>Tvárnenie plechov</li>
      </ul>
    </section>

    <section className="sf-content-section" aria-labelledby="finishing-title">
      <div className="sf-content-panel">
        <h2 id="finishing-title">Galvanické povrchové úpravy</h2>
        <p>Ponúkame aj galvanické povrchové úpravy pre vybrané materiály.</p>
      </div>
      <ContentGallery items={manufacturingGallerySk} />
    </section>
  </>
);

const aboutEn = (
  <>
    <header className="sf-content-page__heading">
      <h1>About us</h1>
      <p>
        AKROS is a leading supplier of stainless steel, steel and fastening materials for industrial
        applications. Our aim is a quality range, professional advice and fast dispatch from our
        warehouses in Prague, Ostrava and Údlice.
      </p>
    </header>

    <section className="sf-content-panel" aria-labelledby="company-history-title">
      <h2 id="company-history-title">AKROS, s.r.o.</h2>
      <p>
        AKROS, s.r.o. specialises in supplying stainless steel, steel and fastening materials. We
        offer both a standard range and custom manufacturing for industry, construction and
        technical projects.
      </p>
      <p>
        Since 1994 we have developed our warehouses, production and expert advice so that customers
        get the right material in the right quality without unnecessary waiting.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="certification-title">
      <h2 id="certification-title">Certification</h2>
      <p>ISO 9001:2016 quality management system certificate</p>
      <ContentGallery items={aboutGalleryEn} />
    </section>

    <section className="sf-content-panel">
      <p>
        AKROS CZ, s.r.o. has its own production capacity for custom manufacturing, laser cutting,
        welding and sheet forming. Modern equipment ensures high quality in the finished products.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="services-title">
      <h2 id="services-title">Manufacturing services</h2>
      <ul className="sf-service-list">
        <li>Custom manufacturing</li>
        <li>Laser cutting</li>
        <li>Welding</li>
        <li>Sheet forming</li>
      </ul>
    </section>

    <section className="sf-content-section" aria-labelledby="finishing-title">
      <div className="sf-content-panel">
        <h2 id="finishing-title">Galvanic surface treatments</h2>
        <p>We also offer galvanic surface treatments for selected materials.</p>
      </div>
      <ContentGallery items={manufacturingGalleryEn} />
    </section>
  </>
);

const productionCs = (
  <>
    <header className="sf-content-page__heading">
      <h1>AKROS CZ výroba</h1>
      <p>Zakázková výroba a zpracování materiálu pro průmysl, stavebnictví a technické projekty.</p>
    </header>
    <section className="sf-content-panel" aria-labelledby="manufacturing-services-title">
      <h2 id="manufacturing-services-title">Výrobní služby</h2>
      <p>
        AKROS CZ nabízí zakázkovou výrobu, laserové řezání, svařování a tváření plechů. Součástí
        nabídky jsou také galvanické povrchové úpravy pro vybrané materiály.
      </p>
      <ul className="sf-service-list">
        <li>Zakázková výroba</li>
        <li>Laserové řezání</li>
        <li>Svařování</li>
        <li>Tváření plechů</li>
        <li>Galvanické povrchové úpravy</li>
      </ul>
    </section>
    <section className="sf-content-panel" aria-labelledby="manufacturing-contact-title">
      <h2 id="manufacturing-contact-title">Řešení pro váš projekt</h2>
      <p>
        Pro informace o možnostech zpracování materiálu a zakázkové výrobě přejděte na{" "}
        <StoreLink href="/kontakty">kontakty AKROS</StoreLink>.
      </p>
      <p>
        Hledáte hotový materiál? Prohlédněte si{" "}
        <StoreLink href="/kategorie/nerezovy-spojovaci-material">
          nerezový spojovací materiál
        </StoreLink>{" "}
        nebo{" "}
        <StoreLink href="/kategorie/nerezovy-hutni-material">nerezový hutní materiál</StoreLink>.
      </p>
    </section>
  </>
);

const productionSk = (
  <>
    <header className="sf-content-page__heading">
      <h1>AKROS CZ výroba</h1>
      <p>
        Zákazková výroba a spracovanie materiálu pre priemysel, stavebníctvo a technické projekty.
      </p>
    </header>
    <section className="sf-content-panel" aria-labelledby="manufacturing-services-title">
      <h2 id="manufacturing-services-title">Výrobné služby</h2>
      <p>
        AKROS CZ ponúka zákazkovú výrobu, laserové rezanie, zváranie a tvárnenie plechov. Súčasťou
        ponuky sú aj galvanické povrchové úpravy pre vybrané materiály.
      </p>
      <ul className="sf-service-list">
        <li>Zákazková výroba</li>
        <li>Laserové rezanie</li>
        <li>Zváranie</li>
        <li>Tvárnenie plechov</li>
        <li>Galvanické povrchové úpravy</li>
      </ul>
    </section>
    <section className="sf-content-panel" aria-labelledby="manufacturing-contact-title">
      <h2 id="manufacturing-contact-title">Riešenia pre váš projekt</h2>
      <p>
        Informácie o možnostiach spracovania materiálu a zákazkovej výroby nájdete na stránke{" "}
        <StoreLink href="/kontakty">kontakty AKROS</StoreLink>.
      </p>
      <p>
        Hľadáte hotový materiál? Pozrite si{" "}
        <StoreLink href="/kategorie/nerezovy-spojovaci-material">
          nerezový spojovací materiál
        </StoreLink>{" "}
        alebo{" "}
        <StoreLink href="/kategorie/nerezovy-hutni-material">nerezový hutnícky materiál</StoreLink>.
      </p>
    </section>
  </>
);

const productionEn = (
  <>
    <header className="sf-content-page__heading">
      <h1>AKROS CZ manufacturing</h1>
      <p>
        Custom manufacturing and material processing for industry, construction and technical
        projects.
      </p>
    </header>
    <section className="sf-content-panel" aria-labelledby="manufacturing-services-title">
      <h2 id="manufacturing-services-title">Manufacturing services</h2>
      <p>
        AKROS CZ offers custom manufacturing, laser cutting, welding and sheet forming. Galvanic
        surface treatments for selected materials are also available.
      </p>
      <ul className="sf-service-list">
        <li>Custom manufacturing</li>
        <li>Laser cutting</li>
        <li>Welding</li>
        <li>Sheet forming</li>
        <li>Galvanic surface treatments</li>
      </ul>
    </section>
    <section className="sf-content-panel" aria-labelledby="manufacturing-contact-title">
      <h2 id="manufacturing-contact-title">Solutions for your project</h2>
      <p>
        For details of our material processing and custom manufacturing, go to{" "}
        <StoreLink href="/kontakty">AKROS contacts</StoreLink>.
      </p>
      <p>
        Looking for ready-made material? Browse{" "}
        <StoreLink href="/kategorie/nerezovy-spojovaci-material">stainless fasteners</StoreLink> or{" "}
        <StoreLink href="/kategorie/nerezovy-hutni-material">stainless steel products</StoreLink>.
      </p>
    </section>
  </>
);

const blogImages = [
  "/akros/content/blog-outdoor-screw.png",
  "/storefront/content/blog-torque.png",
  "/storefront/content/blog-news.png",
  "/storefront/content/blog-photovoltaics.png",
] as const;

const about: PerLocale<ReactNode> = { cs: aboutCs, sk: aboutSk, en: aboutEn };

export const akros: Brand = {
  id: "akros",
  name: "AKROS",
  legalName: "AKROS, s.r.o.",
  logo: { header: "/akros/logo-akros.png", footer: "/akros/footer/logo.png" },
  contact: {
    phone: { display: "737 591 849", href: "tel:+420737591849" },
    email: "akros@akros.cz",
    inquiryEmail: "poptavky@akros.cz",
  },
  production: {
    externalUrl: "https://www.akroscz.cz/",
    pages: {
      cs: { title: "AKROS CZ výroba", page: productionCs },
      sk: { title: "AKROS CZ výroba", page: productionSk },
      en: { title: "AKROS CZ manufacturing", page: productionEn },
    },
  },
  metadata: {
    defaultTitle: {
      cs: "AKROS | Nerezový a spojovací materiál",
      sk: "AKROS | Nerezový a spojovací materiál",
      en: "AKROS | Stainless and fastening materials",
    },
    description: {
      cs: "E-shop AKROS s nerezovým, hutním a spojovacím materiálem v prezentačním prostředí OntOS.",
      sk: "E-shop AKROS s nerezovým, hutníckym a spojovacím materiálom v prezentačnom prostredí OntOS.",
      en: "AKROS online shop for stainless, steel and fastening materials, in the OntOS presentation environment.",
    },
    icon: "/akros/icon.svg",
  },
  copy: akrosCopy,
  // Original banners and destinations from https://www.akros.cz/.
  carousel: [
    {
      id: "assortment",
      src: "/akros/home/carousel/67500399600e5.jpg",
      alt: {
        cs: "Nejširší sortiment v České republice. Nerezový spojovací a hutní materiál skladem v Praze, Ostravě i Chomutově.",
        sk: "Najširší sortiment v Českej republike. Nerezový spojovací a hutnícky materiál skladom v Prahe, Ostrave aj Chomutove.",
        en: "The widest range in the Czech Republic. Stainless fasteners and steel products in stock in Prague, Ostrava and Chomutov.",
      },
    },
    {
      id: "partner-program",
      src: "/akros/home/carousel/68d136545eac8.jpg",
      alt: {
        cs: "AKROS Partner. Výhody partnerského programu. Registrujte se do programu AKROS Partner.",
        sk: "AKROS Partner. Výhody partnerského programu. Zaregistrujte sa do programu AKROS Partner.",
        en: "AKROS Partner. Benefits of the partner programme. Register for the AKROS Partner programme.",
      },
      href: "/partnersky-program",
    },
    {
      id: "laser",
      src: "/akros/home/carousel/692e9fb636f53.jpg",
      alt: {
        cs: "AKROS CZ. Od ledna třikrát výkonnější laser. Rychlejší, čistší a kvalitnější řez materiálů do 40 mm.",
        sk: "AKROS CZ. Od januára trikrát výkonnejší laser. Rýchlejší, čistejší a kvalitnejší rez materiálov do 40 mm.",
        en: "AKROS CZ. Since January, a laser three times more powerful. Faster, cleaner and better cuts in materials up to 40 mm.",
      },
      href: "https://www.akroscz.cz/",
    },
    {
      id: "black-stainless-steel",
      src: "/akros/home/carousel/69dde68adb8d0.jpg",
      alt: {
        cs: "Nerezový sortiment v černé barvě. Novinka v nabídce: nerezová odolnost A4 v novém designu. Prohlédnout si.",
        sk: "Nerezový sortiment v čiernej farbe. Novinka v ponuke: nerezová odolnosť A4 v novom dizajne. Pozrieť si.",
        en: "Stainless range in black. New in our offer: A4 stainless corrosion resistance in a new design. Take a look.",
      },
      href: "https://www.akros.cz/nerez-cerny-design-product-37766",
    },
    {
      id: "solar-panels",
      src: "/akros/home/carousel/635c34c853149.jpg",
      alt: {
        cs: "Upevňovací systémy solárních panelů. Kompletní řešení pro všechny střechy, skladem na našich pobočkách.",
        sk: "Upevňovacie systémy solárnych panelov. Kompletné riešenia pre všetky strechy, skladom na našich pobočkách.",
        en: "Solar panel mounting systems. Complete solutions for all roofs, in stock at our branches.",
      },
      href: "https://www.akros.cz/solar-system",
    },
    {
      id: "branches",
      src: "/akros/home/carousel/6964ae6ccd0bf.jpg",
      alt: {
        cs: "Tři pobočky v České republice: Praha, Ostrava, Chomutov. Nerezavíme již 36 let, na trhu již od roku 1990.",
        sk: "Tri pobočky v Českej republike: Praha, Ostrava, Chomutov. Nehrdzavieme už 36 rokov, na trhu od roku 1990.",
        en: "Three branches in the Czech Republic: Prague, Ostrava and Chomutov. Not rusting for 36 years, on the market since 1990.",
      },
      href: "/kontakty",
    },
  ],
  pages: {
    about,
    branches: [
      {
        id: "praha",
        city: "Praha",
        title: "Prodejní sklad Praha – Ďáblice",
        address: "Chřibská 207/41, 182 00 Praha 8 – Ďáblice",
        details: "IČO: 00536792 · DIČ: CZ00536792",
        phone: "734 151 938",
        mapSrc: "/akros/content/contact-prague.png",
      },
      {
        id: "ostrava",
        city: "Ostrava",
        title: "Prodejní sklad Ostrava",
        address: "Mírová 385/57, 703 00 Ostrava – Vítkovice",
        phone: "734 151 938",
        mapSrc: "/akros/content/contact-ostrava.png",
      },
      {
        id: "chomutov",
        city: "Chomutov",
        title: "Prodejní sklad Chomutov – Údlice",
        address: "Droužkovická 399, 431 41 Údlice",
        phone: "734 151 938",
        mapSrc: "/akros/content/contact-chomutov.png",
      },
    ],
    blog: {
      featuredImage: "/storefront/content/blog-featured.png",
      articles: blogArticles(blogImages),
    },
    newsHero: "/storefront/content/news-hero.png",
  },
};
