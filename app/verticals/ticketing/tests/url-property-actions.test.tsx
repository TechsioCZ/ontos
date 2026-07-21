import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { UrlPropertyActions } from '../src/components/url-property-actions';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.url.copy': 'Copy URL',
        'ticketing.url.open': 'Open URL',
      })[key] ?? key,
  }),
}));

const writeText = rs.fn(() => Promise.resolve());

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText },
});

afterEach(() => {
  cleanup();
  writeText.mockClear();
});

test('open and copy expose the exact stored URL without mutating or probing it', async () => {
  const value = 'HTTPS://Example.com/%7EExact?Q=One#Part';
  render(<UrlPropertyActions value={value} />);

  const open = screen.getByRole('link', { name: 'Open URL' });
  expect(open.getAttribute('href')).toBe(value);
  expect(open.getAttribute('target')).toBe('_blank');
  expect(open.getAttribute('rel')?.split(' ').toSorted()).toEqual(['noopener', 'noreferrer']);

  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(value));
  expect(writeText).toHaveBeenCalledTimes(1);
});

test('Empty URL values offer no open or copy actions', () => {
  const { container } = render(<UrlPropertyActions value={null} />);
  expect(container.childElementCount).toBe(0);
});
