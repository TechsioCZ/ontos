import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { UrlPropertyActions } from '../src/components/url-property-actions';
import { UrlPropertyEditor } from '../src/components/url-property-editor';

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.url.copy': 'Copy URL',
        'ticketing.url.invalid': 'Enter one absolute HTTP or HTTPS URL.',
        'ticketing.url.open': 'Open URL',
        'ticketing.url.save': 'Save URL',
        'ticketing.url.saveFailedDescription': 'The URL could not be saved.',
        'ticketing.url.saveFailedTitle': 'URL save failed',
        'ticketing.url.staleDescription': 'Your URL draft is still here. Reload before retrying.',
        'ticketing.url.staleTitle': 'URL changed elsewhere',
      })[key] ?? key,
  }),
}));

rs.mock('@techsio/ui-kit/molecules/toast', () => ({
  toaster: { create: mocks.toastCreate },
}));

const writeText = rs.fn(() => Promise.resolve());

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText },
});

afterEach(() => {
  cleanup();
  mocks.toastCreate.mockClear();
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

test('the URL editor validates on blur and preserves a stale exact draft', async () => {
  const label = 'Reference URL';
  const stale = Object.assign(new Error('The URL changed elsewhere.'), {
    code: 'ticketing.updateUrlPropertyValue.stale_or_missing',
  });
  const save = rs.fn(() => Promise.reject(stale));
  render(
    <UrlPropertyEditor
      collectionId="collection-1"
      label={label}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
      value="https://example.com/original"
    />,
  );

  const input = screen.getByRole('textbox', { name: label });
  fireEvent.change(input, { target: { value: 'not a URL' } });
  fireEvent.blur(input);
  expect(screen.getByText('Enter one absolute HTTP or HTTPS URL.')).toBeTruthy();
  expect(save).not.toHaveBeenCalled();

  const draft = 'HTTPS://Example.com/%7EExact';
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.click(screen.getByRole('button', { name: 'Save URL' }));

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 1,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
      value: draft,
    },
    expect.any(String),
  );
  expect((input as HTMLInputElement).value).toBe(draft);
  expect(mocks.toastCreate).toHaveBeenCalledWith({
    description: 'Your URL draft is still here. Reload before retrying.',
    title: 'URL changed elsewhere',
    type: 'warning',
  });
});
