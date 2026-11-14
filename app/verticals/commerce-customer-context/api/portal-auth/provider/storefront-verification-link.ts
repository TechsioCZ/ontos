/**
 * One Commerce portal realm serves every storefront of the deployment, and each storefront proxies the realm's public
 * routes under its own origin. A verification mail must send the customer back to the storefront they registered on,
 * not to the realm's configured base URL, which names only one of them.
 *
 * The registering storefront's origin is the trusted request origin the enrollment start (or resend) route already
 * admitted. It rides to Better Auth's verification callback as the native per-request `callbackURL`, and the realm
 * rebases the emailed link onto it. The link keeps the realm path and token and drops `callbackURL`: the storefront's
 * verify route lands on its own fixed page and never follows a mailed redirect.
 */

const originOf = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The `callbackURL` that names the registering storefront for Better Auth's verification send. */
export const storefrontVerificationCallback = (storefrontOrigin: URL): string => `${storefrontOrigin.origin}/`;

/**
 * Rebases a Better Auth verification link onto the storefront its `callbackURL` names, when that storefront is one of
 * the realm's trusted origins. Without a trusted storefront the link is returned unchanged.
 */
export const storefrontVerificationLink = (link: string, trustedOrigins: readonly string[]): string => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link;
  }
  const callback = url.searchParams.get('callbackURL');
  const storefront = callback === null ? undefined : originOf(callback);
  const trusted = new Set(trustedOrigins.flatMap((candidate) => originOf(candidate) ?? []));
  if (storefront === undefined || !trusted.has(storefront)) {
    return link;
  }
  const rebased = new URL(`${url.pathname}${url.search}`, storefront);
  rebased.searchParams.delete('callbackURL');
  return rebased.toString();
};
