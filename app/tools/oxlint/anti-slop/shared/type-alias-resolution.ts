import type { ESTree } from "@oxlint/plugins";

import { bindsTypeParameter, type VisitorKeys } from "./lexical-type-parameters.ts";

/*
 * Lexical type-name resolution adapted from @nkzw/oxlint-config 3.0.0
 * `quality/shared/type-alias-resolution.js` (MIT, Nakazawa Tech; quality rules derived from
 * anti-slop, MIT, Dillon Mulroy). Local changes: scopes are indexed on first lookup, so checks need
 * no deferral to `Program:exit`; a class expression name binds only inside its class; a type
 * argument is substituted only where the reference binds to the expanded alias's own parameter;
 * and a substituted argument keeps the expansion path of the reference that supplied it.
 */

type TypeDeclaration =
  | ESTree.Class
  | ESTree.ImportDeclarationSpecifier
  | ESTree.TSEnumDeclaration
  | ESTree.TSImportEqualsDeclaration
  | ESTree.TSInterfaceDeclaration
  | ESTree.TSTypeAliasDeclaration;

/** What a type name means at one use site. `global`: no local declaration or type parameter. */
export type TypeBinding =
  | { readonly kind: "global" }
  | { readonly kind: "merged" }
  | { readonly kind: "declaration"; readonly declaration: TypeDeclaration }
  | { readonly kind: "typeParameter"; readonly owner: ESTree.Node };

const globalBinding: TypeBinding = { kind: "global" };
const mergedBinding: TypeBinding = { kind: "merged" };

function scopeStatements(node: ESTree.Node): readonly ESTree.Node[] | null {
  switch (node.type) {
    case "Program":
    case "BlockStatement":
    case "StaticBlock":
    case "TSModuleBlock":
      return node.body;
    case "SwitchStatement":
      return node.cases.flatMap((switchCase) => switchCase.consequent);
    default:
      return null;
  }
}

function bind(
  bindings: Map<string, TypeBinding>,
  name: string,
  declaration: TypeDeclaration,
): void {
  // Merged declarations (interface + interface, class + interface) are not one alias.
  bindings.set(name, bindings.has(name) ? mergedBinding : { kind: "declaration", declaration });
}

function indexStatement(statement: ESTree.Node, bindings: Map<string, TypeBinding>): void {
  switch (statement.type) {
    case "ImportDeclaration":
      for (const specifier of statement.specifiers) {
        bind(bindings, specifier.local.name, specifier);
      }
      return;
    case "ExportNamedDeclaration":
      if (statement.declaration !== null) indexStatement(statement.declaration, bindings);
      return;
    case "ExportDefaultDeclaration":
      indexStatement(statement.declaration, bindings);
      return;
    case "ClassDeclaration":
      if (statement.id !== null) bind(bindings, statement.id.name, statement);
      return;
    case "TSEnumDeclaration":
    case "TSImportEqualsDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
      bind(bindings, statement.id.name, statement);
      return;
    default:
      return;
  }
}

// Type declarations are hoisted to their block, so each scope is indexed whole on first lookup.
const scopeIndexes = new WeakMap<ESTree.Node, ReadonlyMap<string, TypeBinding>>();

function scopeBindings(node: ESTree.Node): ReadonlyMap<string, TypeBinding> | null {
  const cached = scopeIndexes.get(node);
  if (cached !== undefined) return cached;
  const statements = scopeStatements(node);
  if (statements === null) return null;
  const bindings = new Map<string, TypeBinding>();
  for (const statement of statements) indexStatement(statement, bindings);
  scopeIndexes.set(node, bindings);
  return bindings;
}

/** Resolve a type name at `use` by walking its lexical type scopes outwards. */
export function typeBinding(name: string, use: ESTree.Node, visitorKeys: VisitorKeys): TypeBinding {
  let child: ESTree.Node | null = null;
  for (let node: ESTree.Node | null = use; node !== null; node = node.parent) {
    if (bindsTypeParameter(node, child, name, visitorKeys)) {
      return { kind: "typeParameter", owner: node };
    }
    if (node.type === "ClassExpression" && node.id?.name === name) {
      return { kind: "declaration", declaration: node };
    }
    const binding = scopeBindings(node)?.get(name);
    if (binding !== undefined) return binding;
    child = node;
  }
  return globalBinding;
}

interface Expansion {
  /** The alias whose body is being read; its parameters resolve through `arguments`. */
  readonly alias: ESTree.TSTypeAliasDeclaration | null;
  readonly arguments: ReadonlyMap<string, TypeArgument>;
  /** Aliases being expanded on this path; re-entering one stops at its reference. */
  readonly path: ReadonlySet<ESTree.TSTypeAliasDeclaration>;
}

interface TypeArgument {
  readonly type: ESTree.TSType;
  readonly expansion: Expansion;
}

function expand(
  alias: ESTree.TSTypeAliasDeclaration,
  reference: ESTree.TSTypeReference,
  caller: Expansion,
): Expansion {
  const explicit = reference.typeArguments?.params ?? [];
  const path = new Set(caller.path).add(alias);
  const bound = new Map<string, TypeArgument>();
  for (const [index, parameter] of (alias.typeParameters?.params ?? []).entries()) {
    const argument = explicit[index];
    if (argument !== undefined) {
      bound.set(parameter.name.name, { type: argument, expansion: caller });
    } else if (parameter.default !== null) {
      // A default sees only the parameters declared before it.
      const expansion = { alias, arguments: new Map(bound), path };
      bound.set(parameter.name.name, { type: parameter.default, expansion });
    }
  }
  return { alias, arguments: bound, path };
}

export type TypeMatcher = (
  type: ESTree.TSType,
  matches: (child: ESTree.TSType) => boolean,
) => boolean;

/**
 * Match `type` after replacing every visible local alias reference with the alias body and every
 * alias type parameter with its argument or default. Unbound, shadowed, merged and cyclic
 * references reach `matcher` unresolved.
 */
export function resolvedTypeMatches(
  type: ESTree.TSType,
  visitorKeys: VisitorKeys,
  matcher: TypeMatcher,
): boolean {
  const evaluate = (current: ESTree.TSType, expansion: Expansion): boolean => {
    if (current.type === "TSTypeReference" && current.typeName.type === "Identifier") {
      const binding = typeBinding(current.typeName.name, current, visitorKeys);
      if (binding.kind === "typeParameter" && binding.owner === expansion.alias) {
        const argument = expansion.arguments.get(current.typeName.name);
        if (argument !== undefined) return evaluate(argument.type, argument.expansion);
      }
      if (
        binding.kind === "declaration" &&
        binding.declaration.type === "TSTypeAliasDeclaration" &&
        !expansion.path.has(binding.declaration)
      ) {
        const alias = binding.declaration;
        return evaluate(alias.typeAnnotation, expand(alias, current, expansion));
      }
    }
    return matcher(current, (child) => evaluate(child, expansion));
  };
  return evaluate(type, { alias: null, arguments: new Map(), path: new Set() });
}
