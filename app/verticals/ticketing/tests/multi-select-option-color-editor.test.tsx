import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { MultiSelectOptionColorEditor } from '../src/components/select-option-color-editor';

afterEach(cleanup);

test('Multi-select reuses the established ColorSelect editor with application-configured colors', () => {
  const onColorChange = rs.fn();

  render(
    <MultiSelectOptionColorEditor
      availableColors={[
        { color: 'purple', label: 'Purple' },
        { color: 'orange', label: 'Orange' },
      ]}
      currentColor="purple"
      onColorChange={onColorChange}
    />,
  );

  const purple = screen.getByRole('radio', { name: 'Select color Purple' });
  const orange = screen.getByRole('radio', { name: 'Select color Orange' });
  expect(purple.getAttribute('aria-checked')).toBe('true');
  expect(orange.getAttribute('aria-checked')).toBe('false');

  fireEvent.click(orange);
  expect(onColorChange).toHaveBeenCalledWith('orange');
});

test('a read-only Multi-select viewer cannot edit an option color', () => {
  const onColorChange = rs.fn();

  render(
    <MultiSelectOptionColorEditor
      availableColors={[{ color: 'purple', label: 'Purple' }]}
      currentColor="purple"
      onColorChange={onColorChange}
      readOnly
    />,
  );

  fireEvent.click(screen.getByRole('radio', { name: 'Select color Purple' }));
  expect(onColorChange).not.toHaveBeenCalled();
});
