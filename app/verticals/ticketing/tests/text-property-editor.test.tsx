import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, rs, test } from '@rstest/core';
import { TextPropertyEditor } from '../src/components/text-property-editor';

const mocks = rs.hoisted(() => ({ toastCreate: rs.fn() }));
const propertyLabel = 'Notes';

rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'ticketing.text.backgroundColor': 'Background color',
        'ticketing.text.bold': 'Bold',
        'ticketing.text.code': 'Inline code',
        'ticketing.text.foregroundColor': 'Text color',
        'ticketing.text.italic': 'Italic',
        'ticketing.text.save': 'Save Text',
        'ticketing.text.saveFailedDescription': 'The Text value could not be saved.',
        'ticketing.text.saveFailedTitle': 'Text save failed',
        'ticketing.text.saving': 'Saving Text',
        'ticketing.text.staleDescription':
          'Your rich-text draft is still here. Reload the current value before trying again.',
        'ticketing.text.staleTitle': 'Text changed elsewhere',
        'ticketing.text.strikethrough': 'Strikethrough',
        'ticketing.text.underline': 'Underline',
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

test('unsupported pasted blocks flatten while supported inline formatting is preserved', async () => {
  const save = rs.fn(() =>
    Promise.resolve({
      taskRevision: 2,
      value: {
        document: null,
        propertyDefinitionId: 'property-1',
        readableText: 'Heading\nBold and italic\ncode',
        revision: 2,
      },
    }),
  );
  render(
    <TextPropertyEditor
      collectionId="collection-1"
      document={null}
      label={propertyLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
    />,
  );

  const editor = screen.getByRole('textbox', { name: propertyLabel });
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) =>
        type === 'text/html'
          ? '<h1>Heading</h1><section><strong>Bold</strong> and <em>italic</em></section><pre><code>code</code></pre>'
          : 'Heading\nBold and italic\ncode',
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Text' }));

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    {
      collectionId: 'collection-1',
      document: {
        content: [
          { marks: [], text: 'Heading', type: 'text' },
          { type: 'lineBreak' },
          { marks: [{ type: 'bold' }], text: 'Bold', type: 'text' },
          { marks: [], text: ' and ', type: 'text' },
          { marks: [{ type: 'italic' }], text: 'italic', type: 'text' },
          { type: 'lineBreak' },
          { marks: [{ type: 'code' }], text: 'code', type: 'text' },
        ],
        type: 'textDocument',
      },
      expectedRevision: 1,
      propertyDefinitionId: 'property-1',
      taskId: 'task-1',
    },
    expect.any(String),
  );
});

test('a stale explicit save keeps the rich-text draft and reuses its idempotency key', async () => {
  const staleError = Object.assign(new Error('The Text value changed elsewhere.'), {
    code: 'ticketing.updateTextPropertyValue.stale_or_missing',
    errorTag: 'OperationDomainRejected',
    ok: false,
  });
  const save = rs.fn(() => Promise.reject(staleError));
  render(
    <TextPropertyEditor
      collectionId="collection-1"
      document={null}
      label={propertyLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
    />,
  );

  const editor = screen.getByRole('textbox', { name: propertyLabel });
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) => (type === 'text/html' ? '<strong>Unsaved draft</strong>' : ''),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Text' }));

  await waitFor(() => expect(mocks.toastCreate).toHaveBeenCalledTimes(1));
  expect(editor.textContent).toContain('Unsaved draft');
  expect(mocks.toastCreate).toHaveBeenCalledWith({
    description:
      'Your rich-text draft is still here. Reload the current value before trying again.',
    title: 'Text changed elsewhere',
    type: 'warning',
  });

  fireEvent.click(screen.getByRole('button', { name: 'Save Text' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[0]?.[1]).toBe(save.mock.calls[1]?.[1]);
});

test('a pasted opaque Core Reference remains a reference node when saved', async () => {
  const reference = {
    entityId: 'entity-42',
    entityType: 'customer',
    kind: 'mention',
    lastResolvedLabel: '@Ada',
    ownerModuleKey: 'crm',
    targetTenantId: 'tenant-2',
    token: 'opaque-reference-token',
  } as const;
  const save = rs.fn(() =>
    Promise.resolve({
      taskRevision: 2,
      value: {
        document: null,
        propertyDefinitionId: 'property-1',
        readableText: '@Ada',
        revision: 2,
      },
    }),
  );
  render(
    <TextPropertyEditor
      collectionId="collection-1"
      document={null}
      label={propertyLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
    />,
  );

  const editor = screen.getByRole('textbox', { name: propertyLabel });
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) =>
        type === 'text/html'
          ? `<span data-core-reference='${JSON.stringify(reference)}'>@Ada</span>`
          : '@Ada',
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Text' }));

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[0].document).toEqual({
    content: [{ reference, type: 'reference' }],
    type: 'textDocument',
  });
});
