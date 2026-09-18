import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { parseSync } from "oxc-parser";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SAFE_IMPORTS = new Map([
  ["effect", new Set(["Match", "Predicate", "Schema", "SchemaAST"])],
  ["@modern-js/bff-effect/effect-client", new Set(["HttpApiSchema"])],
]);
const SCHEMA_CONSTRUCTORS = new Set([
  "Any", "Array", "BigInt", "Boolean", "Date", "Enum", "Literal", "Map", "Never", "Null",
  "Record", "Set", "String", "Struct", "TaggedClass", "TaggedStruct", "TemplateLiteral",
  "Tuple", "Undefined", "Union", "Unknown", "Void", "declare", "filter", "instance",
  "transform", "transformOrFail",
]);
const RUNTIME_TS_WRAPPERS = new Set([
  "TSAsExpression", "TSSatisfiesExpression", "TSInstantiationExpression",
  "TSNonNullExpression", "TSTypeAssertion",
]);

// Cross-file Oxc nodes carry parser-specific fields, so this narrow view is kept private to the rule.
type Syntax = ESTree.Node & Record<string, any>;

interface Model {
  readonly exports: Map<string, Syntax>;
  readonly imports: Map<string, { readonly imported: string; readonly source: string }>;
  readonly aliases: Map<string, Syntax>;
  readonly values: Map<string, { readonly function: boolean; readonly node: Syntax }>;
}

interface FunctionInfo {
  readonly params: readonly Syntax[];
  readonly body: Syntax;
  readonly returnExpression: Syntax;
  readonly generics: ReadonlyMap<string, Syntax | null>;
}

interface FunctionScope {
  readonly parameters: ReadonlySet<string>;
  readonly locals: ReadonlyMap<string, Syntax | null>;
  readonly names: ReadonlySet<string>;
  readonly valid: boolean;
}

interface ProofState {
  readonly visiting: Set<Syntax>;
  readonly proven: Set<Syntax>;
}

const asNode = (value: unknown): Syntax | null =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
    ? (value as Syntax)
    : null;
const kind = (node: Syntax | null): string | null => (typeof node?.type === "string" ? node.type : null);
const nameOf = (node: Syntax | null): string | null =>
  kind(node) === "Identifier" && typeof node?.name === "string" ? node.name : null;
const stringOf = (node: Syntax | null): string | null =>
  kind(node) === "Literal" && typeof node?.value === "string" ? node.value : null;

function children(node: Syntax): Syntax[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === "type" || key === "parent") return [];
    return (Array.isArray(value) ? value : [value]).map(asNode).filter((child): child is Syntax => child !== null);
  });
}

function unwrap(node: Syntax): Syntax {
  let current = node;
  for (let depth = 0; depth < 8; depth += 1) {
    const type = kind(current);
    if (type === null || (!RUNTIME_TS_WRAPPERS.has(type) && type !== "ParenthesizedExpression")) return current;
    const inner = asNode(current.expression);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

function typeName(node: Syntax | null): readonly string[] | null {
  const name = nameOf(node);
  if (name !== null) return [name];
  if (kind(node) !== "TSQualifiedName") return null;
  const left = typeName(asNode(node?.left));
  const right = nameOf(asNode(node?.right));
  return left !== null && right !== null ? [...left, right] : null;
}

function isFunction(node: Syntax): boolean {
  return ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(kind(node) ?? "");
}

function addValue(model: Model, name: string, node: Syntax): boolean {
  if (model.values.has(name)) return false;
  model.values.set(name, { function: isFunction(node), node });
  return true;
}

function addDeclaration(model: Model, declaration: Syntax): boolean {
  if (kind(declaration) === "FunctionDeclaration") {
    const name = nameOf(asNode(declaration.id));
    return name !== null && addValue(model, name, declaration);
  }
  if (kind(declaration) === "VariableDeclaration") {
    if (declaration.kind !== "const") return false;
    if (!Array.isArray(declaration.declarations)) return false;
    for (const entry of declaration.declarations) {
      const declarator = asNode(entry);
      const name = nameOf(asNode(declarator?.id));
      const init = asNode(declarator?.init);
      if (name === null || init === null || !addValue(model, name, init)) return false;
    }
    return true;
  }
  if (kind(declaration) === "TSTypeAliasDeclaration") {
    const name = nameOf(asNode(declaration.id));
    if (name === null || model.aliases.has(name)) return false;
    model.aliases.set(name, declaration);
    return true;
  }
  return false;
}

function directExports(declaration: Syntax): readonly [string, Syntax][] {
  if (kind(declaration) === "FunctionDeclaration") {
    const name = nameOf(asNode(declaration.id));
    return name === null ? [] : [[name, declaration]];
  }
  if (kind(declaration) !== "VariableDeclaration" || !Array.isArray(declaration.declarations)) return [];
  return declaration.declarations.flatMap((entry: unknown) => {
    const declarator = asNode(entry);
    const name = nameOf(asNode(declarator?.id));
    const init = asNode(declarator?.init);
    return name !== null && init !== null ? [[name, init] as [string, Syntax]] : [];
  });
}

function addImport(model: Model, declaration: Syntax): boolean {
  if (declaration.importKind === "type") return true;
  const source = stringOf(asNode(declaration.source));
  if (source === null || !Array.isArray(declaration.specifiers) || declaration.specifiers.length === 0) return false;
  for (const entry of declaration.specifiers) {
    const specifier = asNode(entry);
    if (specifier?.importKind === "type") continue;
    if (kind(specifier) !== "ImportSpecifier") return false;
    const imported = nameOf(asNode(specifier.imported)) ?? stringOf(asNode(specifier.imported));
    const local = nameOf(asNode(specifier.local));
    if (imported === null || local === null || !SAFE_IMPORTS.get(source)?.has(imported)) return false;
    if (model.imports.has(local)) return false;
    model.imports.set(local, { imported, source });
  }
  return true;
}

function buildModel(program: ESTree.Program): Model | null {
  const model: Model = { exports: new Map(), imports: new Map(), aliases: new Map(), values: new Map() };
  for (const statement of program.body) {
    const node = statement as Syntax;
    const type = kind(node);
    if (type === "ImportDeclaration") {
      if (!addImport(model, node)) return null;
      continue;
    }
    if (type === "ExportNamedDeclaration") {
      if (node.source !== null || (Array.isArray(node.specifiers) && node.specifiers.length > 0)) return null;
      const declaration = asNode(node.declaration);
      if (declaration === null) continue;
      if (!addDeclaration(model, declaration)) return null;
      for (const [name, value] of directExports(declaration)) {
        if (model.exports.has(name)) return null;
        model.exports.set(name, value);
      }
      continue;
    }
    if (["FunctionDeclaration", "VariableDeclaration", "TSTypeAliasDeclaration"].includes(type ?? "")) {
      if (!addDeclaration(model, node)) return null;
      continue;
    }
    if (type === "ExportDefaultDeclaration" || type === "ExportAllDeclaration") return null;
    if (type === "EmptyStatement") continue;
    return null;
  }
  return model;
}

function resolveModule(filename: string, source: string): string | null {
  const base = nodePath.resolve(nodePath.dirname(filename), source);
  const candidates = nodePath.extname(base) === "" ? SOURCE_EXTENSIONS.map((extension) => base + extension) : [base];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Unknown modules remain reported.
    }
  }
  return null;
}

function functionInfo(node: Syntax): FunctionInfo | null {
  if (!isFunction(node) || node.async === true || node.generator === true) return null;
  const params = Array.isArray(node.params) ? node.params.map(asNode) : [];
  const body = asNode(node.body);
  if (body === null || params.some((parameter) => parameter === null)) return null;
  let result: Syntax | null = null;
  if (kind(body) === "BlockStatement") {
    const statements = Array.isArray(body.body) ? body.body.map(asNode) : [];
    const returns = statements.filter((statement) => kind(statement) === "ReturnStatement");
    if (
      statements.some((statement) => statement === null) ||
      returns.length !== 1 ||
      statements.some((statement) => !["VariableDeclaration", "ReturnStatement"].includes(kind(statement) ?? ""))
    ) return null;
    result = asNode(returns[0]?.argument);
  } else if (kind(node) === "ArrowFunctionExpression" && node.expression === true) {
    result = body;
  }
  if (result === null) return null;
  return { params: params as Syntax[], body, returnExpression: result, generics: genericConstraints(node) };
}

function genericConstraints(node: Syntax): ReadonlyMap<string, Syntax | null> {
  const generics = asNode(node.typeParameters);
  const result = new Map<string, Syntax | null>();
  for (const entry of Array.isArray(generics?.params) ? generics.params : []) {
    const parameter = asNode(entry);
    const name = nameOf(asNode(parameter?.name));
    if (name !== null) result.set(name, asNode(parameter?.constraint));
  }
  return result;
}

function unwrapParameter(node: Syntax): Syntax | null {
  let current = node;
  for (let depth = 0; depth < 4; depth += 1) {
    if (kind(current) === "AssignmentPattern") {
      current = asNode(current.left)!;
    } else if (kind(current) === "TSParameterProperty") {
      current = asNode(current.parameter)!;
    } else {
      break;
    }
  }
  return current;
}

function hasParameterInitializer(node: Syntax): boolean {
  let current: Syntax | null = node;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    if (kind(current) === "AssignmentPattern") return true;
    if (kind(current) !== "TSParameterProperty") return false;
    current = asNode(current.parameter);
  }
  return false;
}

function isLiteralType(node: Syntax): boolean {
  if (kind(node) !== "TSLiteralType") return false;
  const literal = asNode(node.literal);
  return ["Literal", "StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(kind(literal) ?? "") &&
    ["string", "number", "boolean"].includes(typeof literal?.value);
}

function isDataType(
  node: Syntax,
  model: Model,
  generics: ReadonlyMap<string, Syntax | null>,
  seen = new Set<string>(),
): boolean {
  const type = kind(node);
  if (["TSStringKeyword", "TSNumberKeyword", "TSBooleanKeyword"].includes(type ?? "") || isLiteralType(node)) return true;
  if (type === "TSParenthesizedType" || type === "TSOptionalType") return isDataType(node.typeAnnotation, model, generics, seen);
  if (type === "TSUnionType" || type === "TSIntersectionType") {
    return Array.isArray(node.types) && node.types.length > 0 && node.types.every((entry: unknown) => isDataType(asNode(entry)!, model, generics, seen));
  }
  if (type !== "TSTypeReference") return false;
  const name = typeName(asNode(node.typeName));
  if (name === null) return false;
  if (
    name.length === 3 &&
    name[1] === "Struct" &&
    name[2] === "Fields" &&
    model.imports.get(name[0])?.source === "effect" &&
    model.imports.get(name[0])?.imported === "Schema"
  ) return true;
  if (name.length !== 1) return false;
  const simple = name[0];
  if (generics.has(simple)) {
    const constraint = generics.get(simple);
    return constraint !== null && constraint !== undefined && !seen.has("g:" + simple) &&
      isDataType(constraint, model, generics, new Set([...seen, "g:" + simple]));
  }
  const alias = model.aliases.get(simple);
  return alias !== undefined && !seen.has("a:" + simple) &&
    isDataType(alias.typeAnnotation, model, generics, new Set([...seen, "a:" + simple]));
}

function hasDataParameters(info: FunctionInfo, model: Model): boolean {
  for (const parameter of info.params) {
    const current = unwrapParameter(parameter);
    const annotation = current === null ? null : asNode(current.typeAnnotation);
    const type = annotation === null ? null : asNode(annotation.typeAnnotation);
    if (nameOf(current) === null || type === null || !isDataType(type, model, info.generics)) return false;
  }
  return true;
}

function hasTypedDataParameters(node: Syntax, model: Model): boolean {
  if (!isFunction(node) || node.async === true || node.generator === true || !Array.isArray(node.params) || node.params.length === 0) {
    return false;
  }
  const generics = genericConstraints(node);
  return node.params.every((entry: unknown) => {
    const parameter = asNode(entry);
    const current = parameter === null ? null : unwrapParameter(parameter);
    const annotation = current === null ? null : asNode(current.typeAnnotation);
    const type = annotation === null ? null : asNode(annotation.typeAnnotation);
    return parameter !== null && !hasParameterInitializer(parameter) && nameOf(current) !== null && type !== null && isDataType(type, model, generics);
  });
}

function functionScope(info: FunctionInfo): FunctionScope {
  const parameters = new Set<string>();
  const locals = new Map<string, Syntax | null>();
  let valid = true;
  for (const parameter of info.params) {
    const name = nameOf(unwrapParameter(parameter));
    if (hasParameterInitializer(parameter) || name === null || parameters.has(name)) {
      valid = false;
      continue;
    }
    parameters.add(name);
  }
  if (kind(info.body) === "BlockStatement") {
    for (const statement of info.body.body ?? []) {
      const node = asNode(statement);
      if (kind(node) !== "VariableDeclaration") continue;
      if (node.kind !== "const") valid = false;
      for (const entry of node.declarations ?? []) {
        const declarator = asNode(entry);
        const name = nameOf(asNode(declarator?.id));
        const init = asNode(declarator?.init);
        if (name === null || locals.has(name)) {
          valid = false;
          continue;
        }
        locals.set(name, init);
        if (init === null) valid = false;
      }
    }
  }
  const names = new Set([...parameters, ...locals.keys()]);
  return { parameters, locals, names, valid };
}

function importedMember(node: Syntax, model: Model, scope: FunctionScope): string | null {
  const name = nameOf(node);
  return name === null || scope.names.has(name) ? null : model.imports.get(name)?.imported ?? null;
}

function member(node: Syntax): { readonly object: Syntax; readonly property: string } | null {
  if (kind(node) !== "MemberExpression" || node.computed === true) return null;
  const object = asNode(node.object);
  const property = nameOf(asNode(node.property));
  return object !== null && property !== null ? { object, property } : null;
}

function safeMember(node: Syntax, model: Model, scope: FunctionScope): boolean {
  const value = member(unwrap(node));
  if (value === null) return false;
  const imported = importedMember(value.object, model, scope);
  return imported === "Schema" || imported === "SchemaAST" || imported === "Predicate" || imported === "Match" ||
    (imported === "HttpApiSchema" && ["asJson", "status"].includes(value.property));
}

function schemaMember(node: Syntax, model: Model, scope: FunctionScope): boolean {
  const value = member(unwrap(node));
  return value !== null && importedMember(value.object, model, scope) === "Schema" && SCHEMA_CONSTRUCTORS.has(value.property);
}

function httpApiSchemaMember(node: Syntax, model: Model, scope: FunctionScope): boolean {
  const value = member(unwrap(node));
  return value !== null && importedMember(value.object, model, scope) === "HttpApiSchema" &&
    ["asJson", "status"].includes(value.property);
}

function safeDataMember(node: Syntax, model: Model, scope: FunctionScope): boolean {
  const value = member(unwrap(node));
  return value !== null && value.property === "assign" && nameOf(value.object) === "Object" && !scope.names.has("Object");
}

function safeDataExpression(
  node: Syntax,
  model: Model,
  scope: FunctionScope,
  state: ProofState,
  seen = new Set<Syntax>(),
): boolean {
  const current = unwrap(node);
  if (seen.has(current)) return false;
  const nextSeen = new Set(seen).add(current);
  const type = kind(current);
  if (type === "Identifier") {
    const name = nameOf(current);
    if (name === null) return false;
    if (scope.parameters.has(name)) return true;
    if (name === "undefined" && !scope.names.has(name)) return true;
    if (scope.locals.has(name)) {
      const initializer = scope.locals.get(name);
      return initializer !== null && initializer !== undefined && !isFunction(initializer) &&
        safeDataExpression(initializer, model, scope, state, nextSeen);
    }
    const binding = model.values.get(name);
    return binding !== undefined && !binding.function && safeDataExpression(binding.node, model, scope, state, nextSeen);
  }
  if (["Literal", "RegExpLiteral"].includes(type ?? "")) return true;
  if (type === "TemplateLiteral") return (current.expressions ?? []).every((entry: unknown) => safeDataExpression(asNode(entry)!, model, scope, state, nextSeen));
  if (type === "ObjectExpression") return (current.properties ?? []).every((entry: unknown) => safeDataExpression(asNode(entry)!, model, scope, state, nextSeen));
  if (type === "ArrayExpression") return (current.elements ?? []).every((entry: unknown) => entry === null || safeDataExpression(asNode(entry)!, model, scope, state, nextSeen));
  if (type === "Property") return current.kind === "init" && current.method !== true && current.computed !== true &&
    safeDataExpression(asNode(current.value)!, model, scope, state, nextSeen);
  if (type === "SpreadElement") return safeDataExpression(asNode(current.argument)!, model, scope, state, nextSeen);
  if (type === "MemberExpression") return safeMember(current, model, scope) || safeDataMember(current, model, scope);
  if (["ConditionalExpression", "LogicalExpression", "BinaryExpression", "UnaryExpression"].includes(type ?? "")) {
    return children(current).every((child) => safeDataExpression(child, model, scope, state, nextSeen));
  }
  if (type !== "CallExpression") return false;
  const args = (current.arguments ?? []).map(asNode);
  if (args.some((argument: Syntax | null) => argument === null || !safeDataExpression(argument, model, scope, state, nextSeen))) return false;
  const callee = unwrap(asNode(current.callee)!);
  if (safeMember(callee, model, scope) || schemaMember(callee, model, scope) || safeDataMember(callee, model, scope)) return true;
  const name = nameOf(callee);
  if (name === null || scope.names.has(name)) return false;
  const binding = model.values.get(name);
  return binding?.function === true && hasTypedDataParameters(binding.node, model);
}

function schemaInput(node: Syntax, model: Model, scope: FunctionScope, state: ProofState): boolean {
  return safeDataExpression(node, model, scope, state);
}

function pipelineInput(
  node: Syntax,
  model: Model,
  scope: FunctionScope,
  state: ProofState,
  seen = new Set<Syntax>(),
): boolean {
  const current = unwrap(node);
  if (seen.has(current)) return false;
  const nextSeen = new Set(seen).add(current);
  const type = kind(current);
  if (type === "Identifier") {
    const name = nameOf(current);
    if (name === null || scope.parameters.has(name)) return false;
    if (scope.locals.has(name)) {
      const initializer = scope.locals.get(name);
      return initializer !== null && initializer !== undefined && pipelineInput(initializer, model, scope, state, nextSeen);
    }
    const binding = model.values.get(name);
    return binding?.function === false && pipelineInput(binding.node, model, scope, state, nextSeen);
  }
  if (type === "MemberExpression") return schemaMember(current, model, scope);
  if (type !== "CallExpression") return false;
  const args = (current.arguments ?? []).map(asNode);
  if (args.some((argument: Syntax | null) => argument === null || !schemaInput(argument, model, scope, state))) return false;
  const callee = unwrap(asNode(current.callee)!);
  return httpApiSchemaMember(callee, model, scope) || schemaMember(callee, model, scope);
}

function schemaExpression(node: Syntax, model: Model, scope: FunctionScope, state: ProofState): boolean {
  if (state.visiting.has(node)) return false;
  const current = unwrap(node);
  if (kind(current) !== "CallExpression") return false;
  const args = (current.arguments ?? []).map(asNode);
  const callee = unwrap(asNode(current.callee)!);
  const piped = member(callee);
  if (piped?.property === "pipe") {
    if (args.some((argument: Syntax | null) => argument === null || !pipelineInput(argument, model, scope, state))) return false;
    return schemaExpression(piped.object, model, scope, state);
  }
  if (args.some((argument: Syntax | null) => argument === null || !schemaInput(argument, model, scope, state))) return false;
  if (schemaMember(callee, model, scope)) return true;
  const name = nameOf(callee);
  if (name !== null && scope.locals.has(name)) {
    const localNode = scope.locals.get(name);
    return localNode !== null && localNode !== undefined && isFunction(localNode) && prove(localNode, model, state);
  }
  if (name !== null && scope.parameters.has(name)) return false;
  const local = model.values.get(name ?? "");
  if (local?.function !== true || state.visiting.has(local.node)) return false;
  return prove(local.node, model, state);
}

function prove(node: Syntax, model: Model, state: ProofState): boolean {
  if (state.proven.has(node)) return true;
  if (state.visiting.has(node)) return false;
  const info = functionInfo(node);
  if (info === null || !hasDataParameters(info, model)) return false;
  const scope = functionScope(info);
  if (!scope.valid) return false;
  if ([...scope.locals.values()].some((initializer) =>
    initializer === null || initializer === undefined || !safeDataExpression(initializer, model, scope, state))) return false;
  state.visiting.add(node);
  const result = schemaExpression(info.returnExpression, model, scope, state);
  state.visiting.delete(node);
  if (result) state.proven.add(node);
  return result;
}

function isPureSchemaFactoryImport(
  filename: string,
  source: string,
  importedName: string,
  cache: Map<string, Model | null>,
): boolean {
  if (!source.startsWith("./") && !source.startsWith("../")) return false;
  const resolved = resolveModule(filename, source);
  if (resolved === null) return false;
  if (!cache.has(resolved)) {
    try {
      const sourceText = readFileSync(resolved, "utf8");
      const parsed = parseSync(resolved, sourceText, { sourceType: "module" });
      cache.set(resolved, parsed.errors.length === 0 ? buildModel(parsed.program as ESTree.Program) : null);
    } catch {
      cache.set(resolved, null);
    }
  }
  const model = cache.get(resolved);
  const exported = model?.exports.get(importedName);
  return model !== null && exported !== undefined && prove(exported, model, { visiting: new Set(), proven: new Set() });
}

/** Keep dependency-bearing Effect service constructors local to their owning capability modules. */
export const noServiceConstructorImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow project-local make<CapabilityName> imports outside test and spec files." },
    messages: {
      serviceConstructorImport:
        'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
    },
  },
  create(context) {
    const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));
    const cache = new Map<string, Model | null>();
    return {
      ImportDeclaration(node) {
        if (isTestFile || (!node.source.value.startsWith("./") && !node.source.value.startsWith("../"))) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const importedName = getImportedName(specifier);
          if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;
          if (isPureSchemaFactoryImport(context.filename, node.source.value, importedName, cache)) continue;
          context.report({ node: specifier, messageId: "serviceConstructorImport", data: { name: importedName } });
        }
      },
    };
  },
});

function getImportedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
}
