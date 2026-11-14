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
  /** Company the brand belongs to; absent for the tenant's own workspace before a company is selected. */
  readonly legalEntityId?: string;
  /** Trusted tenant the entry is limited to; a company entry always carries it, so the brand never follows a company. */
  readonly tenantId?: string;
  readonly theme: StaffTheme;
}

const staffBrands: readonly StaffBrandEntry[] = [
  // The real AKROS company inside AKROS's own tenant, demoId('legal-entity', 'akros-playground'); see
  // scripts/demo/akros-playground-policy.mts. The trusted tenant+company pair is explicit, so a missing or different
  // tenant cannot paint AKROS and a pseudonymous demo company inside the tenant stays neutral.
  {
    legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
    tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
    theme: 'akros',
  },
  // AKROS's own tenant workspace, demoId('tenant', 'akros-playground'): worn only until a company is selected.
  { tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9', theme: 'akros' },
];

const appliesToCompany = (entry: StaffBrandEntry, tenantId: string | undefined, legalEntityId: string): boolean =>
  entry.legalEntityId === legalEntityId && (entry.tenantId === undefined || entry.tenantId === tenantId);

/**
 * Theme of the selected workspace. A selected company must match its trusted tenant and its own identity, and it falls
 * back to the neutral theme rather than to a tenant brand, so a missing or different tenant and any other company stay
 * neutral. Without a company (the tenant's own workspace) the tenant entry decides.
 */
export const staffThemeFor = (tenantId: string | undefined, legalEntityId?: string): StaffTheme => {
  if (legalEntityId !== undefined) {
    const company = staffBrands.find(
      (entry) => entry.legalEntityId !== undefined && appliesToCompany(entry, tenantId, legalEntityId),
    );
    return company?.theme ?? neutralStaffTheme;
  }
  const tenant = staffBrands.find((entry) => entry.legalEntityId === undefined && entry.tenantId === tenantId);
  return tenant?.theme ?? neutralStaffTheme;
};

/**
 * Whole `<html>` contract the signed-in frame wears: the workspace theme plus the class both themes render in.
 *
 * The layout writes the same shape as its neutral default, so whichever head write lands last still carries the
 * `light` class the ui-kit themes and the shell's calm admin tokens are keyed on.
 */
export const staffDocumentTheme = (tenantId: string | undefined, legalEntityId?: string) => ({
  className: 'light',
  'data-theme': staffThemeFor(tenantId, legalEntityId),
});
