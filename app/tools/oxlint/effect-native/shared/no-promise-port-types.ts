import type { ESTree } from '@oxlint/plugins';

import { typeNameSegments } from './ast.ts';

interface TypeBinding {
  readonly node: any;
  readonly substitutions: ReadonlyMap<any, TypeBinding>;
}

interface Resolution {
  readonly seen: Set<any>;
  readonly substitutions: ReadonlyMap<any, TypeBinding>;
  readonly insideFunction: boolean;
  readonly functionAliasOnly: boolean;
}

type VariableLookup = (node: any, name: string) => any;

/** Same-file type resolution: applied arguments belong to the caller's environment,
 * while defaults and constraints belong to the progressively bound declaration. */
export function createPromisePortTypeResolver(
  variableFor: VariableLookup,
  promiseTypes: readonly string[]
) {
  const branch = (state: Resolution): Resolution => ({
    ...state,
    seen: new Set(state.seen),
  });
  const promiseName = (name: string, state: Resolution): string | null =>
    state.functionAliasOnly && !state.insideFunction ? null : `${name}<…>`;

  const resolveFirst = (
    nodes: readonly any[],
    state: Resolution
  ): string | null => {
    for (const node of nodes) {
      const result = resolve(node, branch(state));
      if (result) return result;
    }
    return null;
  };

  const resolveMembers = (raw: any, state: Resolution): string | null => {
    // Direct members have their own visitors. Function-returned records are
    // fluent continuations, not service ports, even with applied arguments.
    if (state.substitutions.size === 0 || state.insideFunction) return null;
    for (const member of raw.members ?? raw.body) {
      const isValue =
        member.type === 'TSPropertySignature' ||
        member.type === 'TSIndexSignature';
      const result = resolve(
        isValue ? member.typeAnnotation : member.returnType,
        {
          ...branch(state),
          insideFunction: state.insideFunction || !isValue,
        }
      );
      if (result) return result;
    }
    return null;
  };

  const bindArguments = (raw: any, alias: any, state: Resolution) => {
    const applied = new Map(state.substitutions);
    for (const [index, parameter] of (
      alias.typeParameters?.params ?? []
    ).entries()) {
      const argument = raw.typeArguments?.params[index];
      const value = argument ?? parameter.default ?? parameter.constraint;
      if (!value) continue;
      const binding = variableFor(parameter.name, parameter.name.name);
      if (binding)
        applied.set(binding, {
          node: value,
          substitutions: argument ? state.substitutions : applied,
        });
    }
    return applied;
  };

  const resolveAlias = (
    raw: any,
    alias: any,
    state: Resolution
  ): string | null => {
    const applied = bindArguments(raw, alias, state);
    if (state.seen.has(alias)) return null;
    state.seen.add(alias);
    const inheritedState = { ...state, substitutions: applied };
    const own = resolve(
      alias.typeAnnotation ?? alias.body,
      branch(inheritedState)
    );
    return own ?? resolveFirst(alias.extends ?? [], inheritedState);
  };

  const resolveLocalReference = (
    raw: any,
    typeName: any,
    name: string,
    state: Resolution
  ): string | null => {
    const variable = variableFor(typeName, name);
    const bound = state.substitutions.get(variable);
    if (bound)
      return resolve(bound.node, {
        ...state,
        substitutions: bound.substitutions,
      });
    const alias = variable?.defs.find((def: any) =>
      ['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(
        def.node.type
      )
    )?.node;
    if (alias) return resolveAlias(raw, alias, state);
    const parameter = variable?.defs.find(
      (def: any) => def.node.type === 'TSTypeParameter'
    )?.node;
    if (parameter) return resolve(parameter, state);
    if (variable?.defs.length || !promiseTypes.includes(name)) return null;
    return promiseName(name, state);
  };

  const resolveReference = (raw: any, state: Resolution): string | null => {
    const typeName = raw.typeName ?? raw.expression;
    const names = typeNameSegments(typeName);
    if (!names) return null;
    const name = names.at(-1)!;
    if (names.length === 1)
      return resolveLocalReference(raw, typeName, name, state);
    if (
      names.length === 2 &&
      names[0] === 'globalThis' &&
      !variableFor(raw, 'globalThis')?.defs.length &&
      promiseTypes.includes(name)
    )
      return promiseName(name, state);
    return null;
  };

  const resolveShape = (raw: any, state: Resolution): string | null => {
    if (raw.type === 'TSFunctionType')
      return state.substitutions.size === 0
        ? null
        : resolve(raw.returnType, { ...state, insideFunction: true });
    if (raw.type === 'TSTypeLiteral' || raw.type === 'TSInterfaceBody')
      return resolveMembers(raw, state);
    if (raw.type === 'TSTypeReference' || raw.type === 'TSInterfaceHeritage')
      return resolveReference(raw, state);
    return null;
  };

  const resolve = (raw: any, state: Resolution): string | null => {
    if (!raw || state.seen.has(raw)) return null;
    state.seen.add(raw);
    if (raw.type === 'TSTypeAnnotation' || raw.type === 'TSParenthesizedType')
      return resolve(raw.typeAnnotation, state);
    if (raw.type === 'TSTypeParameter')
      return resolveFirst([raw.constraint, raw.default], state);
    if (raw.type === 'TSUnionType' || raw.type === 'TSIntersectionType')
      return resolveFirst(raw.types, state);
    return resolveShape(raw, state);
  };

  return function promiseReference(
    annotation:
      | ESTree.TSTypeAnnotation
      | ESTree.TSTypeReference
      | ESTree.TSInterfaceHeritage
      | null
      | undefined,
    functionAliasOnly = false
  ): string | null {
    return resolve(annotation, {
      seen: new Set(),
      substitutions: new Map(),
      insideFunction: false,
      functionAliasOnly,
    });
  };
}
