interface HomeCarouselSlide {
  id: string;
  src: string;
  alt: string;
  href?: string;
}

// Original banners and destinations from https://www.akros.cz/.
export const homeCarouselSlides: readonly HomeCarouselSlide[] = [
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
];
