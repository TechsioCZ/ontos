import { expect, it } from 'effect-rstest';
import type { ShellNavigationItem } from '../../../shared/api.ts';
import {
  hasModuleAiApprovals,
  presentableDemoNavigation,
  withAgentPlatformNavigation,
  withoutModuleAiApprovals,
} from '../../../src/routes/shell-demo-presentation.ts';

const navigation = ['/contacts', '/sprava/lide', '/crm/klienti'].map((href) => ({ href })) as ShellNavigationItem[];

it('hides unfinished contacts for everyone and people administration for non-administrators', () => {
  expect(presentableDemoNavigation(navigation, false).map(({ href }) => href)).toEqual(['/crm/klienti']);
  expect(presentableDemoNavigation(navigation, true).map(({ href }) => href)).toEqual(['/sprava/lide', '/crm/klienti']);
});

const clientDestinations = (enabled = true, unavailable = false): ShellNavigationItem[] =>
  [
    { enabled, href: '/crm/klienti', moduleId: 'demo.crm', unavailable },
    { href: '/prodej/zakaznici', moduleId: 'party.registry' },
    { href: '/zakaznici', moduleId: 'party.registry' },
    { href: '/customers', moduleId: 'party.registry' },
    { href: '/crm/navstevy', moduleId: 'demo.crm' },
  ] as ShellNavigationItem[];

it.each([true, false])('hides competing legacy customer destinations when CRM is available (admin: %s)', (admin) => {
  expect(presentableDemoNavigation(clientDestinations(), admin).map(({ href }) => href)).toEqual([
    '/crm/klienti',
    '/crm/navstevy',
  ]);
});

it('keeps the customer list beside the entrusted-contact CRM outside the wholesale company', () => {
  expect(presentableDemoNavigation(clientDestinations(), true, '71000000-0000-4000-8000-000000000021')).toEqual(
    clientDestinations(),
  );
});

it('preserves the customer workflow for companies without CRM', () => {
  const withoutCrm = clientDestinations().filter(({ moduleId }) => moduleId !== 'demo.crm');
  expect(presentableDemoNavigation(withoutCrm, true)).toEqual(withoutCrm);
});

it.each([
  [false, false],
  [true, true],
])(
  'preserves the legacy destination when CRM cannot be opened (enabled: %s, unavailable: %s)',
  (enabled, unavailable) => {
    const unavailableCrm = clientDestinations(enabled, unavailable);
    expect(presentableDemoNavigation(unavailableCrm, true)).toEqual(unavailableCrm);
  },
);

const crmPages = [
  '/crm/klienti',
  '/crm/k-osloveni',
  '/crm/navstevy',
  '/crm/importy',
  '/crm/parovani',
  '/crm/prehled-prodeju',
  '/crm/schvalovani-ai',
].map((href) => ({ enabled: true, href, moduleId: 'demo.crm' })) as ShellNavigationItem[];

it('keeps wholesale CRM pages only in the wholesale CRM company', () => {
  expect(presentableDemoNavigation(crmPages, false, '71000000-0000-4000-8000-000000000022')).toEqual(crmPages);
  expect(
    presentableDemoNavigation(crmPages, false, '71000000-0000-4000-8000-000000000021').map(({ href }) => href),
  ).toEqual(['/crm/klienti', '/crm/k-osloveni', '/crm/navstevy']);
});

it.each([
  ['71000000-0000-4000-8000-000000000022', ['/crm/schvalovani-ai', '/crm/klienti']],
  ['71000000-0000-4000-8000-000000000020', ['/prodej/schvalovani-ai', '/crm/klienti']],
  ['71000000-0000-4000-8000-000000000021', ['/crm/klienti']],
])('keeps in-module AI approval pages where the company has the agent (legal entity: %s)', (legalEntityId, hrefs) => {
  const pages = [
    { href: '/prodej/schvalovani-ai', moduleId: 'demo.sales-pipeline' },
    { href: '/crm/schvalovani-ai', moduleId: 'demo.crm' },
    { href: '/crm/klienti', moduleId: 'demo.crm' },
  ] as ShellNavigationItem[];
  expect(presentableDemoNavigation(pages, true, legalEntityId).map(({ href }) => href)).toEqual(hrefs);
});

it('keeps one approval inbox: in-module AI approval pages leave the sidebar', () => {
  const pages = [
    { href: '/prodej/schvalovani-ai', moduleId: 'demo.sales-pipeline' },
    { href: '/crm/schvalovani-ai', moduleId: 'demo.crm' },
    { href: '/crm/klienti', moduleId: 'demo.crm' },
  ] as ShellNavigationItem[];
  expect(withoutModuleAiApprovals(pages).map(({ href }) => href)).toEqual(['/crm/klienti']);
});

it('detects in-module AI approval pages', () => {
  expect(hasModuleAiApprovals([{ href: '/prodej/schvalovani-ai' }] as ShellNavigationItem[])).toBe(true);
  expect(hasModuleAiApprovals([{ href: '/crm/schvalovani-ai' }] as ShellNavigationItem[])).toBe(true);
  expect(hasModuleAiApprovals(navigation)).toBe(false);
});

it('appends the platform approval pages only when shown', () => {
  expect(withAgentPlatformNavigation(navigation, false)).toBe(navigation);
  const withPlatform = withAgentPlatformNavigation(navigation, true);
  expect(withPlatform.map(({ href }) => href)).toEqual([
    '/contacts',
    '/sprava/lide',
    '/crm/klienti',
    '/sprava/ke-schvaleni',
    '/sprava/aktivita-agentu',
  ]);
  expect(withPlatform.slice(-2).map(({ label }) => label)).toEqual(['Ke schválení', 'Aktivita agentů']);
});
