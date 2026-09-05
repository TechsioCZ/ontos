import type { Context, ESTree } from '@oxlint/plugins';

const EFFECT_MODULE = /^effect(?:\/.*)?$/u;

export interface EffectBindings {
  /** local identifier → exported namespace name, e.g. `Effect`, `Schema`, `Layer`, `Config`. */
  readonly namespaces: ReadonlyMap<string, string>;
  /** Whether the file imports anything from `effect` or `effect/*`. */
  readonly importsEffect: boolean;
}

/**
 * Collect `import { Effect as E, Schema } from "effect"` and `import * as Schema from "effect/Schema"`
 * style bindings for the current program. Sub-path imports such as `effect/unstable/http` map their
 * named exports (e.g. `HttpApiClient`) exactly like root imports.
 */
export function collectEffectBindings(program: ESTree.Program): EffectBindings {
  const namespaces = new Map<string, string>();
  let importsEffect = false;
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!EFFECT_MODULE.test(statement.source.value)) continue;
    importsEffect = true;
    const submodule = statement.source.value.split('/').at(-1);
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const imported =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value;
        namespaces.set(specifier.local.name, imported);
      } else if (
        specifier.type === 'ImportNamespaceSpecifier' &&
        submodule !== undefined &&
        submodule !== 'effect'
      ) {
        // `import * as Schema from "effect/Schema"` binds the whole submodule as a namespace.
        namespaces.set(specifier.local.name, submodule);
      }
    }
  }
  return { namespaces, importsEffect };
}

/** `Effect.runPromise` → `{ namespace: "Effect", member: "runPromise" }` when `Effect` is an effect import. */
export function effectMember(
  node: ESTree.Node,
  bindings: EffectBindings,
): { namespace: string; member: string } | null {
  if (node.type !== 'MemberExpression' || node.computed) return null;
  if (node.object.type !== 'Identifier' || node.property.type !== 'Identifier') return null;
  const namespace = bindings.namespaces.get(node.object.name);
  if (namespace === undefined) return null;
  return { namespace, member: node.property.name };
}

export function bindingsFor(context: Context): EffectBindings {
  return collectEffectBindings(context.sourceCode.ast);
}
