// AKROS brand (default, `STOREFRONT_BRAND=akros` or unset): Kai Uwe's original content, moved here unchanged.
import "server-only";
import { ContentGallery } from "@/components/content-gallery";
import StoreLink from "@/components/store-link";
import { blogArticles } from "@/content/editorial";
import { akrosCopy } from "./akros-copy";
import type { Brand, GalleryImage } from "./types";

const aboutGallery: readonly GalleryImage[] = [
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

const manufacturingGallery: readonly GalleryImage[] = [
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

const about = (
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
      <ContentGallery items={aboutGallery} />
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
      <ContentGallery items={manufacturingGallery} />
    </section>
  </>
);

const production = (
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

const blogImages = [
  "/akros/content/blog-outdoor-screw.png",
  "/storefront/content/blog-torque.png",
  "/storefront/content/blog-news.png",
  "/storefront/content/blog-photovoltaics.png",
] as const;

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
    title: "AKROS CZ výroba",
    page: production,
  },
  metadata: {
    defaultTitle: "AKROS | Nerezový a spojovací materiál",
    description:
      "E-shop AKROS s nerezovým, hutním a spojovacím materiálem v prezentačním prostředí OntOS.",
    icon: "/akros/icon.svg",
  },
  copy: akrosCopy,
  // Original banners and destinations from https://www.akros.cz/.
  carousel: [
    {
      id: "assortment",
      src: "/akros/home/carousel/67500399600e5.jpg",
      alt: "Nejširší sortiment v České republice. Nerezový spojovací a hutní materiál skladem v Praze, Ostravě i Chomutově.",
    },
    {
      id: "partner-program",
      src: "/akros/home/carousel/68d136545eac8.jpg",
      alt: "AKROS Partner. Výhody partnerského programu. Registrujte se do programu AKROS Partner.",
      href: "/partnersky-program",
    },
    {
      id: "laser",
      src: "/akros/home/carousel/692e9fb636f53.jpg",
      alt: "AKROS CZ. Od ledna třikrát výkonnější laser. Rychlejší, čistší a kvalitnější řez materiálů do 40 mm.",
      href: "https://www.akroscz.cz/",
    },
    {
      id: "black-stainless-steel",
      src: "/akros/home/carousel/69dde68adb8d0.jpg",
      alt: "Nerezový sortiment v černé barvě. Novinka v nabídce: nerezová odolnost A4 v novém designu. Prohlédnout si.",
      href: "https://www.akros.cz/nerez-cerny-design-product-37766",
    },
    {
      id: "solar-panels",
      src: "/akros/home/carousel/635c34c853149.jpg",
      alt: "Upevňovací systémy solárních panelů. Kompletní řešení pro všechny střechy, skladem na našich pobočkách.",
      href: "https://www.akros.cz/solar-system",
    },
    {
      id: "branches",
      src: "/akros/home/carousel/6964ae6ccd0bf.jpg",
      alt: "Tři pobočky v České republice: Praha, Ostrava, Chomutov. Nerezavíme již 36 let, na trhu již od roku 1990.",
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
