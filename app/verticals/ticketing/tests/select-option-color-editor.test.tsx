import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { SelectOptionColorEditor } from '../src/components/select-option-color-editor';

afterEach(cleanup);

test('an authorized editor changes an option color through single-selection ColorSelect', () => {
  const onColorChange = rs.fn();

  render(
    <SelectOptionColorEditor
      availableColors={[
        { color: 'red', label: 'Red' },
        { color: 'blue', label: 'Blue' },
      ]}
      currentColor="red"
      onColorChange={onColorChange}
    />,
  );

  const red = screen.getByRole('radio', { name: 'Select color Red' });
  const blue = screen.getByRole('radio', { name: 'Select color Blue' });
  expect(red.getAttribute('aria-checked')).toBe('true');
  expect(blue.getAttribute('aria-checked')).toBe('false');

  fireEvent.click(blue);
  expect(onColorChange).toHaveBeenCalledWith('blue');
});

test('a read-only viewer cannot change an option color', () => {
  const onColorChange = rs.fn();

  render(
    <SelectOptionColorEditor
      availableColors={[{ color: 'red', label: 'Red' }]}
      currentColor="red"
      onColorChange={onColorChange}
      readOnly
    />,
  );

  fireEvent.click(screen.getByRole('radio', { name: 'Select color Red' }));
  expect(onColorChange).not.toHaveBeenCalled();
});
