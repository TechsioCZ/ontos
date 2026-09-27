export const aboutGallery = [
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
    src: "/akros/content/about-fastener-warehouse.png",
    alt: "Sklad nerezového spojovacího materiálu",
    caption: "Sklad spojovacího materiálu",
  },
  {
    src: "/akros/content/about-steel-warehouse.png",
    alt: "Nerezový hutní materiál ve skladu",
    caption: "Nerezový materiál ve skladu",
  },
];

export const manufacturingGallery = [
  {
    src: "/akros/content/about-welding.png",
    alt: "Svářeč při práci v provozu AKROS",
    caption: "Svařování",
  },
  {
    src: "/akros/content/about-railing.png",
    alt: "Instalované nerezové zábradlí",
    caption: "Instalace nerezových zábradlí",
  },
  {
    src: "/akros/content/about-powder-coating.png",
    alt: "Práškově lakované kovové díly",
    caption: "Práškové lakování",
  },
];

interface Branch {
  id: string;
  city: string;
  title: string;
  address: string;
  details?: string;
  phone: string;
  mapSrc: string;
}

export const branches: readonly Branch[] = [
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
];

export const shippingMethods = [
  {
    title: "Zásilkovna — Výdejní místa",
    price: "89 Kč",
    delivery: "1–2 pracovní dny",
    description: "Vyzvednutí na více než 5 000 výdejních místech po celé ČR.",
  },
  {
    title: "PPL — Doručení na adresu",
    price: "119 Kč",
    delivery: "Následující pracovní den",
    description: "Komfortní doručení kurýrem přímo k vám domů nebo do firmy.",
  },
  {
    title: "DPD — Kurýrní služba",
    price: "109 Kč",
    delivery: "1–2 pracovní dny",
    description: "Spolehlivý kurýr s přesným avízem o hodině doručení.",
  },
  {
    title: "Osobní odběr na pobočce",
    price: "Zdarma",
    delivery: "Připraveno do 2 hodin",
    description: "Vyzvedněte si zboží přímo v našem centrálním skladu v Praze.",
  },
] as const;

export const paymentMethods = [
  {
    title: "Platba kartou online",
    description: "Okamžitá platba přes zabezpečenou 3D Secure bránu.",
  },
  {
    title: "Bankovní převod",
    description: "Klasický převod na účet. Zboží expedujeme po připsání platby.",
  },
  {
    title: "Na dobírku (+39 Kč)",
    description: "Zaplatíte hotově nebo kartou až při převzetí od doručovatele.",
  },
  {
    title: "PayPal",
    description: "Rychlá a bezpečná platba prostřednictvím vašeho PayPal účtu.",
  },
] as const;

export const faqGroups = [
  {
    id: "objednavky",
    title: "Objednávky a platby",
    items: [
      [
        "Jak dlouho trvá vyřízení objednávky?",
        "Zboží skladem expedujeme do 24 hodin od přijetí objednávky.",
      ],
      [
        "Je možné objednat nerezový spojovací materiál na zakázku?",
        "Ano, nabízíme zakázkovou výrobu dle výkresů. Kontaktujte nás na poptavky@akros.cz.",
      ],
      [
        "Jaký je rozdíl mezi nerezí A2 a A4?",
        "A2 je klasická potravinářská nerez. A4 obsahuje molybden a odolá i kyselinám a mořské vodě.",
      ],
      [
        "Poskytujete množstevní slevy pro firmy?",
        "Ano, pro registrované firemní partnery nabízíme individuální ceníky a slevy.",
      ],
      [
        "Mohu změnit položky v již odeslané objednávce?",
        "Změna je možná telefonicky do okamžiku, než je zásilka předána dopravci.",
      ],
    ],
  },
  {
    id: "doprava",
    title: "Doprava a doručení",
    items: [
      [
        "Jaké dopravce mohu využít?",
        "Objednávku doručíme prostřednictvím PPL, DPD nebo Zásilkovny. K dispozici je také osobní odběr.",
      ],
      [
        "Jak zjistím stav zásilky?",
        "Po expedici obdržíte číslo zásilky. V prototypu můžete otevřít ukázkové sledování zásilky.",
      ],
    ],
  },
  {
    id: "reklamace",
    title: "Reklamace a vrácení",
    items: [
      [
        "Jak mohu zboží reklamovat?",
        "Napište nám číslo objednávky a popis závady. Náš tým vám pošle další postup.",
      ],
      [
        "Lze nepoužité zboží vrátit?",
        "Standardní skladové zboží lze po domluvě vrátit v původním stavu a balení.",
      ],
    ],
  },
  {
    id: "produkty",
    title: "Produkty a materiály",
    items: [
      [
        "Kde najdu normu DIN nebo ISO?",
        "Norma je uvedena v názvu produktu, kódu a technickém popisu produktu.",
      ],
      [
        "Pomůžete mi s výběrem materiálu?",
        "Ano. Pošlete nám popis použití nebo výkres a doporučíme vhodnou jakost i rozměr.",
      ],
    ],
  },
] as const;

export const blogArticles = [
  {
    title: "Jak vybrat správný šroub pro venkovní použití",
    date: "5. února 2026",
    category: "Projekty",
    excerpt:
      "Venkovní konstrukce vyžadují materiály, které odolají dešti i mrazu. Připravili jsme přehled norem pro spojovací materiál.",
    imageSrc: "/akros/content/blog-outdoor-screw.png",
  },
  {
    title: "Správné utahovací momenty pro nerezové spoje",
    date: "28. ledna 2026",
    category: "Technická podpora",
    excerpt:
      "Přetažení šroubu z nerezové oceli může způsobit jeho zadření. Naučte se správné utahovací momenty pro závity M4 až M20.",
    imageSrc: "/akros/content/blog-torque.png",
  },
  {
    title: "Novinky v sortimentu pro rok 2026",
    date: "15. ledna 2026",
    category: "Novinky",
    excerpt:
      "Rozšiřujeme skladové zásoby spojovacího materiálu o další tisíce kusů certifikovaných norem DIN a ISO.",
    imageSrc: "/akros/content/blog-news.png",
  },
  {
    title: "Fotovoltaické konstrukce: na co nezapomenout",
    date: "3. ledna 2026",
    category: "Fotovoltaika",
    excerpt:
      "Instalace solárních panelů na střechu vyžaduje robustní a korozi odolné nerezové profily i spojovací materiál.",
    imageSrc: "/akros/content/blog-photovoltaics.png",
  },
] as const;
