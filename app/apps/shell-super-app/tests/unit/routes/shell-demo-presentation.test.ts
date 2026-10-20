import { expect, it } from 'effect-rstest';
import type { ShellNavigationItem } from '../../../shared/api.ts';
import { demoDisplayName, presentableDemoNavigation } from '../../../src/routes/shell-demo-presentation.ts';

const navigation = ['/contacts', '/sprava/lide', '/crm/klienti'].map((href) => ({ href })) as ShellNavigationItem[];

it('hides unfinished contacts for everyone and people administration for non-administrators', () => {
  expect(presentableDemoNavigation(navigation, false).map(({ href }) => href)).toEqual(['/crm/klienti']);
  expect(presentableDemoNavigation(navigation, true).map(({ href }) => href)).toEqual(['/sprava/lide', '/crm/klienti']);
});

it.each([
  ['management@siampark.demo', 'Management', 'Vedení'],
  ['operations@siampark.demo', 'Operations', 'Provoz'],
  ['external@siampark.demo', 'External Agent', 'Externí obchodník'],
  ['management@siampark.demo', 'Jana Nováková', 'Jana Nováková'],
  ['other@example.cz', 'Management', 'Management'],
])('presents the Czech fixture name without overwriting personal names (%s)', (email, displayName, expected) => {
  expect(demoDisplayName({ displayName, email })).toBe(expected);
});
