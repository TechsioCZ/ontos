import type { ESTree } from '@oxlint/plugins';

/** Independent threshold and slice length preserve the differing existing diagnostic budgets. */
export function snippet(
  text: string,
  limit: number,
  sliceLength = limit - 1,
  ellipsis = '…'
): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > limit
    ? `${flat.slice(0, sliceLength)}${ellipsis}`
    : flat;
}
export function sameNode(
  left: ESTree.Node | null | undefined,
  right: ESTree.Node | null | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.type === right.type &&
    left.start === right.start &&
    left.end === right.end
  );
}
/** Default key omits the node kind; typed copies pass their original kind separator (':' or '@'). */
export function nodeKey(node: ESTree.Node, kindSeparator?: ':' | '@'): string {
  const span = `${node.start}:${node.end}`;
  return kindSeparator === undefined
    ? span
    : `${node.type}${kindSeparator}${span}`;
}
/** Use node.start/end directly when null checking is not required. */
export function spanOf(
  node: ESTree.Node | null | undefined
): { readonly start: number; readonly end: number } | null {
  if (!node || typeof node.start !== 'number' || typeof node.end !== 'number')
    return null;
  return { start: node.start, end: node.end };
}
