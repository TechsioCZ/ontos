import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { StatusOptionColorEditor } from '../src/components/status-option-color-editor';

afterEach(cleanup);

test('Status color editing delegates application colors to single-selection ColorSelect', () => {
  const onColorChange = rs.fn();

  render(
    <StatusOptionColorEditor
      availableColors={[
        { color: 'amber', label: 'Amber' },
        { color: 'violet', label: 'Violet' },
      ]}
      currentColor="amber"
      onColorChange={onColorChange}
    />,
  );

  expect(
    screen.getByRole('radio', { name: 'Select color Amber' }).getAttribute('aria-checked'),
  ).toBe('true');
  const violet = screen.getByRole('radio', { name: 'Select color Violet' });
  expect(violet.getAttribute('aria-checked')).toBe('false');

  fireEvent.click(violet);
  expect(onColorChange).toHaveBeenCalledWith('violet');
});

test('read-only Status color presentation cannot trigger a change', () => {
  const onColorChange = rs.fn();

  render(
    <StatusOptionColorEditor
      availableColors={[{ color: 'amber', label: 'Amber' }]}
      currentColor="amber"
      onColorChange={onColorChange}
      readOnly
    />,
  );

  fireEvent.click(screen.getByRole('radio', { name: 'Select color Amber' }));
  expect(onColorChange).not.toHaveBeenCalled();
});
