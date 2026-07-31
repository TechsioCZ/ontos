import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import Layout from '../../src/routes/layout';

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Outlet: () => <main>Current route</main>,
}));

afterEach(() => {
  cleanup();
});

test('leaves route content free of global user-perceivable UI', () => {
  render(<Layout />);

  expect(screen.getByRole('main').textContent).toBe('Current route');
  expect(screen.queryByRole('region')).toBeNull();
  expect(document.body.textContent?.trim()).toBe('Current route');
});
