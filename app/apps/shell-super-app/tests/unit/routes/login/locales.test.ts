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
