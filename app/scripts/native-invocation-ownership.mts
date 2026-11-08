import type { ModuleGraph, SourceModule } from '@modern-js/code-tools/microvertical-api-boundary';
import { getBindingIdentifiers, isFunction, traverseFast } from '@babel/types';
import type { Node } from '@babel/types';

interface InvocationContext {
  readonly graph: ModuleGraph;
  readonly module: SourceModule;
}

const contains = (outer: Node | undefined, inner: Node): boolean =>
  outer !== undefined &&
  outer.start !== null &&
  outer.start !== undefined &&
  outer.end !== null &&
  outer.end !== undefined &&
  inner.start !== null &&
  inner.start !== undefined &&
  inner.end !== null &&
  inner.end !== undefined &&
  outer.start <= inner.start &&
  outer.end >= inner.end;

const enclosing = (
  { module }: InvocationContext,
  node: Node,
  accepts: (candidate: Node) => boolean,
): Node | undefined => {
  let owner: Node | undefined;
  let smallest = Number.POSITIVE_INFINITY;
  traverseFast(module.file, (candidate) => {
    if (
      !accepts(candidate) ||
      !contains(candidate, node) ||
      candidate.start === null ||
      candidate.start === undefined ||
      candidate.end === null ||
      candidate.end === undefined
    ) {
      return;
    }
    const width = candidate.end - candidate.start;
    if (width < smallest) {
      owner = candidate;
      smallest = width;
    }
  });
  return owner;
};

const isFreshDataAllocation = ({ graph, module }: InvocationContext, expression: Node): boolean =>
  expression.type === 'ArrayExpression' ||
  expression.type === 'ObjectExpression' ||
  (expression.type === 'NewExpression' &&
    expression.callee.type === 'Identifier' &&
    expression.callee.name === 'Set' &&
    graph.isUnboundReference(module, expression.callee));

const bindingSites = (routine: Node, name: string): ReadonlySet<Node> => {
  const sites = new Set<Node>();
  traverseFast(routine, (node) => {
    if (
      isFunction(node) ||
      node.type === 'VariableDeclarator' ||
      node.type === 'CatchClause' ||
      node.type === 'ClassDeclaration'
    ) {
      const binding = getBindingIdentifiers(node)[name];
      if (binding !== undefined) {
        sites.add(binding);
      }
    }
  });
  return sites;
};

const isLocalAllocation = (context: InvocationContext, expression: Node, routine: Node, mutation: Node): boolean => {
  const block = enclosing(context, expression, (node) => node.type === 'BlockStatement');
  return (
    isFreshDataAllocation(context, expression) &&
    enclosing(context, expression, isFunction) === routine &&
    contains(block, mutation) &&
    expression.end !== null &&
    expression.end !== undefined &&
    mutation.start !== null &&
    mutation.start !== undefined &&
    expression.end <= mutation.start
  );
};

/**
 * A unique const data allocation in this invocation's containing block. Write targets are not read references in
 * the native graph, so use compiler binding identifiers and lexical scopes; ambiguous or borrowed bindings fail.
 */
export const hasInvocationOwnedData = (context: InvocationContext, receiver: Node, mutation: Node): boolean => {
  if (receiver.type !== 'Identifier') {
    return false;
  }
  const routine = enclosing(context, mutation, isFunction);
  if (routine === undefined || bindingSites(routine, receiver.name).size !== 1) {
    return false;
  }
  let allocated = false;
  traverseFast(routine, (node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') {
      return;
    }
    for (const declaration of node.declarations) {
      if (
        declaration.id.type === 'Identifier' &&
        declaration.id.name === receiver.name &&
        declaration.init !== null &&
        declaration.init !== undefined &&
        isLocalAllocation(context, declaration.init, routine, mutation)
      ) {
        allocated = true;
      }
    }
  });
  return allocated;
};
