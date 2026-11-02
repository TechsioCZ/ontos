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

const warehouseGallerySk: readonly GalleryImage[] = [
  {
    src: "/storefront/content/about-fastener-warehouse.png",
    alt: "Regály so spojovacím materiálom v sklade",
    caption: "Sklad spojovacieho materiálu",
  },
  {
    src: "/storefront/content/about-steel-warehouse.png",
    alt: "Nerezové rúry a profily v sklade",
    caption: "Nerezový materiál na sklade",
  },
  {
    src: "/storefront/content/about-railing.png",
    alt: "Nainštalované nerezové zábradlie",
    caption: "Nerez pre vonkajšie použitie",
  },
];

const warehouseGalleryEn: readonly GalleryImage[] = [
  {
    src: "/storefront/content/about-fastener-warehouse.png",
    alt: "Shelves of fasteners in the warehouse",
    caption: "Fastener warehouse",
  },
  {
    src: "/storefront/content/about-steel-warehouse.png",
    alt: "Stainless tubes and profiles in the warehouse",
    caption: "Stainless steel in stock",
  },
  {
    src: "/storefront/content/about-railing.png",
    alt: "Installed stainless steel railing",
    caption: "Stainless steel for outdoor use",
  },
];

const aboutCs = (
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

const aboutSk = (
  <>
    <header className="sf-content-page__heading">
      <h1>O nás</h1>
      <p>
        {NAME} je ukážkový e-shop so spojovacím a nerezovým materiálom. Slúži na predvedenie
        platformy OntOS: sortiment, ceny aj sklad sú skutočné dáta z OntOS, firma a jej kontakty sú
        vymyslené.
      </p>
    </header>

    <section className="sf-content-panel" aria-labelledby="company-history-title">
      <h2 id="company-history-title">{LEGAL_NAME}</h2>
      <p>
        Šroubárna Vysočina s.r.o. je fiktívna firma vytvorená pre prezentácie. Neexistuje, nemá
        sídlo, IČO ani telefón a neprijíma skutočné objednávky.
      </p>
      <p>
        V ukážke predáva skrutky, matice, podložky, závitové tyče a ďalší spojovací materiál z
        nerezu A2 a A4 aj nerezový hutnícky materiál pre dielne, stavby a technické projekty.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="warehouse-title">
      <h2 id="warehouse-title">Sklad a sortiment</h2>
      <p>Ilustračné fotografie skladu a výrobkov.</p>
      <ContentGallery items={warehouseGallerySk} />
    </section>

    <section className="sf-content-panel" aria-labelledby="demo-contact-title">
      <h2 id="demo-contact-title">Kontakt (demo)</h2>
      <p>
        Otázky z ukážkového e-shopu spracúva tím {NAME} v OntOS. Napíšte nám cez{" "}
        <StoreLink href="/kontakty">kontaktný formulár</StoreLink> alebo na adresu {EMAIL} (iba
        ukážková adresa).
      </p>
    </section>
  </>
);

const aboutEn = (
  <>
    <header className="sf-content-page__heading">
      <h1>About us</h1>
      <p>
        {NAME} is a demo online shop for fasteners and stainless steel. It demonstrates the OntOS
        platform: the range, prices and stock are real OntOS data, while the company and its
        contacts are fictional.
      </p>
    </header>

    <section className="sf-content-panel" aria-labelledby="company-history-title">
      <h2 id="company-history-title">{LEGAL_NAME}</h2>
      <p>
        Šroubárna Vysočina s.r.o. is a fictional company created for presentations. It does not
        exist, has no registered office, company ID or telephone number, and does not accept real
        orders.
      </p>
      <p>
        In this demo it sells screws, nuts, washers, threaded rods and other fasteners in A2 and A4
        stainless steel, as well as stainless steel products for workshops, construction and
        technical projects.
      </p>
    </section>

    <section className="sf-content-section" aria-labelledby="warehouse-title">
      <h2 id="warehouse-title">Warehouse and range</h2>
      <p>Illustrative photos of the warehouse and products.</p>
      <ContentGallery items={warehouseGalleryEn} />
    </section>

    <section className="sf-content-panel" aria-labelledby="demo-contact-title">
      <h2 id="demo-contact-title">Contact (demo)</h2>
      <p>
        Enquiries from this demo shop are handled by the {NAME} team in OntOS. Write to us through
        the <StoreLink href="/kontakty">contact form</StoreLink> or at {EMAIL} (a sample address
        only).
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
    defaultTitle: {
      cs: `${NAME} | Spojovací a nerezový materiál`,
      sk: `${NAME} | Spojovací a nerezový materiál`,
      en: `${NAME} | Fasteners and stainless steel`,
    },
    description: {
      cs: `Ukázkový e-shop ${NAME} fiktivní firmy ${LEGAL_NAME} se spojovacím a nerezovým materiálem v prezentačním prostředí OntOS.`,
      sk: `Ukážkový e-shop ${NAME} fiktívnej firmy ${LEGAL_NAME} so spojovacím a nerezovým materiálom v ukážkovom prostredí OntOS.`,
      en: `${NAME}, the demo shop of the fictional company ${LEGAL_NAME}, selling fasteners and stainless steel in the OntOS demo environment.`,
    },
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
              ". Odporúčame sledovať aj výpredaj a akciový tovar.",
            ],
          },
          {
            id: "contact",
            content: [
              "Ide o ukážkové prostredie: objednávky sa neplatia ani nedoručujú a uvedené kontakty sú ",
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
              ". Keep an eye on our clearance and special offers too.",
            ],
          },
          {
            id: "contact",
            content: [
              "This is a demo environment: orders are neither paid nor delivered, and the contacts shown are ",
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
      alt: {
        cs: "Nerezový spojovací materiál: šrouby, matice a podložky skladem. Ukázkový e-shop fiktivní firmy Šroubárna Vysočina s.r.o.",
        sk: "Nerezový spojovací materiál: skrutky, matice a podložky na sklade. Ukážkový e-shop fiktívnej firmy Šroubárna Vysočina s.r.o.",
        en: "Stainless fasteners: bolts, nuts and washers in stock. Demo shop of the fictional company Šroubárna Vysočina s.r.o.",
      },
      href: "/kategorie/nerezovy-spojovaci-material",
    },
    {
      id: "partner-program",
      src: "/sroubshop/home/partner-program.svg",
      alt: {
        cs: "Partnerský program: výhody pro firemní zákazníky, individuální ceny a rychlejší nákup. Pouze ukázka.",
        sk: "Partnerský program: výhody pre firemných zákazníkov, individuálne ceny a rýchlejší nákup. Iba ukážka.",
        en: "Partner programme: benefits for business customers, individual prices and faster ordering. Demo only.",
      },
      href: "/partnersky-program",
    },
    {
      id: "delivery",
      src: "/sroubshop/home/delivery.svg",
      alt: {
        cs: "Doprava a platba přehledně na jednom místě. Ukázkové objednávky se nedoručují.",
        sk: "Doprava a platba prehľadne na jednom mieste. Ukážkové objednávky sa nedoručujú.",
        en: "Delivery and payment clearly in one place. Demo orders are not delivered.",
      },
      href: "/doprava-a-platba",
    },
  ],
  pages: {
    about: { cs: aboutCs, sk: aboutSk, en: aboutEn },
    branches: [
      {
        id: "vysocina",
        city: "Vysočina",
        title: {
          cs: `${LEGAL_NAME} – ukázková provozovna`,
          sk: `${LEGAL_NAME} – ukážková prevádzka`,
          en: `${LEGAL_NAME} – demo branch`,
        },
        address: {
          cs: "Fiktivní firma bez skutečné adresy (DEMO)",
          sk: "Fiktívna firma bez skutočnej adresy (DEMO)",
          en: "Fictional company without a real address (DEMO)",
        },
        details: {
          cs: "Kontakty jsou smyšlené a slouží pouze pro ukázku.",
          sk: "Kontakty sú vymyslené a slúžia iba na ukážku.",
          en: "The contact details are fictional and for demonstration only.",
        },
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
