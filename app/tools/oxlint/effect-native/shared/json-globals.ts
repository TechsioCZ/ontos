import type { Context, ESTree } from '@oxlint/plugins';

import { isUnshadowedGlobal } from './bindings.ts';

interface JsonHostOptions {
  readonly containers: ReadonlySet<string>;
  readonly unwrap: (node: ESTree.Node) => ESTree.Node;
  readonly memberName: (node: ESTree.MemberExpression) => string | null;
}

/** Preserve each JSON rule's supported wrappers, keys, and global containers. */
export function isJsonHost(context: Context, node: ESTree.Node, options: JsonHostOptions): boolean {
  const host = options.unwrap(node);
  if (host.type === 'Identifier') return isUnshadowedGlobal(context, host, 'JSON', true);
  if (host.type !== 'MemberExpression' || options.memberName(host) !== 'JSON') return false;
  const container = options.unwrap(host.object);
  return (
    container.type === 'Identifier' &&
    options.containers.has(container.name) &&
    isUnshadowedGlobal(context, container, container.name, true)
  );
}

/** JSON diagnostics retain their original 72-character budget and ASCII suffix. */
export function jsonExpressionSnippet(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 72 ? `${flat.slice(0, 69)}...` : flat;
}
