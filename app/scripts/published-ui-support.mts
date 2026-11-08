import type { createModuleGraph, SourceModule } from '@modern-js/code-tools/microvertical-api-boundary';
import { isFunction, traverseFast } from '@babel/types';
import type { Node } from '@babel/types';

interface UiSupportSelection {
  readonly artifact: SourceModule;
  readonly graph: ReturnType<typeof createModuleGraph>;
  readonly selected: { readonly expression: Node; readonly module: SourceModule };
}

const exportedNames = (module: SourceModule): readonly string[] =>
  module.file.program.body.flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration') {
      return [];
    }
    const { declaration } = statement;
    if (declaration?.type === 'VariableDeclaration') {
      return declaration.declarations.flatMap((value) => (value.id.type === 'Identifier' ? [value.id.name] : []));
    }
    return declaration?.type === 'FunctionDeclaration' && declaration.id !== null && declaration.id !== undefined
      ? [declaration.id.name]
      : [];
  });

const hasUiImplementation = (graph: UiSupportSelection['graph'], module: SourceModule, expression: Node): boolean => {
  let ui = false;
  traverseFast(expression, (node) => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      ui = true;
    }
    if (
      node.type === 'CallExpression' &&
      graph
        .evaluate(module, node.callee)
        .some(
          (value) =>
            value.kind === 'external' &&
            value.specifier === 'react' &&
            /^use[A-Z]/u.test(value.name === '*' ? (value.members[0] ?? '') : value.name),
        )
    ) {
      ui = true;
    }
  });
  return ui;
};

const referencedFunctions = (
  graph: UiSupportSelection['graph'],
  current: UiSupportSelection['selected'],
): readonly UiSupportSelection['selected'][] => {
  const references: UiSupportSelection['selected'][] = [];
  traverseFast(current.expression, (node) => {
    if (node.type !== 'Identifier' && node.type !== 'MemberExpression') {
      return;
    }
    const binding = graph.resolveReference(current.module, node);
    if (binding?.kind === 'declaration' && isFunction(binding.expression)) {
      references.push(binding);
    }
  });
  return references;
};

const reachesSelectedSupport = (
  graph: UiSupportSelection['graph'],
  root: UiSupportSelection['selected'],
  selected: UiSupportSelection['selected'],
): boolean => {
  const pending = [root];
  const visited = new Set<Node>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (visited.has(current.expression)) {
      continue;
    }
    visited.add(current.expression);
    const references = referencedFunctions(graph, current);
    if (
      references.some(
        (binding) => binding.module.path === selected.module.path && binding.expression === selected.expression,
      )
    ) {
      return true;
    }
    pending.push(...references.filter((binding) => binding.module.boundary === root.module.boundary));
  }
  return false;
};

/** UI dependency identity, not a claim that rendering or document hints are pure or authoritative. */
export const hasPublishedUiSupport = ({ artifact, graph, selected }: UiSupportSelection): boolean =>
  isFunction(selected.expression) &&
  exportedNames(artifact).some((name) => {
    const root = graph.resolve(artifact, name, 'export');
    return (
      root?.kind === 'declaration' &&
      isFunction(root.expression) &&
      root.expression !== selected.expression &&
      hasUiImplementation(graph, root.module, root.expression) &&
      reachesSelectedSupport(graph, root, selected)
    );
  });
