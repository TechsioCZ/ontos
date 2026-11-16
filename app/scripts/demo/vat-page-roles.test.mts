// The DPH page reads the company's VAT regime and rates from Tax as the person. A preset role that shows its navigation
// item must therefore hold every Tax read the page's data needs, or be the tenant owner (full access); otherwise the
// person sees the item and gets "forbidden". The VAT choices an invoice or price form offers come through Finance's own
// Tax read, so every role reading Finance keeps `finance.billing.vat-choices.read`.
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { policyReleaseEntries, policyRoleKeys } from './access-policy.mts';
import type { PolicyRole } from './access-policy.mts';
import {
  crmDemoRoles,
  demoRoles,
  dphPageKeys,
  eshopDemoRoles,
  rentalDemoRoles,
  taxAccountantKeys,
} from './permissions.mts';

const [NAVIGATION, PAGE] = dphPageKeys;
const VAT_CHOICES = 'finance.billing.vat-choices.read';

/** Every preset role, named by its group and key. */
const presets: readonly (readonly [string, PolicyRole])[] = [
  ...Object.entries(demoRoles).map(([key, role]) => [`demo.${key}`, role] as const),
  ...Object.entries(rentalDemoRoles).map(([key, role]) => [`rental.${key}`, role] as const),
  ...Object.entries(crmDemoRoles).map(([key, role]) => [`crm.${key}`, role] as const),
  ...Object.entries(eshopDemoRoles).map(([key, role]) => [`eshop.${key}`, role] as const),
];

const catalog = Effect.gen(function* catalogEntries() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
  return yield* Effect.fromResult(
    policyReleaseEntries(
      modules,
      modules.map(({ moduleId }) => moduleId),
    ),
  );
}).pipe(Effect.provide(NodeServices.layer));

it.effect('every preset showing the DPH page can load its data; every Finance reader keeps the VAT choices', () =>
  Effect.gen(function* dphPageRoles() {
    const entries = yield* catalog;
    const keysOf = new Map(presets.map(([name, role]) => [name, new Set(policyRoleKeys(role, entries))]));
    const showing = presets.filter(([name]) => keysOf.get(name)?.has(NAVIGATION) === true);
    // Each role that shows the item can open the page and read every Tax datum it loads, or owns the tenant.
    const unusable = showing
      .filter(([name, role]) => {
        const keys = keysOf.get(name) ?? new Set();
        return role.tenantOwner !== true && !(keys.has(PAGE) && taxAccountantKeys.every((key) => keys.has(key)));
      })
      .map(([name]) => name);
    expect(unusable).toEqual([]);
    expect(showing.map(([name]) => name).toSorted()).toEqual(['demo.accountant', 'demo.headOfSales']);
    // The Obchodník keeps only the VAT choices of the three Finance VAT reads.
    const salesRep = keysOf.get('demo.salesRep') ?? new Set();
    expect([salesRep.has(NAVIGATION), salesRep.has(PAGE), salesRep.has(VAT_CHOICES)]).toEqual([false, false, true]);
    const financeReaders = presets.filter(([, role]) => role.modules['finance.billing'] !== undefined);
    expect(financeReaders.filter(([name]) => keysOf.get(name)?.has(VAT_CHOICES) !== true)).toEqual([]);
  }),
);
