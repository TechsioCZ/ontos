import { validateBrand } from '@techsio/ui-kit/theme/brand-validator';
import { akrosBrand, businessBrand } from '@techsio/ui-kit/theme/built-in-brands';
import { foundationTokens } from '@techsio/ui-kit/theme/foundation-tokens';
import type { BrandDefinition } from '@techsio/ui-kit/theme/theme-config';
import { Effect, Schema } from 'effect';
import { expect, it, test } from 'effect-rstest';

import { TenantThemeDefinitionSchema } from '../../packages/core-runtime/src/themes/contract.ts';
import { TenantThemeKit } from '../../packages/core-runtime/src/themes/definition.ts';
import { TenantThemeKitLive } from '../../packages/core-runtime/src/themes/kit.ts';
import {
  akrosTenantId,
  akrosTenantTheme,
  calmAdminTokens,
  calmBusinessTheme,
  demoThemeOfTenant,
} from '../demo/tenant-themes.mts';

/*
 * The look the demo tenants had before it became data: the Shell stylesheet's calm admin overrides
 * (:root.light[data-theme] and the square checkbox on :root) over the kit brand each tenant wore (AKROS for AKROS's
 * tenant, Business for every other). The seeded themes must resolve every one of these tokens to the same value.
 */
const stylesheetOverrides = {
  '--border-width-data-table': '0px',
  '--border-width-form-control': '1px',
  '--color-accordion-bg': 'transparent',
  '--color-accordion-content-bg': 'transparent',
  '--color-accordion-title-bg': 'transparent',
  '--color-dialog-content-bg': 'var(--color-base)',
  '--color-drawer-surface': 'var(--color-base)',
  '--color-form-control-bg': 'var(--color-base)',
  '--color-form-control-bg-focus': 'var(--color-base)',
  '--color-form-control-bg-hover': 'var(--color-base)',
  '--color-form-control-border': 'var(--color-border-primary)',
  '--color-form-control-border-hover': 'var(--color-fg-secondary)',
  '--color-table-bg': 'var(--color-base)',
  '--color-table-border': 'color-mix(in oklab, var(--color-border-primary) 60%, transparent)',
  '--color-table-footer-bg': 'transparent',
  '--color-table-header-bg': 'transparent',
  '--color-tabs-bg': 'transparent',
  '--color-tabs-border-base': 'color-mix(in oklab, var(--color-border-primary) 60%, transparent)',
  '--color-tabs-list-bg': 'transparent',
  '--radius-checkbox': '0.25rem',
  '--radius-checkbox-indeterminate': '0.25rem',
} as const;

/** The index of the parenthesis that closes the one opened just before `from`. */
const closingParenthesis = (value: string, from: number) => {
  let depth = 1;
  for (let index = from; index < value.length; index += 1) {
    depth += value[index] === '(' ? 1 : value[index] === ')' ? -1 : 0;
    if (depth === 0) {
      return index;
    }
  }
  throw new Error(`unbalanced value: ${value}`);
};

/** The first argument of a function whose arguments start at `from`: up to its first top-level comma. */
const firstArgument = (value: string, from: number, end: number) => {
  let depth = 0;
  for (let index = from; index < end; index += 1) {
    depth += value[index] === '(' ? 1 : value[index] === ')' ? -1 : 0;
    if (depth === 0 && value[index] === ',') {
      return value.slice(from, index);
    }
  }
  return value.slice(from, end);
};

/**
 * A token's value in the light mode of a brand, as the browser computes it: every `var()` replaced by the brand's
 * value over the foundation, every `light-dark()` by its light value, and the kit's transparent spelled `transparent`.
 */
const resolve = (brand: BrandDefinition, value: string, seen: readonly string[] = []): string => {
  const call = /(var|light-dark)\(/u.exec(value);
  if (call === null) {
    return value.trim() === 'oklch(0 0 none / 0)' ? 'transparent' : value.trim();
  }
  const open = call.index + call[0].length;
  const close = closingParenthesis(value, open);
  const argument = firstArgument(value, open, close).trim();
  let replacement = resolve(brand, argument, seen);
  if (call[1] === 'var') {
    if (seen.includes(argument)) {
      throw new Error(`${argument} refers to itself`);
    }
    const token = brand.tokens[argument] ?? foundationTokens[argument];
    if (token === undefined) {
      throw new Error(`${argument} is not a token of ${brand.key}`);
    }
    replacement = resolve(brand, token, [...seen, argument]);
  }
  return resolve(brand, `${value.slice(0, call.index)}${replacement}${value.slice(close + 1)}`, seen);
};

const token = (brand: BrandDefinition, name: string) => resolve(brand, `var(${name})`);

/** An oklch() colour's lightness (0-1), chroma and hue, to compare it with a value the browser printed. */
const oklch = (value: string) => {
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/u.exec(value);
  if (match === null) {
    throw new Error(`not an oklch() colour: ${value}`);
  }
  const [, lightness = '', percent, chroma = '', hue = ''] = match;
  return [Number(lightness) / (percent === '%' ? 100 : 1), Number(chroma), Number(hue)].map((part) =>
    Number(part.toFixed(4)),
  );
};

const themes = [
  { base: akrosBrand, name: 'akros', theme: akrosTenantTheme },
  { base: businessBrand, name: 'business', theme: calmBusinessTheme },
] as const;

test('AKROS wears akros and every other tenant the calm Business theme', () => {
  expect(demoThemeOfTenant(akrosTenantId)).toBe(akrosTenantTheme);
  expect(demoThemeOfTenant('70000000-0000-4000-8000-000000000020')).toBe(calmBusinessTheme);
  expect(akrosTenantTheme.key).toBe('akros');
  expect(calmBusinessTheme.key).toBe('business');
  expect(Object.keys(calmAdminTokens).toSorted()).toEqual(Object.keys(stylesheetOverrides).toSorted());
});

test.each(themes)('the $name theme passes the brand validator of the kit foundation', ({ theme }) => {
  const validation = validateBrand(theme);
  expect(validation.ok ? [] : validation.errors).toEqual([]);
});

it.effect.each(themes)('Core accepts the $name theme as it is', ({ theme }) =>
  Effect.gen(function* acceptedByCore() {
    const kit = yield* TenantThemeKit;
    const definition = yield* Schema.decodeUnknownEffect(TenantThemeDefinitionSchema)(theme);
    expect(yield* kit.validate(definition)).toEqual(definition);
  }).pipe(Effect.provide(TenantThemeKitLive)),
);

test('the seeded themes keep the primary colour the stage measured', () => {
  // getComputedStyle on stage, 2026-11-27: eshop@akros.demo and eshop@sroubarna.demo.
  expect(oklch(token(akrosTenantTheme, '--color-bg-primary-base'))).toEqual(oklch('oklch(85.1% .163 86.034)'));
  expect(oklch(token(calmBusinessTheme, '--color-bg-primary-base'))).toEqual(oklch('oklch(52.2% .117 253.551)'));
});

test.each(themes)('the $name theme resolves every calm admin token as the stylesheet did', ({ base, theme }) => {
  for (const [name, before] of Object.entries(stylesheetOverrides)) {
    expect({ name, value: token(theme, name) }).toEqual({ name, value: resolve(base, before) });
  }
});

test.each(themes)('the $name theme changes no other token of its kit brand', ({ base, theme }) => {
  for (const name of Object.keys(base.tokens)) {
    if (!(name in calmAdminTokens)) {
      expect({ name, value: theme.tokens[name] }).toEqual({ name, value: base.tokens[name] });
    }
  }
  expect(theme.modes).toEqual(base.modes);
});
