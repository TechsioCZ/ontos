// ŠroubShop (`STOREFRONT_BRAND=sroubshop`): the fictional screw seller Šroubárna Vysočina s.r.o. used for demos.
// No logo (text wordmark), demo-only contacts (no real company ID, phone or address), neutral images only.
import "server-only";
import { ContentGallery } from "@/components/content-gallery";
import StoreLink from "@/components/store-link";
import { blogArticles } from "@/content/editorial";
import type { Brand, GalleryImage } from "./types";

const NAME = "ŠroubShop";
const LEGAL_NAME = "Šroubárna Vysočina s.r.o.";
const EMAIL = "eshop@sroubarna.demo";

const warehouseGallery: readonly GalleryImage[] = [
  {
    src: "/storefront/content/about-fastener-warehouse.png",
    alt: "Regály se spojovacím materiálem ve skladu",
    caption: "Sklad spojovacího materiálu",
  },
  {
    src: "/storefront/content/about-steel-warehouse.png",
    alt: "Nerezové trubky a profily ve skladu",
    caption: "Nerezový materiál ve skladu",
  },
  {
    src: "/storefront/content/about-railing.png",
    alt: "Instalované nerezové zábradlí",
    caption: "Nerez pro venkovní použití",
  },
];

const about = (
  <>
    <header className="sf-content-page__heading">
      <h1>O nás</h1>
      <p>
        {NAME} je ukázkový e-shop se spojovacím a nerezovým materiálem. Slouží k předvedení
        platformy OntOS: sortiment, ceny i sklad jsou skutečná data z OntOS, firma a její kontakty
        jsou smyšlené.
      </p>
    </header>

    <section className="sf-content-panel" aria-labelledby="company-history-title">
      <h2 id="company-history-title">{LEGAL_NAME}</h2>
      <p>
        Šroubárna Vysočina s.r.o. je fiktivní firma vytvořená pro prezentace. Neexistuje, nemá
        sídlo, IČO ani telefon a nepřijímá skutečné objednávky.
      </p>
      <p>
        V ukázce prodává šrouby, matice, podložky, závitové tyče a další spojovací materiál z nerezi
        A2 a A4 i nerezový hutní materiál pro dílny, stavby a technické projekty.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="warehouse-title">
      <h2 id="warehouse-title">Sklad a sortiment</h2>
      <p>Ilustrační fotografie skladu a výrobků.</p>
      <ContentGallery items={warehouseGallery} />
    </section>

    <section className="sf-content-panel" aria-labelledby="demo-contact-title">
      <h2 id="demo-contact-title">Kontakt (demo)</h2>
      <p>
        Dotazy z ukázkového e-shopu zpracovává tým {NAME} v OntOS. Napište nám přes{" "}
        <StoreLink href="/kontakty">kontaktní formulář</StoreLink> nebo na adresu {EMAIL} (pouze
        ukázková adresa).
      </p>
    </section>
  </>
);

export const sroubshop: Brand = {
  id: "sroubshop",
  name: NAME,
  legalName: LEGAL_NAME,
  logo: null,
  contact: { email: EMAIL, inquiryEmail: "poptavky@sroubarna.demo" },
  production: null,
  metadata: {
    defaultTitle: `${NAME} | Spojovací a nerezový materiál`,
    description: `Ukázkový e-shop ${NAME} fiktivní firmy ${LEGAL_NAME} se spojovacím a nerezovým materiálem v prezentačním prostředí OntOS.`,
    icon: "/sroubshop/icon.svg",
  },
  copy: {
    cs: {
      companyTitle: `${NAME} – spojovací a nerezový materiál`,
      companyIntro: {
        label: `O e-shopu ${NAME}`,
        paragraphs: [
          {
            id: "welcome",
            content: [
              `Vítejte v ukázkovém e-shopu ${NAME}, který provozuje fiktivní firma ${LEGAL_NAME} V kategorii `,
              { strong: "nerezových spojovacích materiálů" },
              " najdete šrouby, matice, podložky, vruty, kolíky, nýty, řetězy i nářadí. V kategorii ",
              { strong: "nerezový hutní materiál" },
              " nabízíme plechy, trubky, tyče, kolena, příruby a armatury.",
            ],
          },
          {
            id: "assortment",
            content: [
              "Sortiment, ceny i dostupnost přebíráme ",
              { strong: "přímo z OntOS" },
              ". Doporučujeme sledovat také Výprodej a Zboží v akci.",
            ],
          },
          {
            id: "contact",
            content: [
              "Jde o prezentační prostředí: objednávky se neplatí ani nedoručují a uvedené kontakty jsou ",
              { strong: "pouze ukázkové" },
              ".",
            ],
          },
        ],
      },
      copyright: `© 2026 ${LEGAL_NAME} – fiktivní ukázková firma`,
    },
    sk: {
      companyTitle: `${NAME} – spojovací a nerezový materiál`,
      companyIntro: {
        label: `O e-shope ${NAME}`,
        paragraphs: [
          {
            id: "welcome",
            content: [
              `Vitajte v ukážkovom e-shope ${NAME}, ktorý prevádzkuje fiktívna firma ${LEGAL_NAME} V kategórii `,
              { strong: "nerezových spojovacích materiálov" },
              " nájdete skrutky, matice, podložky, vruty, kolíky, nity, reťaze aj náradie. V kategórii ",
              { strong: "nerezový hutnícky materiál" },
              " ponúkame plechy, rúry, tyče, kolená, príruby a armatúry.",
            ],
          },
          {
            id: "assortment",
            content: [
              "Sortiment, ceny aj dostupnosť preberáme ",
              { strong: "priamo z OntOS" },
              ". Odporúčame sledovať aj výpredaj a tovar v akcii.",
            ],
          },
          {
            id: "contact",
            content: [
              "Ide o prezentačné prostredie: objednávky sa neplatia ani nedoručujú a uvedené kontakty sú ",
              { strong: "iba ukážkové" },
              ".",
            ],
          },
        ],
      },
      copyright: `© 2026 ${LEGAL_NAME} – fiktívna ukážková firma`,
    },
    en: {
      companyTitle: `${NAME} – fasteners and stainless steel`,
      companyIntro: {
        label: `About ${NAME}`,
        paragraphs: [
          {
            id: "welcome",
            content: [
              `Welcome to ${NAME}, a demo shop run by the fictional company ${LEGAL_NAME} Our `,
              { strong: "stainless fasteners" },
              " include bolts, nuts, washers, screws, pins, rivets, chains and tools, and our ",
              { strong: "stainless steel products" },
              " include sheets, tubes, bars, elbows, flanges and fittings.",
            ],
          },
          {
            id: "assortment",
            content: [
              "Products, prices and availability come ",
              { strong: "straight from OntOS" },
              ". Keep an eye on our sale and special offers as well.",
            ],
          },
          {
            id: "contact",
            content: [
              "This is a presentation environment: orders are neither paid nor delivered, and the contacts shown are ",
              { strong: "demo placeholders only" },
              ". Product descriptions are provided in Czech.",
            ],
          },
        ],
      },
      copyright: `© 2026 ${LEGAL_NAME} – fictional demo company`,
    },
  },
  carousel: [
    {
      id: "assortment",
      src: "/sroubshop/home/assortment.svg",
      alt: "Nerezový spojovací materiál: šrouby, matice a podložky skladem. Ukázkový e-shop fiktivní firmy Šroubárna Vysočina s.r.o.",
      href: "/kategorie/nerezovy-spojovaci-material",
    },
    {
      id: "partner-program",
      src: "/sroubshop/home/partner-program.svg",
      alt: "Partnerský program: výhody pro firemní zákazníky, individuální ceny a rychlejší nákup. Pouze ukázka.",
      href: "/partnersky-program",
    },
    {
      id: "delivery",
      src: "/sroubshop/home/delivery.svg",
      alt: "Doprava a platba přehledně na jednom místě. Ukázkové objednávky se nedoručují.",
      href: "/doprava-a-platba",
    },
  ],
  pages: {
    about,
    branches: [
      {
        id: "vysocina",
        city: "Vysočina",
        title: `${LEGAL_NAME} – ukázková provozovna`,
        address: "Fiktivní firma bez skutečné adresy (DEMO)",
        details: "Kontakty jsou smyšlené a slouží pouze pro ukázku.",
        email: EMAIL,
      },
    ],
    blog: {
      featuredImage: "/storefront/content/blog-featured.png",
      articles: blogArticles([
        "/storefront/content/about-railing.png",
        "/storefront/content/blog-torque.png",
        "/storefront/content/blog-news.png",
        "/storefront/content/blog-photovoltaics.png",
      ]),
    },
    newsHero: "/storefront/content/news-hero.png",
  },
};
