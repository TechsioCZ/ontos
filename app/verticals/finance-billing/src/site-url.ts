declare global {
  /** The public origin the build defines for this unit's pages. */
  const ULTRAMODERN_SITE_URL: string;
}

/**
 * The public origin of this unit's pages (their canonical and alternate links), without a trailing slash. Declared and
 * read here, so a page compiles wherever it is imported, not only in the app's own compile.
 */
export const siteOrigin = (): string => ULTRAMODERN_SITE_URL.replace(/\/+$/u, '');
