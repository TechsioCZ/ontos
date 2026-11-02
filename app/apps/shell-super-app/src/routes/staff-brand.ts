/**
 * Staff app look per tenant and company: which ui-kit brand theme the `<html>` element wears.
 *
 * Only a customer's own tenant wears that customer's brand. Every other workspace, the sign-in page and the
 * pseudonymous demo companies included, uses the neutral theme, so a demo for one customer never shows another
 * customer's brand. One build serves every tenant; adding a branded customer is one entry below, not a fork.
 */
import { Schema } from 'effect';

/** ui-kit brand themes the staff app may select (`data-theme` values). */
export const StaffThemeSchema = Schema.Literals(['akros', 'business']);
export type StaffTheme = typeof StaffThemeSchema.Type;

/** Neutral ui-kit theme: light, calm business palette, no customer brand. */
export const neutralStaffTheme: StaffTheme = 'business';

interface StaffBrandEntry {
  /** Restricts the brand to one company of the tenant; absent for the whole tenant. */
  readonly legalEntityId?: string;
  readonly tenantId: string;
  readonly theme: StaffTheme;
}

const staffBrands: readonly StaffBrandEntry[] = [
  // AKROS's own playground tenant, demoId('tenant', 'akros-playground'); see scripts/demo/akros-playground-policy.mts.
  { tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9', theme: 'akros' },
];

/** Theme of the selected workspace; a company entry wins over its tenant's entry. */
export const staffThemeFor = (tenantId: string | undefined, legalEntityId?: string): StaffTheme => {
  const tenantEntries = staffBrands.filter((entry) => entry.tenantId === tenantId);
  const company = tenantEntries.find(
    (entry) => entry.legalEntityId !== undefined && entry.legalEntityId === legalEntityId,
  );
  const tenant = tenantEntries.find((entry) => entry.legalEntityId === undefined);
  return (company ?? tenant)?.theme ?? neutralStaffTheme;
};
