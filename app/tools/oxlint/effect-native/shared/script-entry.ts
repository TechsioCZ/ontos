import type { Context, ESTree } from '@oxlint/plugins';

import {
  FUNCTION_TYPES,
  nearestFunction as nearest,
  parentOf,
  skipWrappers,
  type Syntax,
} from './ast.ts';
import { resolveVariable } from './bindings.ts';

const ENTRY_FUNCTION_TYPES = new Set([...FUNCTION_TYPES, 'StaticBlock']);

/** Script entry rules treat a static block as a function boundary, unlike generator walkers. */
export function nearestFunction(node: ESTree.Node): Syntax | null {
  return nearest(node, ENTRY_FUNCTION_TYPES);
}
export function isTopLevel(node: ESTree.Node): boolean {
  return nearestFunction(node) === null;
}
function isProgramLevelStatement(node: ESTree.Node): boolean {
  const parent = parentOf(node);
  if (parent?.type === 'Program') return true;
  if (
    parent?.type !== 'ExportNamedDeclaration' &&
    parent?.type !== 'ExportDefaultDeclaration'
  )
    return false;
  return parentOf(parent)?.type === 'Program';
}
function programDeclarator(fn: ESTree.Node): ESTree.VariableDeclarator | null {
  const declarator = parentOf(fn);
  if (declarator?.type !== 'VariableDeclarator' || declarator.init !== fn)
    return null;
  const declaration = parentOf(declarator);
  return declaration?.type === 'VariableDeclaration' &&
    isProgramLevelStatement(declaration)
    ? declarator
    : null;
}
export function programLevelFunctionName(fn: ESTree.Node): string | null {
  if (fn.type === 'FunctionDeclaration')
    return isProgramLevelStatement(fn) ? (fn.id?.name ?? null) : null;
  if (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression')
    return null;
  const declarator = programDeclarator(fn);
  return declarator?.id.type === 'Identifier' ? declarator.id.name : null;
}
function isTopLevelImmediatelyInvoked(fn: ESTree.Node): boolean {
  const { node, parent } = skipWrappers(fn);
  return (
    parent?.type === 'CallExpression' &&
    parent.callee === node &&
    isTopLevel(parent)
  );
}
function isOnlyCalledFromTopLevel(
  context: Context,
  fn: ESTree.Node,
  name: string
): boolean {
  const variable = resolveVariable(context, name, fn);
  if (!variable) return false;
  const offsets = new Set(
    variable.identifiers.map((identifier) => identifier.start)
  );
  const uses = variable.references.filter(
    (reference) =>
      reference.init !== true && !offsets.has(reference.identifier.start)
  );
  return (
    uses.length > 0 &&
    uses.every((reference) =>
      isTopLevelImmediatelyInvoked(reference.identifier)
    )
  );
}
/** Module evaluation, top-level IIFEs, or named Program functions used only by top-level calls. */
export function isEntryPosition(context: Context, site: ESTree.Node): boolean {
  const fn = nearestFunction(site);
  if (!fn) return true;
  if (nearestFunction(fn)) return false;
  if (isTopLevelImmediatelyInvoked(fn)) return true;
  const name = programLevelFunctionName(fn);
  return name !== null && isOnlyCalledFromTopLevel(context, fn, name);
}
