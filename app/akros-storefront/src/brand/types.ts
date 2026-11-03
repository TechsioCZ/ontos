import type { ReactNode } from "react";

/** Storefront brands one build can serve (`STOREFRONT_BRAND`). */
export const BRAND_IDS = ["akros", "sroubshop"] as const;
export type BrandId = (typeof BRAND_IDS)[number];

/** Chrome languages a brand writes its own copy in; any other market locale uses English. */
export type BrandLocale = "cs" | "sk" | "en";

/** Brand content in each brand language (`brandLocale(market.locale)` picks the entry). */
export type PerLocale<T> = Readonly<Record<BrandLocale, T>>;

/** A paragraph with emphasized parts (`{ strong }`), as the home page renders it. */
interface RichParagraph {
  id: string;
  content: readonly (string | { strong: string })[];
}

/** Brand copy that differs per market language. */
export interface BrandCopy {
  /** Visually hidden main heading of the home page. */
  companyTitle: string;
  /** Company introduction below the featured products. */
  companyIntro: { label: string; paragraphs: readonly RichParagraph[] };
  /** Footer copyright line. */
  copyright: string;
  /** Labels of the brand's own manufacturing page (header) and external site (catalog sidebar). */
  production?: { headerLabel: string; sidebarLabel: string };
}

export interface CarouselSlide {
  id: string;
  src: string;
  alt: string;
  href?: string;
}

/** A home banner as the brand defines it; `alt` is per language, `CarouselSlide` is the resolved one. */
interface BrandCarouselSlide extends Omit<CarouselSlide, "alt"> {
  alt: PerLocale<string>;
}

export interface GalleryImage {
  src: string;
  alt: string;
  caption: string;
}

/** Brand data (names, addresses) stays as written; demo disclaimers may be given per language. */
export type BranchText = string | PerLocale<string>;

interface Branch {
  id: string;
  city: string;
  title: BranchText;
  address: BranchText;
  details?: BranchText;
  phone?: string;
  email?: string;
  mapSrc?: string;
}

export interface BlogArticle {
  title: string;
  date: string;
  category: string;
  excerpt: string;
  imageSrc: string;
}

/** One storefront brand: everything the shop shows that is not OntOS data or generic shop copy. */
export interface Brand {
  id: BrandId;
  /** Store name used in titles and running text (`AKROS`, `ŠroubShop`). */
  name: string;
  /** Registered company name (legal pages, about page). */
  legalName: string;
  /** Raster logo; without one the header and footer show the store name as a text wordmark. */
  logo: { header: string; footer: string } | null;
  contact: {
    phone?: { display: string; href: string };
    email: string;
    /** Address for custom manufacturing inquiries (FAQ). */
    inquiryEmail: string;
  };
  /** The brand's manufacturing page (`/kategorie/akroscz-vyroba`) and external site; null hides both. */
  production: {
    externalUrl: string;
    /** Page title and body per language. */
    pages: PerLocale<{ title: string; page: ReactNode }>;
  } | null;
  metadata: {
    defaultTitle: PerLocale<string>;
    description: PerLocale<string>;
    icon: string;
  };
  copy: Readonly<Record<BrandLocale, BrandCopy>>;
  carousel: readonly BrandCarouselSlide[];
  pages: {
    /** `/o-nas` body (inside the content article). */
    about: PerLocale<ReactNode>;
    /** `/kontakty` locations. */
    branches: readonly Branch[];
    /** `/blog` articles and the featured story image. */
    blog: { featuredImage: string; articles: PerLocale<readonly BlogArticle[]> };
    /** `/novinky-a-akce` hero image. */
    newsHero: string;
  };
}

/** Serializable brand chrome for client components (header, footer, sidebar, forms). */
export interface ClientBrand {
  name: string;
  logo: Brand["logo"];
  contact: { phone?: { display: string; href: string }; email: string };
  copyright: string;
  production: {
    path: string;
    externalUrl: string;
    headerLabel: string;
    sidebarLabel: string;
  } | null;
}

/** The text of a branch field in `locale` (a plain string is brand data, the same in every language). */
export const branchText = (value: BranchText, locale: BrandLocale): string =>
  typeof value === "string" ? value : value[locale];
