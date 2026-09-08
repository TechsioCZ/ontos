import type { ESTree } from '@oxlint/plugins';

/** Recognize field-bag arguments, including curried Schema constructors. */
export function isSchemaConstructorArgument(
  node: ESTree.Node,
  resolveMember: (node: ESTree.Node) => string | null,
  constructors: ReadonlySet<string>,
  unwrap: (node: ESTree.Node) => ESTree.Node
): boolean {
  const parent = node.parent;
  if (
    parent === null ||
    parent === undefined ||
    parent.type !== 'CallExpression'
  )
    return false;
  if (!parent.arguments.some((argument) => argument === node)) return false;
  return isConstructorCallee(
    parent.callee,
    resolveMember,
    constructors,
    unwrap
  );
}

function isConstructorCallee(
  node: ESTree.Node,
  resolveMember: (node: ESTree.Node) => string | null,
  constructors: ReadonlySet<string>,
  unwrap: (node: ESTree.Node) => ESTree.Node
): boolean {
  let callee = unwrap(node);
  for (let depth = 0; depth < 8; depth += 1) {
    const member = resolveMember(callee);
    if (member !== null) return constructors.has(member);
    if (callee.type !== 'CallExpression') return false;
    callee = unwrap(callee.callee);
  }
  return false;
}
