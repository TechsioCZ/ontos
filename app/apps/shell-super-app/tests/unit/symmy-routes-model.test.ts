import { SymmyCompanyRouteSchema } from '@app/symmy-integration/api/symmy-company-routes';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  SYMMY_PANEL_ROUTES,
  symmyEnableChanges,
  symmyMissingWorkloads,
  symmyPendingRoutes,
} from '../../src/routes/people/symmy-routes-model.ts';

const decodeRoute = Schema.decodeUnknownSync(SymmyCompanyRouteSchema);
const route = (routeKey: string, active: boolean, changeToken = 3) =>
  decodeRoute({ active, changeToken, routeId: '6d1d4cdb-72f9-4485-8c07-5806ec9468fe', routeKey, routeRevision: '1' });
const setup = {
  issuerId: ' symmy-akros ',
  retentionDays: 30,
  routeKeys: [...SYMMY_PANEL_ROUTES],
  sourceNamespace: 'akros-erp',
};
const source = { issuerId: 'symmy-akros', sourceNamespace: 'akros-erp' };

it('enables reads before writes, retention only on writes, and the price read source on price lists', () => {
  expect(symmyEnableChanges(setup, [])).toEqual([
    {
      kind: 'enable',
      routeKey: 'priceLists',
      settings: { priceReadSource: { ownerModuleId: 'external.symmy', sourceSystemRef: 'symmy-akros' }, source },
    },
    { kind: 'enable', routeKey: 'adminProducts', settings: { source } },
    { kind: 'enable', routeKey: 'adminCustomers', settings: { source } },
    { kind: 'enable', routeKey: 'adminRegions', settings: { source } },
    { kind: 'enable', routeKey: 'productsBatch', settings: { retentionDays: 30, source } },
    { kind: 'enable', routeKey: 'customersBatch', settings: { retentionDays: 30, source } },
    { kind: 'enable', routeKey: 'customerGroupsBatch', settings: { retentionDays: 30, source } },
    { kind: 'enable', routeKey: 'priceListsBatchUpsert', settings: { retentionDays: 30, source } },
  ]);
});

it('leaves active routes alone, re-enables a disabled one at its token and skips unchosen ones', () => {
  const routes = [route('adminProducts', true), route('productsBatch', false, 7)];
  expect(symmyPendingRoutes(routes)).not.toContain('adminProducts');
  expect(
    symmyEnableChanges({ ...setup, routeKeys: ['adminProducts', 'productsBatch', 'adminRegions'] }, routes),
  ).toEqual([
    { kind: 'enable', routeKey: 'adminRegions', settings: { source } },
    {
      expectedChangeToken: 7,
      kind: 'enable',
      routeKey: 'productsBatch',
      settings: { retentionDays: 30, source },
    },
  ]);
});

it('registers workloads only when every refusal is a missing integration binding naming them', () => {
  expect(
    symmyMissingWorkloads([
      { code: 'integration_binding_missing', workloads: ['integration.symmy.admit-symmy-sync', 'other'] },
      { code: 'integration_company_registration_missing', workloads: ['commerce.symmy-product-read'] },
      { code: 'integration_binding_missing', workloads: ['integration.symmy.admit-symmy-sync'] },
    ]),
  ).toEqual(['integration.symmy.admit-symmy-sync', 'commerce.symmy-product-read']);
  expect(symmyMissingWorkloads([])).toBeNull();
  expect(
    symmyMissingWorkloads([
      { code: 'integration_binding_missing', workloads: ['integration.symmy.admit-symmy-sync'] },
      { code: 'executor_binding_missing' },
    ]),
  ).toBeNull();
  expect(symmyMissingWorkloads([{ code: 'integration_binding_missing' }])).toBeNull();
});
