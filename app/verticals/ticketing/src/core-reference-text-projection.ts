// @effect-diagnostics asyncFunction:off
import { coreReferenceRegistry } from '@app/core-runtime';
import type { CoreReferenceContext } from '@app/core-runtime';
import type { TextDocument } from '../shared/text-property.ts';
import { normalizeTextDocument } from './text-property-document.ts';

export const resolveTextDocumentProjection = async ({
  context,
  document,
}: {
  readonly context: CoreReferenceContext;
  readonly document: TextDocument | null;
}): Promise<{ readonly document: TextDocument | null; readonly readableText: string | null }> => {
  if (document === null) {
    return { document: null, readableText: null };
  }
  const resolvedDocument: TextDocument = {
    ...document,
    content: await Promise.all(
      document.content.map(async (node) => {
        if (node.type !== 'reference') {
          return node;
        }
        const resolution = await coreReferenceRegistry.resolve({
          context,
          reference: node.reference,
        });
        return { ...node, reference: resolution.reference };
      }),
    ),
  };
  return normalizeTextDocument(resolvedDocument);
};
