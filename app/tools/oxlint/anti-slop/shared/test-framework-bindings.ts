import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/**
 * Binding-aware recognition of test framework APIs.
 *
 * A name counts only when it is a value import of the framework export it claims to be (in any
 * local alias), a member of a namespace import of a framework module, or an unresolved global of
 * the same name (the runners' globals mode). A local declaration that shadows the name is never a
 * framework API, so local helpers named `it`, `rs` or `vi` stay out of scope.
 */

const frameworkModules: ReadonlySet<string> = new Set([
  "@jest/globals",
  "@rstest/core",
  "effect-rstest",
  "vitest",
]);

/** Exports holding the framework's mock and stub utilities. `effect-rstest` re-exports `@rstest/core`. */
const mockUtilityExports: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["@jest/globals", new Set(["jest"])],
  ["@rstest/core", new Set(["rs", "rstest"])],
  ["effect-rstest", new Set(["rs", "rstest"])],
  ["vitest", new Set(["vi", "vitest"])],
]);
const mockUtilityGlobals: ReadonlySet<string> = new Set(["jest", "rs", "rstest", "vi"]);

/** Exports that register tests or suites, including the Effect testers of `effect-rstest`. */
const registrationExports: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["@jest/globals", new Set(["describe", "it", "test"])],
  ["@rstest/core", new Set(["describe", "it", "test"])],
  ["effect-rstest", new Set(["describe", "effect", "it", "live", "test"])],
  ["vitest", new Set(["describe", "it", "suite", "test"])],
]);
const registrationGlobals: ReadonlySet<string> = new Set(["describe", "it", "test"]);

export interface FrameworkBinding {
  /** `null` for an unresolved global reference. */
  readonly source: string | null;
  readonly name: string;
}

export function resolveVariable(sourceCode: SourceCode, identifier: ESTree.Node): Variable | null {
  if (identifier.type !== "Identifier") return null;
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** A static property key: an identifier, a string literal, or a template literal without substitutions. */
export function staticKey(node: ESTree.Node, computed: boolean): string | null {
  if (!computed) return node.type === "Identifier" ? node.name : null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

export function memberName(node: ESTree.Node): string | null {
  return node.type === "MemberExpression" ? staticKey(node.property, node.computed) : null;
}

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function frameworkImport(variable: Variable, kind: "ImportSpecifier" | "ImportNamespaceSpecifier"): FrameworkBinding | null {
  for (const definition of variable.defs) {
    const declaration = definition.parent;
    if (definition.type !== "ImportBinding" || declaration?.type !== "ImportDeclaration") continue;
    if (declaration.importKind === "type" || definition.node.type !== kind) continue;
    if (definition.node.type === "ImportSpecifier" && definition.node.importKind === "type") continue;
    const source = declaration.source.value;
    if (!frameworkModules.has(source)) continue;
    return { source, name: importedName(definition.node) ?? "*" };
  }
  return null;
}

/**
 * The framework export an expression denotes: `it`, an alias such as `register` of an imported
 * `it`, `runner.it` for `import * as runner`, or an unresolved global. Shadowed names give `null`.
 */
export function frameworkBinding(sourceCode: SourceCode, expression: ESTree.Node): FrameworkBinding | null {
  if (expression.type === "Identifier") {
    const variable = resolveVariable(sourceCode, expression);
    if (variable === null || variable.defs.length === 0) return { source: null, name: expression.name };
    return frameworkImport(variable, "ImportSpecifier");
  }
  if (expression.type !== "MemberExpression" || expression.object.type !== "Identifier") return null;
  const name = memberName(expression);
  const variable = resolveVariable(sourceCode, expression.object);
  if (name === null || variable === null) return null;
  const namespace = frameworkImport(variable, "ImportNamespaceSpecifier");
  return namespace === null ? null : { source: namespace.source, name };
}

function bindingIn(
  binding: FrameworkBinding | null,
  exports: ReadonlyMap<string, ReadonlySet<string>>,
  globals: ReadonlySet<string>,
): boolean {
  if (binding === null) return false;
  if (binding.source === null) return globals.has(binding.name);
  return exports.get(binding.source)?.has(binding.name) ?? false;
}

/** `vi`, `jest`, `rs` or `rstest` (or an alias) from its framework, or the unresolved global. */
export function isMockUtility(sourceCode: SourceCode, expression: ESTree.Node): boolean {
  return bindingIn(frameworkBinding(sourceCode, expression), mockUtilityExports, mockUtilityGlobals);
}

/** A framework export with this exact name, such as `expect`, imported from any framework module. */
export function isFrameworkExport(sourceCode: SourceCode, expression: ESTree.Node, name: string): boolean {
  const binding = frameworkBinding(sourceCode, expression);
  return binding !== null && binding.name === name;
}

/**
 * The `it` parameter `effect-rstest` hands a layer callback: `layer(L)((it) => …)`,
 * `layer(L)("name", (it) => …)` or the nested `it.layer(L)("name", (it) => …)`.
 */
function isLayerTester(sourceCode: SourceCode, expression: ESTree.Node): boolean {
  const variable = resolveVariable(sourceCode, expression);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type !== "Parameter") return false;
  const callback = definition.node;
  const registration = callback.parent;
  if (registration?.type !== "CallExpression" || !registration.arguments.some((argument) => argument === callback)) {
    return false;
  }
  const layerCall = registration.callee;
  if (layerCall.type !== "CallExpression") return false;
  const layer = layerCall.callee;
  const binding = frameworkBinding(sourceCode, layer);
  if (binding?.source === "effect-rstest" && binding.name === "layer") return true;
  return memberName(layer) === "layer" && layer.type === "MemberExpression" && isTestRegistration(sourceCode, layer.object);
}

/** `it`, `test`, `describe`, Effect testers and layer-scoped `it`, by binding rather than spelling. */
export function isTestRegistration(sourceCode: SourceCode, expression: ESTree.Node): boolean {
  return (
    bindingIn(frameworkBinding(sourceCode, expression), registrationExports, registrationGlobals) ||
    isLayerTester(sourceCode, expression)
  );
}
