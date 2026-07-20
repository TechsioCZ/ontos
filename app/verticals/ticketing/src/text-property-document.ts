import type { TextDocument } from '../shared/text-property.ts';

const nodeReadableText = (node: TextDocument['content'][number]): string => {
  switch (node.type) {
    case 'text': {
      return node.text;
    }
    case 'lineBreak': {
      return '\n';
    }
    case 'equation': {
      return node.expression;
    }
    case 'reference': {
      return node.reference.lastResolvedLabel;
    }
    default: {
      return '';
    }
  }
};

export const normalizeTextDocument = (
  document: TextDocument | null,
): { readonly document: TextDocument | null; readonly readableText: string | null } => {
  if (document === null) {
    return { document: null, readableText: null };
  }

  const readableText = document.content.map(nodeReadableText).join('');
  const hasSemanticInline = document.content.some(
    (node) => node.type === 'equation' || node.type === 'reference',
  );
  if (!hasSemanticInline && readableText.trim().length === 0) {
    return { document: null, readableText: null };
  }

  return { document, readableText };
};

export const validateTextDocumentReferences = (document: TextDocument | null): boolean =>
  document === null ||
  document.content.every(
    (node) =>
      node.type !== 'reference' ||
      [
        node.reference.entityId,
        node.reference.entityType,
        node.reference.lastResolvedLabel,
        node.reference.ownerModuleKey,
        node.reference.targetTenantId,
        node.reference.token,
      ].every((value) => value.trim().length > 0),
  );
