import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, rstest, test } from 'effect-rstest';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import LanguageLayout from '../../src/routes/[lang]/layout.tsx';

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Outlet: () => <main>Current route</main>,
}));

afterEach(cleanup);

test('marks every localized Party Registry route with its UI release marker', () => {
  const { container } = render(<LanguageLayout />);

  const root = container.querySelector<HTMLElement>('[data-build-marker]');
  expect(root?.dataset['buildMarker']).toBe(ultramodernUiMarker.build);
  expect(root?.textContent).toBe('Current route');
});
