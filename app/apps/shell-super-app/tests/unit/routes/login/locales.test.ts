import { expect, test } from '@rstest/core';
import cs from '../../../../locales/cs/shell.json';
import en from '../../../../locales/en/shell.json';
import { ultramodernRouteMetadata } from '../../../../src/routes/ultramodern-route-metadata';

test('keeps the Czech and English login translation contracts aligned', () => {
  expect(Object.keys(cs.shell.login).toSorted()).toEqual(Object.keys(en.shell.login).toSorted());
  expect(Object.keys(cs.shell.login.field).toSorted()).toEqual(
    Object.keys(en.shell.login.field).toSorted(),
  );
  expect(Object.keys(cs.shell.login.required).toSorted()).toEqual(
    Object.keys(en.shell.login.required).toSorted(),
  );
  expect(Object.keys(cs.shell.login.toast).toSorted()).toEqual(
    Object.keys(en.shell.login.toast).toSorted(),
  );
  expect(en.shell.login.submit).toBe('Login');
});

test('includes the login route in the generated metadata manifest', () => {
  expect(ultramodernRouteMetadata).toContainEqual(
    expect.objectContaining({
      canonicalPath: '/login',
      descriptionKey: 'shell.login.seo.description',
      id: 'shell-login',
      titleKey: 'shell.login.title',
    }),
  );
});

test('keeps the Czech and English active-module translation contracts aligned', () => {
  expect(Object.keys(cs.shell.modules).toSorted()).toEqual(
    Object.keys(en.shell.modules).toSorted(),
  );
  expect(Object.keys(cs.shell.modules.active).toSorted()).toEqual(
    Object.keys(en.shell.modules.active).toSorted(),
  );
  expect(Object.keys(cs.shell.modules.state).toSorted()).toEqual(
    Object.keys(en.shell.modules.state).toSorted(),
  );
  expect(en.shell.modules.state.active).toBe('Active');
  expect(cs.shell.modules.state.active).toBe('Aktivní');
});

test('keeps the exact Czech and English dashboard translation contracts aligned', () => {
  expect(Object.keys(cs.shell.dashboard).toSorted()).toEqual(
    Object.keys(en.shell.dashboard).toSorted(),
  );
  expect(Object.keys(cs.shell.dashboard.account).toSorted()).toEqual(
    Object.keys(en.shell.dashboard.account).toSorted(),
  );
  expect(Object.keys(cs.shell.dashboard.header).toSorted()).toEqual(
    Object.keys(en.shell.dashboard.header).toSorted(),
  );
  expect(Object.keys(cs.shell.dashboard.home).toSorted()).toEqual(
    Object.keys(en.shell.dashboard.home).toSorted(),
  );
  expect(Object.keys(cs.shell.dashboard.navigation).toSorted()).toEqual(
    Object.keys(en.shell.dashboard.navigation).toSorted(),
  );
  expect(Object.keys(cs.shell.dashboard.sidebar).toSorted()).toEqual(
    Object.keys(en.shell.dashboard.sidebar).toSorted(),
  );
  expect(Object.keys(cs.shell.dashboard.tenant).toSorted()).toEqual(
    Object.keys(en.shell.dashboard.tenant).toSorted(),
  );
  expect(Object.keys(en.shell.dashboard.tenant).toSorted()).toEqual([
    'accessibleLabel',
    'failed',
    'pending',
    'unavailable',
  ]);
  expect(en.shell.dashboard.home.title).toBe('Home');
  expect(cs.shell.dashboard.home.title).toBe('Domů');
});
