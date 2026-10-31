import { expect, test } from 'effect-rstest';

import cs from '../../../../locales/cs/shell.json';
import en from '../../../../locales/en/shell.json';
import { ultramodernRouteMetadata } from '../../../../src/routes/ultramodern-route-metadata';

test.each([['profile', cs.shell.profile, en.shell.profile]])(
  'aligns Czech and English %s translation keys',
  (_name, czech, english) => {
    expect(Object.keys(czech).toSorted()).toEqual(Object.keys(english).toSorted());
  },
);

test('includes the profile route in the generated metadata manifest', () => {
  expect(ultramodernRouteMetadata).toContainEqual(
    expect.objectContaining({
      canonicalPath: '/profile',
      id: 'shell-profile',
      titleKey: 'shell.profile.title',
    }),
  );
});
