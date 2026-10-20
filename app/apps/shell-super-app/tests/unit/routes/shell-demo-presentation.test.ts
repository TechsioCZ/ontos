import { expect, it } from 'effect-rstest';
import type { ShellNavigationItem } from '../../../shared/api.ts';
import { demoDisplayName, presentableDemoNavigation } from '../../../src/routes/shell-demo-presentation.ts';

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

it.each([
  ['management@siampark.demo', 'Management', 'Vedení'],
  ['operations@siampark.demo', 'Operations', 'Provoz'],
  ['external@siampark.demo', 'External Agent', 'Externí obchodník'],
  ['management@siampark.demo', 'Jana Nováková', 'Jana Nováková'],
  ['other@example.cz', 'Management', 'Management'],
])('presents the Czech fixture name without overwriting personal names (%s)', (email, displayName, expected) => {
  expect(demoDisplayName({ displayName, email })).toBe(expected);
});
