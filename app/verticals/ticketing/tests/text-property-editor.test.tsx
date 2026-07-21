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
        'ticketing.text.equation': 'Equation',
        'ticketing.text.foregroundColor': 'Text color',
        'ticketing.text.insertEquation': 'Insert equation',
        'ticketing.text.italic': 'Italic',
        'ticketing.text.link': 'Link URL',
        'ticketing.text.linkApply': 'Apply link',
        'ticketing.text.referenceDeniedDescription':
          'The owning app denied access. The reference was not changed.',
        'ticketing.text.referenceDeniedTitle': 'Reference access denied',
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
          ? '<h1>Heading</h1><section><strong>Bold</strong> and <em>italic</em> <span style="font-weight: 700; font-style: italic; text-decoration: underline line-through">styled</span></section><pre><code>code</code></pre>'
          : 'Heading\nBold and italic styled\ncode',
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
          { marks: [], text: ' ', type: 'text' },
          {
            marks: [
              { type: 'bold' },
              { type: 'italic' },
              { type: 'underline' },
              { type: 'strikethrough' },
            ],
            text: 'styled',
            type: 'text',
          },
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

test('the visible label names the rich editor and equations have an inline insertion affordance', async () => {
  const save = rs.fn(() =>
    Promise.resolve({
      taskRevision: 2,
      value: {
        document: null,
        propertyDefinitionId: 'property-1',
        readableText: 'x² + y²',
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
  const visibleLabel = screen.getByText(propertyLabel);
  expect(editor.getAttribute('aria-labelledby')).toBe(visibleLabel.id);
  expect(screen.getByRole('textbox', { name: 'Link URL' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Apply link' })).toBeDefined();

  fireEvent.change(screen.getByRole('textbox', { name: 'Equation' }), {
    target: { value: 'x² + y²' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Insert equation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Text' }));

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[0].document).toEqual({
    content: [{ expression: 'x² + y²', type: 'equation' }],
    type: 'textDocument',
  });
});

test('inline code and hyperlink controls preserve selected text as inline marks', async () => {
  const save = rs.fn(() =>
    Promise.resolve({
      taskRevision: 2,
      value: {
        document: null,
        propertyDefinitionId: 'property-1',
        readableText: 'Docs',
        revision: 2,
      },
    }),
  );
  render(
    <TextPropertyEditor
      collectionId="collection-1"
      document={{
        content: [{ marks: [], text: 'Docs', type: 'text' }],
        type: 'textDocument',
      }}
      label={propertyLabel}
      onSave={save}
      propertyDefinitionId="property-1"
      revision={1}
      taskId="task-1"
    />,
  );

  const editor = screen.getByRole('textbox', { name: propertyLabel });
  const selectEditorText = () => {
    const textNode = globalThis.document.createTreeWalker(editor, NodeFilter.SHOW_TEXT).nextNode();
    expect(textNode).not.toBeNull();
    const range = globalThis.document.createRange();
    range.selectNodeContents(textNode as Node);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  selectEditorText();
  fireEvent.click(screen.getByRole('button', { name: 'Inline code' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Link URL' }), {
    target: { value: 'https://example.com/docs' },
  });
  selectEditorText();
  fireEvent.click(screen.getByRole('button', { name: 'Apply link' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Text' }));

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[0].document).toEqual({
    content: [
      {
        marks: [{ type: 'code' }, { href: 'https://example.com/docs', type: 'link' }],
        text: 'Docs',
        type: 'text',
      },
    ],
    type: 'textDocument',
  });
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

test('a resolved reference refreshes its clickable label and authorizes every open attempt', async () => {
  const reference = {
    entityId: 'entity-42',
    entityType: 'customer',
    kind: 'mention',
    lastResolvedLabel: '@Ada',
    ownerModuleKey: 'crm',
    targetTenantId: 'tenant-2',
    token: 'opaque-reference-token',
  } as const;
  const resolveReference = rs.fn(() =>
    Promise.resolve({
      _tag: 'CoreReferenceActive' as const,
      reference: { ...reference, lastResolvedLabel: '@Ada Lovelace' },
    }),
  );
  const openReference = rs.fn(() => Promise.resolve({ _tag: 'CoreReferenceOpenDenied' as const }));
  render(
    <TextPropertyEditor
      collectionId="collection-1"
      document={{ content: [{ reference, type: 'reference' }], type: 'textDocument' }}
      label={propertyLabel}
      onOpenReference={openReference}
      onResolveReference={resolveReference}
      onSave={rs.fn()}
      propertyDefinitionId="property-1"
      readOnly
      revision={1}
      taskId="task-1"
    />,
  );

  const activeReference = await screen.findByRole('button', { name: '@Ada Lovelace' });
  expect(resolveReference).toHaveBeenCalledWith(reference);
  fireEvent.click(activeReference);
  fireEvent.click(activeReference);

  await waitFor(() => expect(openReference).toHaveBeenCalledTimes(2));
  expect(openReference).toHaveBeenNthCalledWith(1, reference);
  expect(openReference).toHaveBeenNthCalledWith(2, reference);
  expect(screen.getByRole('button', { name: '@Ada Lovelace' })).toBeDefined();
  expect(mocks.toastCreate).toHaveBeenCalledTimes(2);
  expect(mocks.toastCreate).toHaveBeenLastCalledWith({
    description: 'The owning app denied access. The reference was not changed.',
    title: 'Reference access denied',
    type: 'warning',
  });
});
