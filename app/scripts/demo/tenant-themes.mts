import { akrosBrand, businessBrand } from '@techsio/ui-kit/theme/built-in-brands';
import { extendBrand } from '@techsio/ui-kit/theme/theme-config';
import type { BrandDefinition } from '@techsio/ui-kit/theme/theme-config';

import { demoId, demoTenantId } from './fixture-ids.mts';

/*
 * The demo tenants' themes, as data Core stores (core.tenant_themes) and attaches (core.tenant_theme_attachments).
 * They are written through the Shell's save-tenant-theme and attach-tenant-theme Actions by
 * seed-tenant-themes.mts, never applied by Shell code: the Shell renders whatever theme Core answers.
 */

const pageColour = 'var(--color-base)';
const transparent = 'var(--color-transparent)';
const hairline = 'color-mix(in oklab, var(--color-border-primary) 60%, transparent)';

/**
 * The calm admin look of the sales demo: hairline form controls on the page colour, tables without an outer box or
 * grey fill, tabs and accordions on the page colour, white dialogs and side panels, square checkboxes. Every token
 * is one the kit's foundation has, so the kit's brand validator accepts it.
 */
export const calmAdminTokens = {
  // Calm surfaces: one outlined level and light hairline dividers.
  '--border-width-data-table': 'var(--border-width-none)',
  // Calm form controls; validation and focus tokens stay the foundation's.
  '--border-width-form-control': 'var(--border-width-sm)',
  '--color-accordion-bg': transparent,
  '--color-accordion-content-bg': transparent,
  '--color-accordion-title-bg': transparent,
  '--color-dialog-content-bg': pageColour,
  '--color-drawer-surface': pageColour,
  '--color-form-control-bg': pageColour,
  '--color-form-control-bg-focus': pageColour,
  '--color-form-control-bg-hover': pageColour,
  '--color-form-control-border': 'var(--color-border-primary)',
  '--color-form-control-border-hover': 'var(--color-fg-secondary)',
  '--color-table-bg': pageColour,
  '--color-table-border': hairline,
  '--color-table-footer-bg': transparent,
  '--color-table-header-bg': transparent,
  '--color-tabs-bg': transparent,
  '--color-tabs-border-base': hairline,
  '--color-tabs-list-bg': transparent,
  // The foundation draws an 18 px checkbox with --radius-sm (0.5rem), which reads as a circle. Keep it square.
  '--radius-checkbox': 'var(--radius-xs)',
  '--radius-checkbox-indeterminate': 'var(--radius-xs)',
} as const;

/** AKROS's own tenant: the kit's AKROS brand in the calm admin look. */
export const akrosTenantTheme: BrandDefinition = extendBrand(akrosBrand, {
  key: 'akros',
  tokens: calmAdminTokens,
});

/** The shared sales-demo tenant: the kit's Business brand in the calm admin look. */
export const demoTenantTheme: BrandDefinition = extendBrand(businessBrand, {
  key: 'ontos-demo',
  label: 'OntOS DEMO',
  tokens: calmAdminTokens,
});

/** Which theme each demo tenant wears. A tenant not listed wears the default, the kit's Business brand. */
export const demoTenantThemes = {
  [demoId('tenant', 'akros-playground')]: akrosTenantTheme,
  [demoTenantId]: demoTenantTheme,
} satisfies Readonly<Record<string, BrandDefinition>>;
