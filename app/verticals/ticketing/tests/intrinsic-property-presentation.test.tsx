import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from '@rstest/core';
import { CreatedTimePresentation } from '../src/components/intrinsic-property-presentation';

afterEach(cleanup);

test('Created time shows minutes in standard view and seconds in detail', () => {
  const instant = '2026-07-21T10:15:30.123Z';
  const { container, rerender } = render(
    <CreatedTimePresentation
      detail={false}
      instant={instant}
      locale="en-GB"
      timeZone="Europe/Prague"
    />,
  );

  const standard = container.querySelector('time');
  expect(standard).not.toBeNull();
  expect(standard?.textContent).toContain('12:15');
  expect(standard?.textContent).not.toContain('12:15:30');
  expect(standard?.getAttribute('datetime')).toBe(instant);

  rerender(
    <CreatedTimePresentation detail instant={instant} locale="en-GB" timeZone="Europe/Prague" />,
  );
  expect(container.querySelector('time')?.textContent).toContain('12:15:30');
});
