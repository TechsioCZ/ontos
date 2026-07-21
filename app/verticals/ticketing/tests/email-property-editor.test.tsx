import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { EmailPropertyEditor } from '../src/components/email-property-editor';

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.email.activate': 'Write email',
        'ticketing.email.invalid': 'Enter one valid email address.',
        'ticketing.email.saveFailedDescription': 'The Email could not be saved.',
        'ticketing.email.saveFailedTitle': 'Email save failed',
        'ticketing.email.staleDescription':
          'Your Email draft is still here. Reload before trying again.',
        'ticketing.email.staleTitle': 'Email changed elsewhere',
      })[key] ?? key,
  }),
}));

rs.mock('@techsio/ui-kit/molecules/toast', () => ({
  toaster: { create: mocks.toastCreate },
}));

afterEach(() => {
  cleanup();
  mocks.toastCreate.mockClear();
});

test('a reader activates only the percent-encoded recipient without saving or mutating', () => {
  const save = rs.fn();
  const label = 'Contact email';
  render(
    <EmailPropertyEditor
      collectionId="collection-1"
      label={label}
      onSave={save}
      propertyDefinitionId="property-1"
      readOnly
      revision={1}
      taskId="task-1"
      value="O'Hara!+tag@Example.com"
    />,
  );

  expect(
    screen.getByRole<HTMLAnchorElement>('link', { name: 'Write email' }).getAttribute('href'),
  ).toBe('mailto:O%27Hara%21%2Btag%40Example.com');
  expect(save).not.toHaveBeenCalled();
});

test('an invalid Email draft remains visible with inline feedback and is not submitted', () => {
  const save = rs.fn();
  const label = 'Contact email';
  render(
    <EmailPropertyEditor
      collectionId="collection-1"
      label={label}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
      value="valid@example.com"
    />,
  );

  const input = screen.getByRole('textbox', { name: 'Contact email' });
  fireEvent.change(input, { target: { value: 'invalid address' } });
  fireEvent.blur(input);

  expect((input as HTMLInputElement).value).toBe('invalid address');
  expect(screen.getByText('Enter one valid email address.')).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});
