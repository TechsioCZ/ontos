import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { TextPropertyDuplication } from '../src/components/text-property-duplication';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string, options?: { readonly name?: string }) =>
      ({
        'ticketing.text.duplicate': `Duplicate ${options?.name ?? 'Text'}`,
        'ticketing.text.duplicateConfirm': 'Confirm duplication',
        'ticketing.text.duplicateDescription':
          'The duplicate keeps Mandatory configuration and starts Empty.',
        'ticketing.text.duplicateFailedDescription': 'The Text property could not be duplicated.',
        'ticketing.text.duplicateFailedTitle': 'Text duplication failed',
        'ticketing.text.duplicating': 'Duplicating Text property',
      })[key] ?? key,
  }),
}));

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));
const propertyLabel = 'Notes';

rs.mock('@techsio/ui-kit/molecules/toast', () => ({
  toaster: { create: mocks.toastCreate },
}));

afterEach(() => {
  cleanup();
  mocks.toastCreate.mockClear();
});

test('Text duplication confirms without exposing a copy-values choice', async () => {
  const confirm = rs.fn(() => Promise.resolve());
  render(
    <TextPropertyDuplication
      collectionId="collection-1"
      label={propertyLabel}
      onConfirm={confirm}
      propertyDefinitionId="property-1"
      revision={2}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Duplicate Notes' }));
  expect(screen.queryByText(/copy values/iu)).toBeNull();
  expect(
    await screen.findByText('The duplicate keeps Mandatory configuration and starts Empty.'),
  ).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm duplication' }));

  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(confirm).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      expectedRevision: 2,
      propertyDefinitionId: 'property-1',
    },
    expect.any(String),
  );
});
