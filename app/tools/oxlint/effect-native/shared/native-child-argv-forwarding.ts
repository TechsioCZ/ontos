import type { Context, ESTree } from '@oxlint/plugins';
import { isNode, propertyText } from './ast.ts';
import { provenance, valueReference } from './provenance.ts';

const NATIVE_MAKERS = new Set([
  'effect/unstable/process.ChildProcess.make',
  'effect/unstable/process/ChildProcess.make',
]);

/** Native child arguments own their flags. Admit only an untouched argv.slice(2)
 * spread directly into that SDK call's argument array. Other raw argv uses in
 * the same module prevent proving a trivial forwarding adapter.
 */
export function nativeChildArgvForwardingProof(
  context: Context,
  isEntryGuard: (node: ESTree.MemberExpression) => boolean,
): (node: ESTree.MemberExpression) => boolean {
  const isArgv = (node: ESTree.Node) => provenance(context, node) === 'process.argv';
  const directSlice = (member: ESTree.MemberExpression): boolean => {
    if (!isArgv(member.object) || propertyText(member) !== 'slice') return false;
    const slice = member.parent;
    if (
      slice?.type !== 'CallExpression' ||
      slice.callee !== member ||
      slice.arguments.length !== 1 ||
      slice.arguments[0]?.type !== 'Literal' ||
      slice.arguments[0].value !== 2
    )
      return false;
    const spread = slice.parent;
    if (spread?.type !== 'SpreadElement' || spread.argument !== slice) return false;
    const arguments_ = spread.parent;
    if (arguments_?.type !== 'ArrayExpression') return false;
    const make = arguments_.parent;
    return (
      make?.type === 'CallExpression' &&
      make.arguments[1] === arguments_ &&
      NATIVE_MAKERS.has(provenance(context, make.callee) ?? '')
    );
  };
  const allowedUse = (node: ESTree.Node): boolean => {
    const member = node.parent;
    if (member?.type !== 'MemberExpression' || member.object !== node) return false;
    if (directSlice(member)) return true;
    if (!isEntryGuard(member)) return false;
    const use = member.parent;
    return !(
      (use?.type === 'AssignmentExpression' && use.left === member) ||
      use?.type === 'UpdateExpression' ||
      (use?.type === 'UnaryExpression' && use.operator === 'delete')
    );
  };
  let trivial: boolean | undefined;
  const moduleIsTrivial = (): boolean => {
    if (trivial !== undefined) return trivial;
    let visited = 0;
    const visit = (node: ESTree.Node): boolean => {
      if (++visited > 100_000) return false;
      const exported =
        node.type === 'Identifier' && node.parent?.type === 'ExportSpecifier' && node.parent.local === node;
      if (
        (node.type === 'MemberExpression' ||
          (node.type === 'Identifier' && (exported || valueReference(context, node)))) &&
        isArgv(node) &&
        !allowedUse(node)
      )
        return false;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'parent') continue;
        for (const child of Array.isArray(value) ? value : [value]) {
          if (isNode(child) && !visit(child)) return false;
        }
      }
      return true;
    };
    trivial = visit(context.sourceCode.ast);
    return trivial;
  };
  return (member) => directSlice(member) && moduleIsTrivial();
}
