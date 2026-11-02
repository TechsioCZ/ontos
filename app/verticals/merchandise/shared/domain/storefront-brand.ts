/**
 * Brand of each company's e-shop, as customers and staff see it (order source, personal pickup).
 *
 * The pseudonymous demo company sells as ŠroubShop and never shows the AKROS brand; only AKROS's own playground
 * company is AKROS. Companies without a branded e-shop have no entry. One build serves all of them.
 */
const storefrontBrands: ReadonlyMap<string, string> = new Map([
  // Kavárna Doma demo e-shop.
  ['71000000-0000-4000-8000-000000000023', 'Kavárna Doma'],
  // Pseudonymous screw seller of the demo tenant (Šroubárna Vysočina s.r.o.).
  ['71000000-0000-4000-8000-000000000024', 'ŠroubShop'],
  // AKROS's own playground tenant.
  ['c0c78a3e-6e2a-57e0-9d0d-86253499fee7', 'AKROS'],
]);

/** The company's e-shop brand; `undefined` for a company without a branded e-shop. */
export const storefrontBrandOf = (legalEntityId: string | undefined): string | undefined =>
  legalEntityId === undefined ? undefined : storefrontBrands.get(legalEntityId);
