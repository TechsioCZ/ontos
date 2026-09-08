import { expect, test } from '@rstest/core';

import cs from '../../../../locales/cs/shell.json';
import en from '../../../../locales/en/shell.json';
import { ultramodernRouteMetadata } from '../../../../src/routes/ultramodern-route-metadata';

test.each([
  ['login', cs.shell.login, en.shell.login],
  ['login.field', cs.shell.login.field, en.shell.login.field],
  ['login.required', cs.shell.login.required, en.shell.login.required],
  ['login.toast', cs.shell.login.toast, en.shell.login.toast],
  ['modules', cs.shell.modules, en.shell.modules],
  ['modules.active', cs.shell.modules.active, en.shell.modules.active],
  ['modules.state', cs.shell.modules.state, en.shell.modules.state],
  ['dashboard', cs.shell.dashboard, en.shell.dashboard],
  ['dashboard.account', cs.shell.dashboard.account, en.shell.dashboard.account],
  ['dashboard.header', cs.shell.dashboard.header, en.shell.dashboard.header],
  ['dashboard.home', cs.shell.dashboard.home, en.shell.dashboard.home],
  [
    'dashboard.navigation',
    cs.shell.dashboard.navigation,
    en.shell.dashboard.navigation,
  ],
  ['dashboard.sidebar', cs.shell.dashboard.sidebar, en.shell.dashboard.sidebar],
  ['dashboard.tenant', cs.shell.dashboard.tenant, en.shell.dashboard.tenant],
])('aligns Czech and English %s translation keys', (_name, czech, english) => {
  expect(Object.keys(czech).toSorted()).toEqual(
    Object.keys(english).toSorted()
  );
});

test('keeps the Czech and English login translation contracts aligned', () => {
  expect(en.shell.login.submit).toBe('Login');
});

test('includes the login route in the generated metadata manifest', () => {
  expect(ultramodernRouteMetadata).toContainEqual(
    expect.objectContaining({
      canonicalPath: '/login',
      descriptionKey: 'shell.login.seo.description',
      id: 'shell-login',
      titleKey: 'shell.login.title',
    })
  );
});

test('keeps the Czech and English active-module translation contracts aligned', () => {
  expect(en.shell.modules.state.active).toBe('Active');
  expect(cs.shell.modules.state.active).toBe('Aktivní');
});

test('keeps the exact Czech and English dashboard translation contracts aligned', () => {
  expect(Object.keys(en.shell.dashboard.tenant).toSorted()).toEqual([
    'accessibleLabel',
    'failed',
    'pending',
    'unavailable',
  ]);
  expect(en.shell.dashboard.home.title).toBe('Home');
  expect(cs.shell.dashboard.home.title).toBe('Domů');
});
