import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import Layout from '../../src/routes/layout';

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Outlet: () => <main>Current route</main>,
}));

afterEach(() => {
  cleanup();
  toaster.remove();
});

test('mounts one global Toast host beside the active route', () => {
  render(<Layout />);

  toaster.create({
    description: 'Toast details',
    title: 'Toast title',
    type: 'error',
  });

  expect(screen.getAllByRole('region')).toHaveLength(1);
  return screen.findByText('Toast title').then((title) => {
    expect(title).toBeTruthy();
    expect(screen.getByText('Toast details')).toBeTruthy();
  });
});
