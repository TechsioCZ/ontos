import { readFileSync, realpathSync } from "node:fs";
import nodePath from "node:path";
import { parseSync } from "oxc-parser";

import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree, Variable } from "@oxlint/plugins";

import { provesDataFactoryImport } from "./data-factory-proof.ts";
import { lookupVariable } from "../../../effect-native/shared/bindings.ts";
import {
  isInsideNativeServiceFactoryCallback,
  isNativeServiceFactoryAcquisition,
  isNativeServiceFactoryArgument,
} from "../../../effect-native/shared/native-service-factory.ts";

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
    if (specifier === null || kind(specifier) !== "ImportSpecifier") return false;
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
      if (node === null || kind(node) !== "VariableDeclaration") continue;
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
  return value !== null && value.property === "assign" && nameOf(value.object) === "Object" && !scope.names.has("Object") && !model.values.has("Object") && !model.imports.has("Object");
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
  return binding?.function === true && hasTypedDataParameters(binding.node, model) &&
    prove(binding.node, model, state);
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

/** Literal factories may copy proven data, but cannot call dependencies or emit executable behavior. */
function literalDataExpression(node: Syntax, model: Model, scope: FunctionScope, seen = new Set<Syntax>()): boolean {
  const current = unwrap(node);
  if (seen.has(current)) return false;
  const nextSeen = new Set(seen).add(current);
  const type = kind(current);
  if (type === 'Identifier') {
    const name = nameOf(current);
    if (name === null) return false;
    if (scope.parameters.has(name)) return true;
    if (name === 'undefined' && !scope.names.has(name)) return true;
    const initializer = scope.locals.has(name) ? scope.locals.get(name) : model.values.get(name)?.node;
    return (
      initializer !== null && initializer !== undefined && literalDataExpression(initializer, model, scope, nextSeen)
    );
  }
  if (type === 'Literal') return current.regex === undefined;
  if (type === 'TemplateLiteral') {
    return (current.expressions ?? []).every((entry: unknown) =>
      literalDataExpression(asNode(entry)!, model, scope, nextSeen),
    );
  }
  if (type === 'ObjectExpression') {
    return (current.properties ?? []).every((entry: unknown) =>
      literalDataExpression(asNode(entry)!, model, scope, nextSeen),
    );
  }
  if (type === 'ArrayExpression') {
    return (current.elements ?? []).every(
      (entry: unknown) => entry === null || literalDataExpression(asNode(entry)!, model, scope, nextSeen),
    );
  }
  if (type === 'Property') {
    return (
      current.kind === 'init' &&
      current.method !== true &&
      current.computed !== true &&
      literalDataExpression(asNode(current.value)!, model, scope, nextSeen)
    );
  }
  if (['ConditionalExpression', 'LogicalExpression', 'BinaryExpression', 'UnaryExpression'].includes(type ?? '')) {
    return children(current).every((child) => literalDataExpression(child, model, scope, nextSeen));
  }
  return false;
}

function proveLiteralDataFactory(node: Syntax, model: Model): boolean {
  const info = functionInfo(node);
  if (info === null || !hasDataParameters(info, model)) return false;
  const scope = functionScope(info);
  if (!scope.valid) return false;
  return (
    [...scope.locals.values()].every(
      (initializer) => initializer !== null && literalDataExpression(initializer, model, scope),
    ) && literalDataExpression(info.returnExpression, model, scope)
  );
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

function isPureDataFactoryImport(
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
      const program = asNode(parsed.program);
      cache.set(resolved, parsed.errors.length === 0 && program?.type === "Program" ? buildModel(program) : null);
    } catch {
      cache.set(resolved, null);
    }
  }
  const model = cache.get(resolved);
  const exported = model?.exports.get(importedName);
  return model !== null && model !== undefined && exported !== undefined &&
    (prove(exported, model, { visiting: new Set(), proven: new Set() }) || proveLiteralDataFactory(exported, model));
}

/** Opt-in process roots use declaration identity, never identifier spelling as provenance. */
interface ProcessLexicalScope {
  readonly parent: ProcessLexicalScope | null;
  readonly bindings: Map<string, Syntax>;
}
interface ProcessSource {
  readonly parents: Map<Syntax, Syntax>;
  readonly references: Map<Syntax, Syntax | null>;
  readonly declarations: Set<Syntax>;
  readonly valid: boolean;
}
type ProcessCapability = "node-runtime" | "node-main" | "effect" | "process";
interface ProcessCapabilities {
  readonly bindings: Map<Syntax, ProcessCapability>;
  readonly valid: boolean;
}
const ERASED_PROCESS_SYNTAX = new Set([
  "TSTypeAnnotation", "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSDeclareFunction",
]);
const UNSUPPORTED_PROCESS_SYNTAX = new Set([
  "TSImportEqualsDeclaration", "TSExternalModuleReference", "TSModuleDeclaration", "TSEnumDeclaration",
  "TSExportAssignment", "TSNamespaceExportDeclaration", "StaticBlock", "WithStatement",
]);
const EVALUATOR_GLOBALS = new Set(["require", "module", "eval", "Function", "globalThis", "global", "window", "self", "Reflect"]);
const REFLECTIVE_MEMBERS = new Set([
  "constructor", "prototype", "__proto__", "getPrototypeOf", "setPrototypeOf",
  "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "defineProperties",
]);
const OBJECT_DATA_CALLS = new Set(["assign", "freeze", "keys", "values", "entries", "fromEntries", "is", "hasOwn"]);
const EFFECT_PROCESS_CALLS = new Set([
  "acquireRelease", "addFinalizer", "all", "andThen", "catch", "catchCause", "catchTag", "context", "fail", "filterOrFail", "forEach",
  "flatMap", "fn", "gen", "map", "mapError", "promise", "provide", "provideContext", "provideService",
  "runPromise", "runPromiseWith", "scoped", "succeed", "suspend", "sync", "tap", "tapCause", "tapError", "tapErrorTag", "timeoutOrElse", "try", "tryPromise",
]);
const EFFECT_PROCESS_VALUES = new Set(["void", "never"]);
const EFFECT_PIPE_TRANSFORMS = new Set(["asVoid", "orDie", "result"]);

function processChildren(node: Syntax): Syntax[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (["type", "parent", "typeAnnotation", "typeParameters", "typeArguments", "returnType", "superTypeArguments", "implements"].includes(key)) return [];
    return (Array.isArray(value) ? value : [value]).map(asNode).filter((child): child is Syntax => child !== null);
  });
}
function processSource(program: ESTree.Program): ProcessSource {
  const parents = new Map<Syntax, Syntax>();
  const declarations = new Set<Syntax>();
  const scopes = new Map<Syntax, ProcessLexicalScope>();
  const identifiers: Syntax[] = [];
  let valid = true;
  const root: ProcessLexicalScope = { parent: null, bindings: new Map() };
  const childScope = (parent: ProcessLexicalScope): ProcessLexicalScope =>
    ({ parent, bindings: new Map() });
  const bind = (pattern: Syntax | null, scope: ProcessLexicalScope): void => {
    if (pattern === null) return;
    if (pattern.type === "Identifier") {
      declarations.add(pattern);
      // Duplicate runtime declarations cannot manufacture an unambiguous import origin.
      if (scope.bindings.has(pattern.name)) valid = false;
      scope.bindings.set(pattern.name, pattern);
      return;
    }
    if (pattern.type === "AssignmentPattern") { bind(asNode(pattern.left), scope); return; }
    if (pattern.type === "RestElement") { bind(asNode(pattern.argument), scope); return; }
    if (pattern.type === "TSParameterProperty") { bind(asNode(pattern.parameter), scope); return; }
    if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) bind(asNode(element), scope);
      return;
    }
    if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) bind(asNode(property.type === "RestElement" ? property.argument : property.value), scope);
      return;
    }
    valid = false;
  };
  const visit = (node: Syntax, scope: ProcessLexicalScope, parent: Syntax | null): void => {
    if (parent !== null) parents.set(node, parent);
    if (ERASED_PROCESS_SYNTAX.has(node.type) || node.declare === true) return;
    if (node.type.startsWith("JSX") || UNSUPPORTED_PROCESS_SYNTAX.has(node.type)) { valid = false; return; }
    if (node.type === "ImportDeclaration") {
      if (node.importKind !== "type") for (const specifier of node.specifiers as Syntax[]) {
        if (specifier.importKind !== "type") {
          parents.set(specifier as Syntax, node);
          parents.set(specifier.local as Syntax, specifier as Syntax);
          bind(asNode(specifier.local), scope);
        }
      }
      return;
    }
    if (["ExportNamedDeclaration", "ExportAllDeclaration", "ExportSpecifier"].includes(node.type) && node.exportKind === "type") return;
    if (node.type === "FunctionDeclaration") bind(asNode(node.id), scope);
    if (node.type === "ClassDeclaration") bind(asNode(node.id), scope);
    let active = scope;
    if (isFunction(node)) {
      active = childScope(scope);
      if (node.type === "FunctionExpression") bind(asNode(node.id), active);
      for (const parameter of node.params) bind(asNode(parameter), active);
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", "ClassExpression", "ClassDeclaration"].includes(node.type)) {
      active = childScope(scope);
      if (node.type === "CatchClause") bind(asNode(node.param), active);
      if (node.type === "ClassExpression") bind(asNode(node.id), active);
    }
    if (node.type === "VariableDeclaration") {
      // Body-var and parameter-initializer environments need distinct semantics: not in this opt-in grammar.
      if (node.kind !== "const" && node.kind !== "let") valid = false;
      for (const declarator of node.declarations) bind(asNode(declarator.id), active);
    }
    scopes.set(node, active);
    if (node.type === "Identifier") identifiers.push(node);
    for (const child of processChildren(node)) visit(child, active, node);
  };
  visit(program as Syntax, root, null);
  const references = new Map<Syntax, Syntax | null>();
  for (const identifier of identifiers) {
    if (declarations.has(identifier)) continue;
    const parent = parents.get(identifier);
    if ((parent?.type === "MemberExpression" && parent.property === identifier && !parent.computed) ||
      ((parent?.type === "Property" || parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") && parent.key === identifier && !parent.computed && parent.value !== identifier) ||
      (["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent?.type ?? "") && parent?.label === identifier) ||
      (parent?.type === "ExportSpecifier" && parent.exported === identifier)) continue;
    let scope: ProcessLexicalScope | null = scopes.get(identifier) ?? null;
    while (scope !== null && !scope.bindings.has(identifier.name)) scope = scope.parent;
    references.set(identifier, scope?.bindings.get(identifier.name) ?? null);
  }
  return { parents, references, declarations, valid };
}

/** Default syntax and named-default syntax acquire the same export slot. Null is an unsupported namespace origin. */
function processExportSlot(specifier: ESTree.ImportDeclaration["specifiers"][number]): string | null {
  if (specifier.type === "ImportDefaultSpecifier") return "default";
  return specifier.type === "ImportSpecifier" ? getImportedName(specifier) : null;
}
function processCapabilities(program: ESTree.Program): ProcessCapabilities {
  const bindings = new Map<Syntax, ProcessCapability>();
  let valid = true;
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      const source = statement.source.value.replace(/^node:/u, "");
      const specifiers = statement.specifiers.filter((specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type");
      if (statement.specifiers.length > 0 && specifiers.length === 0) continue;
      if (["module", "vm"].includes(source)) { valid = false; continue; }
      if (source === "@effect/platform-node/NodeRuntime") {
        for (const specifier of specifiers) {
          if (specifier.type === "ImportSpecifier" && processExportSlot(specifier) === "runMain")
            bindings.set(specifier.local as Syntax, "node-main");
          else valid = false;
        }
        continue;
      }
      // The Crypto layer subpath keeps remotes free of the Node HTTP barrel; it grants no process capability.
      if (source === "@effect/platform-node/NodeCrypto") {
        if (specifiers.some((specifier) => specifier.type !== "ImportSpecifier" || processExportSlot(specifier) !== "layer")) valid = false;
        continue;
      }
      if (source.startsWith("@effect/platform-node/") || source.startsWith("effect/Effect")) { valid = false; continue; }
      if (!["@effect/platform-node", "effect", "process"].includes(source)) continue;
      for (const specifier of specifiers) {
        const slot = processExportSlot(specifier);
        if (source === "process") {
          if (slot === null || slot === "default") bindings.set(specifier.local as Syntax, "process");
          else valid = false;
        } else if (slot === null || slot === "default") valid = false;
        else {
          if (source === "@effect/platform-node" && slot === "NodeRuntime") bindings.set(specifier.local as Syntax, "node-runtime");
          if (source === "effect" && slot === "Effect") bindings.set(specifier.local as Syntax, "effect");
        }
      }
    }
    if ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") &&
      statement.exportKind !== "type" && statement.source !== null &&
      !(statement.type === "ExportNamedDeclaration" && statement.specifiers.length > 0 && statement.specifiers.every((specifier) => specifier.exportKind === "type")) &&
      ["module", "vm"].includes(statement.source.value.replace(/^node:/u, ""))) valid = false;
  }
  return { bindings, valid };
}

function liftedProcessNode(node: Syntax, source: ProcessSource): Syntax {
  let current = node;
  let parent = source.parents.get(current);
  while (parent !== undefined && (RUNTIME_TS_WRAPPERS.has(parent.type) || parent.type === "ParenthesizedExpression") && parent.expression === current) {
    current = parent;
    parent = source.parents.get(current);
  }
  return current;
}
function processMemberKey(node: Syntax): string | null {
  const property = asNode(node.property);
  return node.computed ? (property === null ? null : stringOf(unwrap(property))) : nameOf(property);
}
function staticProcessMember(node: Syntax | undefined): string | null {
  return node?.type === "MemberExpression" && !node.optional ? processMemberKey(node) : null;
}
function processMember(node: Syntax, source: ProcessSource): Syntax | null {
  const reference = liftedProcessNode(node, source);
  const parent = source.parents.get(reference);
  return parent?.type === "MemberExpression" && parent.object === reference && !parent.optional && !parent.computed ? parent : null;
}
function directProcessCall(node: Syntax, source: ProcessSource): Syntax | null {
  const parent = source.parents.get(liftedProcessNode(node, source));
  return parent?.type === "CallExpression" && !parent.optional && parent.callee === liftedProcessNode(node, source) ? parent : null;
}
function writtenProcessNode(node: Syntax, source: ProcessSource): boolean {
  let current = liftedProcessNode(node, source);
  let parent = source.parents.get(current);
  while (parent?.type === "MemberExpression" && parent.object === current) {
    current = liftedProcessNode(parent, source);
    parent = source.parents.get(current);
  }
  return (parent?.type === "AssignmentExpression" && parent.left === current) ||
    (parent?.type === "UpdateExpression" && parent.argument === current) ||
    (parent?.type === "UnaryExpression" && parent.operator === "delete" && parent.argument === current);
}
/** Standard input is data at the executable edge, not a process/module capability alias. */
function ordinaryStdinUse(member: Syntax, source: ProcessSource): boolean {
  const operation = processMember(member, source);
  const call = operation === null ? null : directProcessCall(operation, source);
  if (call !== null && staticProcessMember(operation ?? undefined) === "on") {
    return call.arguments.length === 2 && stringOf(asNode(call.arguments[0])) === "data" && isFunction(call.arguments[1]);
  }
  if (call !== null && staticProcessMember(operation ?? undefined) === "destroy") return call.arguments.length === 1;
  const property = source.parents.get(liftedProcessNode(member, source));
  const options = property === undefined ? undefined : source.parents.get(property);
  const create = options === undefined ? undefined : source.parents.get(options);
  if (property?.type !== "Property" || property.computed || property.kind !== "init" || property.method ||
    nameOf(asNode(property.key)) !== "input" || property.value !== liftedProcessNode(member, source) ||
    options?.type !== "ObjectExpression" || options.properties.length !== 1 ||
    create?.type !== "CallExpression" || create.optional || create.arguments.length !== 1 || create.arguments[0] !== options) return false;
  const callee = asNode(create.callee);
  const binding = callee?.type === "Identifier" ? source.references.get(callee) : null;
  const specifier = binding === null || binding === undefined ? undefined : source.parents.get(binding);
  const declaration = specifier === undefined ? undefined : source.parents.get(specifier);
  return specifier?.type === "ImportSpecifier" && specifier.importKind !== "type" &&
    nameOf(asNode(specifier.imported)) === "createInterface" && declaration?.type === "ImportDeclaration" &&
    declaration.importKind !== "type" && ["node:readline", "readline"].includes(declaration.source.value);
}
/** A genuine immutable well-known symbol names one fixed protocol, never an arbitrary key. */
function asyncIteratorProtocolKey(node: Syntax, source: ProcessSource): boolean {
  const key = asNode(node.property);
  const symbol = key?.type === "MemberExpression" ? asNode(key.object) : null;
  return node.type === "MemberExpression" && node.computed && !node.optional && key?.computed === false && !key.optional &&
    nameOf(asNode(key.property)) === "asyncIterator" && symbol?.type === "Identifier" && symbol.name === "Symbol" &&
    source.references.get(symbol) === null && !writtenProcessNode(key, source) && directProcessCall(node, source)?.arguments.length === 0;
}

function ordinaryProcessUse(node: Syntax, source: ProcessSource): boolean {
  const member = processMember(node, source);
  const slot = staticProcessMember(member ?? undefined);
  if (member === null) return false;
  if (slot === "exitCode" && writtenProcessNode(member, source)) {
    const parent = source.parents.get(liftedProcessNode(member, source));
    const value = asNode(parent?.right);
    return parent?.type === "AssignmentExpression" && parent.operator === "=" && parent.left === liftedProcessNode(member, source) &&
      value?.type === "Literal" && typeof value.value === "number" && Number.isInteger(value.value) &&
      value.value >= 0 && value.value <= 255;
  }
  if (writtenProcessNode(member, source)) return false;
  if (slot === "stdin") return ordinaryStdinUse(member, source);
  if (["pid", "ppid", "execPath", "exitCode"].includes(slot ?? "")) return true;
  if (slot === "exit") return directProcessCall(member, source) !== null;
  const operation = processMember(member, source);
  const call = operation === null ? null : directProcessCall(operation, source);
  if (slot === "argv") return staticProcessMember(operation ?? undefined) === "includes" && call !== null &&
    call.arguments.length === 1 && (stringOf(asNode(call.arguments[0])) !== null ||
      (asNode(call.arguments[0])?.type === "Identifier" &&
        stringOf(bffConst(source.references.get(call.arguments[0])!, source)) !== null));
  if (slot === "stdout" || slot === "stderr") return staticProcessMember(operation ?? undefined) === "write" && call !== null;
  if (slot === "env") {
    const read = source.parents.get(liftedProcessNode(member, source));
    return staticProcessMember(read) !== null && read?.object === liftedProcessNode(member, source) && !writtenProcessNode(read, source);
  }
  return false;
}
function effectProcessUse(node: Syntax, source: ProcessSource): boolean {
  const member = processMember(node, source);
  const slot = staticProcessMember(member ?? undefined);
  if (member === null || slot === null || writtenProcessNode(member, source)) return false;
  if (EFFECT_PROCESS_CALLS.has(slot)) return directProcessCall(member, source) !== null;
  if (EFFECT_PROCESS_VALUES.has(slot)) return true;
  if (EFFECT_PIPE_TRANSFORMS.has(slot)) {
    const parent = source.parents.get(liftedProcessNode(member, source));
    if (parent?.type !== "CallExpression" || !(parent.arguments as Syntax[]).includes(liftedProcessNode(member, source))) return false;
    if (slot !== "result") return true;
    const callee = asNode(parent.callee);
    return !parent.optional && callee?.type === "MemberExpression" && !callee.optional && !callee.computed &&
      nameOf(asNode(callee.property)) === "pipe";
  }
  return false;
}

/** One immutable HTTP function is data at this edge; the global object itself never escapes. */
function nativeFetchAcquisition(node: Syntax, source: ProcessSource): boolean {
  const member = processMember(node, source);
  if (member === null || staticProcessMember(member) !== "fetch" || writtenProcessNode(member, source)) return false;
  const entry = source.parents.get(liftedProcessNode(member, source));
  const binding = asNode(entry?.id);
  if (entry?.type !== "VariableDeclarator" || entry.init !== member || binding?.type !== "Identifier" ||
    bffConst(binding, source) !== member || source.parents.get(source.parents.get(entry)!)?.type.startsWith("Export")) return false;
  const references = bffReferences(binding, source);
  return references.length > 0 && references.every((reference) => directProcessCall(reference, source) !== null);
}

/** Fixed non-enumerable error metadata cannot acquire or replace an evaluator/prototype slot. */
function localErrorCauseMetadata(member: Syntax, source: ProcessSource): boolean {
  const object = asNode(member.object);
  const call = directProcessCall(member, source);
  if (member.type !== "MemberExpression" || member.computed || member.optional ||
    nameOf(object) !== "Object" || source.references.get(object!) !== null || staticProcessMember(member) !== "defineProperty" ||
    call === null || call.arguments.length !== 3 || source.parents.get(call)?.type !== "ExpressionStatement" ||
    stringOf(asNode(call.arguments[1])) !== "cause") return false;
  const target = bffBinding(call.arguments[0], source);
  const created = target === null ? null : bffConst(target, source);
  const constructor = created?.type === "NewExpression" ? asNode(created.callee) : null;
  if (constructor?.type !== "Identifier" || target === null) return false;
  const origin = source.references.get(constructor);
  const specifier = origin === null || origin === undefined ? undefined : source.parents.get(origin);
  const imported = specifier === undefined ? undefined : source.parents.get(specifier);
  if (specifier?.type !== "ImportSpecifier" || specifier.importKind === "type" || imported?.type !== "ImportDeclaration" ||
    imported.importKind === "type" || !imported.source.value.startsWith(".") ||
    bffReferences(origin!, source).some((reference) => bffBindingWritten(reference, source))) return false;
  const descriptor = asNode(call.arguments[2]);
  if (descriptor?.type !== "ObjectExpression") return false;
  const keys = new Set<string>();
  for (const property of descriptor.properties as Syntax[]) {
    const key = property.computed ? null : nameOf(asNode(property.key)) ?? stringOf(asNode(property.key));
    if (property.type !== "Property" || property.kind !== "init" || property.method || key === null || keys.has(key) ||
      !["value", "configurable", "enumerable", "writable"].includes(key)) return false;
    keys.add(key);
    if (key !== "value" && (property.value.type !== "Literal" || typeof property.value.value !== "boolean" ||
      (key === "enumerable" && property.value.value !== false))) return false;
  }
  return keys.has("value");
}

/** A strict comparison consumes only a boolean, never the dynamically selected capability. */
function processScalarObservation(node: Syntax, source: ProcessSource): boolean {
  const held = liftedProcessNode(node, source);
  const parent = source.parents.get(held);
  return parent?.type === "BinaryExpression" && ["===", "!=="].includes(parent.operator) &&
    (parent.left === held || parent.right === held);
}

/** Only values from a literal, immutable, read-only native Map can become finite property keys. */
function processFiniteMapKeys(key: Syntax, source: ProcessSource): readonly string[] | null {
  const selected = bffBinding(key, source);
  const lookup = selected === null ? null : bffConst(selected, source);
  const callee = lookup?.type === "CallExpression" ? asNode(lookup.callee) : null;
  if (lookup?.type !== "CallExpression" || lookup.optional || lookup.arguments.length !== 1 ||
    lookup.arguments[0].type === "SpreadElement" || callee?.type !== "MemberExpression" || callee.computed ||
    callee.optional || staticProcessMember(callee) !== "get") return null;
  const map = bffBinding(callee.object, source);
  const created = map === null ? null : bffConst(map, source);
  const constructor = created?.type === "NewExpression" ? asNode(created.callee) : null;
  if (map === null || constructor?.type !== "Identifier" || constructor.name !== "Map" ||
    source.references.get(constructor) !== null || created?.arguments.length !== 1) return null;
  for (const [reference, binding] of source.references) {
    if (binding !== null || reference.name !== "Map") continue;
    const parent = source.parents.get(reference);
    if (parent?.type !== "NewExpression" || parent.callee !== reference) return null;
  }
  for (const reference of bffReferences(map, source)) {
    const member = processMember(reference, source);
    const call = member === null ? null : directProcessCall(member, source);
    if (member === null || staticProcessMember(member) !== "get" || call === null || call.arguments.length !== 1 ||
      call.arguments[0].type === "SpreadElement") return null;
  }
  const entries = asNode(created.arguments[0]);
  if (entries?.type !== "ArrayExpression" || entries.elements.length === 0) return null;
  const values: string[] = [];
  const names = new Set<string>();
  for (const entry of entries.elements) {
    if (entry?.type !== "ArrayExpression" || entry.elements.length !== 2) return null;
    const name = stringOf(asNode(entry.elements[0]));
    const value = stringOf(asNode(entry.elements[1]));
    if (name === null || value === null || names.has(name) || REFLECTIVE_MEMBERS.has(value)) return null;
    names.add(name);
    values.push(value);
  }
  return values;
}

/** Module location is a path string only in the closed native URL-to-path construction. */
function processModulePath(node: Syntax, source: ProcessSource): boolean {
  const url = source.parents.get(node);
  const created = url === undefined ? undefined : source.parents.get(url);
  const constructor = asNode(created?.callee);
  const pathname = created === undefined ? undefined : source.parents.get(created);
  const relative = asNode(created?.arguments?.[0]);
  if (node.type !== "MetaProperty" || nameOf(asNode(node.meta)) !== "import" || nameOf(asNode(node.property)) !== "meta" ||
    url?.type !== "MemberExpression" || url.computed || url.optional || url.object !== node || staticProcessMember(url) !== "url" ||
    created?.type !== "NewExpression" || created.arguments.length !== 2 || created.arguments[1] !== url ||
    constructor?.type !== "Identifier" || constructor.name !== "URL" || source.references.get(constructor) !== null ||
    relative === null || stringOf(relative) === null || !/^\.{1,2}\//u.test(stringOf(relative)!) ||
    pathname?.type !== "MemberExpression" || pathname.computed || pathname.optional || pathname.object !== created || staticProcessMember(pathname) !== "pathname" ||
    writtenProcessNode(pathname, source)) return false;
  for (const [reference, binding] of source.references) {
    if (binding !== null || reference.name !== "URL") continue;
    const parent = source.parents.get(reference);
    if (parent?.type === "NewExpression" && parent.callee === reference) continue;
    const member = processMember(reference, source);
    if (member === null || staticProcessMember(member) !== "canParse" || directProcessCall(member, source) === null) return false;
  }
  return true;
}

/** A static, read-only build flag is observed only as a boolean; no metadata capability escapes. */
function processModuleBoolean(node: Syntax, source: ProcessSource): boolean {
  const member = source.parents.get(node);
  const comparison = member === undefined ? undefined : source.parents.get(member);
  return node.type === "MetaProperty" && nameOf(asNode(node.meta)) === "import" && nameOf(asNode(node.property)) === "meta" &&
    member?.type === "MemberExpression" && !member.computed && !member.optional && member.object === node &&
    member.property.type === "Identifier" && !writtenProcessNode(member, source) &&
    comparison?.type === "BinaryExpression" && comparison.operator === "===" && comparison.left === member &&
    comparison.right.type === "Literal" && typeof comparison.right.value === "boolean";
}

/** Close acquisitions and every capability reference before deriving any root/declaration fact. */
function closedProcessSource(program: ESTree.Program, source: ProcessSource, capabilities: ProcessCapabilities): boolean {
  if (!source.valid || !capabilities.valid) return false;
  const inspect = (node: Syntax): boolean => {
    if (ERASED_PROCESS_SYNTAX.has(node.type) || node.declare === true || node.type === "ImportDeclaration" ||
      (["ExportNamedDeclaration", "ExportAllDeclaration", "ExportSpecifier"].includes(node.type) && node.exportKind === "type")) return true;
    if (node.type === "ImportExpression" || (node.type === "MetaProperty" && !processModulePath(node, source) && !processModuleBoolean(node, source)) || UNSUPPORTED_PROCESS_SYNTAX.has(node.type)) return false;
    if (node.type === "MemberExpression") {
      const key = processMemberKey(node);
      const property = asNode(node.property);
      // Unknown computed acquisition can conceal a constructor/prototype; numeric array indices cannot.
      if ((REFLECTIVE_MEMBERS.has(key ?? "") && !localErrorCauseMetadata(node, source)) || (node.computed && key === null &&
        !(property !== null && unwrap(property).type === "Literal" && typeof unwrap(property).value === "number") &&
        !asyncIteratorProtocolKey(node, source) && !processScalarObservation(node, source) &&
        !(property !== null && processFiniteMapKeys(property, source) !== null))) return false;
    }
    return processChildren(node).every(inspect);
  };
  if (!inspect(program as Syntax)) return false;
  for (const [reference, binding] of source.references) {
    const capability = binding === null ? (reference.name === "process" ? "process" : null) : capabilities.bindings.get(binding);
    if (binding === null && EVALUATOR_GLOBALS.has(reference.name) &&
      !(reference.name === "globalThis" && nativeFetchAcquisition(reference, source))) return false;
    if (binding === null && reference.name === "Object") {
      const member = processMember(reference, source);
      if (member === null || (!OBJECT_DATA_CALLS.has(staticProcessMember(member) ?? "") && !localErrorCauseMetadata(member, source)) || directProcessCall(member, source) === null) return false;
    }
    if (binding === null && reference.name === "Symbol") {
      const key = processMember(reference, source);
      const access = key === null ? undefined : source.parents.get(liftedProcessNode(key, source));
      if (key === null || staticProcessMember(key) !== "asyncIterator" || access?.type !== "MemberExpression" ||
        access.property !== liftedProcessNode(key, source) || !asyncIteratorProtocolKey(access, source)) return false;
    }
    if (capability === "process" && !ordinaryProcessUse(reference, source)) return false;
    if (capability === "effect" && !effectProcessUse(reference, source)) return false;
    if (capability === "node-main" && directProcessCall(reference, source) === null) return false;
    if (capability === "node-runtime") {
      const member = processMember(reference, source);
      if (member === null || staticProcessMember(member) !== "runMain" || directProcessCall(member, source) === null) return false;
    }
  }
  return true;
}
function genuineEffectFunction(node: Syntax, source: ProcessSource, capabilities: ProcessCapabilities): boolean {
  if (node.type !== "CallExpression" || node.optional || node.arguments.length !== 1 || !isFunction(node.arguments[0])) return false;
  const factory = asNode(node.callee);
  const callee = asNode(factory?.callee);
  const object = asNode(callee?.object);
  const binding = object === null ? null : source.references.get(unwrap(object));
  return factory?.type === "CallExpression" && !factory.optional && factory.arguments.length === 1 &&
    stringOf(asNode(factory.arguments[0])) !== null && staticProcessMember(callee ?? undefined) === "fn" && callee?.computed === false &&
    binding !== null && binding !== undefined && capabilities.bindings.get(binding) === "effect";
}
function ownsConstructor(program: ESTree.Program, importedName: string): boolean {
  const source = processSource(program);
  const capabilities = processCapabilities(program);
  if (!closedProcessSource(program, source, capabilities)) return false;
  return program.body.some((statement) => {
    if (statement.type !== "ExportNamedDeclaration" || statement.source !== null || statement.declaration === null) return false;
    const declaration = statement.declaration as Syntax;
    const entries = declaration.type === "FunctionDeclaration" ? [{ id: declaration.id, init: declaration }] :
      declaration.type === "VariableDeclaration" && declaration.kind === "const" ? declaration.declarations : [];
    return (entries as Syntax[]).some((entry) => {
      const binding = asNode(entry.id);
      const initializer = asNode(entry.init);
      if (nameOf(binding) !== importedName || initializer === null ||
        !(isFunction(initializer) || genuineEffectFunction(initializer, source, capabilities))) return false;
      return ![...source.references].some(([reference, resolved]) => resolved === binding && writtenProcessNode(reference, source));
    });
  });
}

/** Executable test processes compose only their own owner's private services. */
/** An exported TEST control may close over fresh scalar state and explicit callback arguments only.
 * No acquisition, imported/module binding, member access, computed key or callback escape is admitted.
 */
function closedTestControlExport(statement: Syntax, source: ProcessSource): boolean {
  const declaration = asNode(statement.declaration);
  if (statement.type !== "ExportNamedDeclaration" || statement.source !== null || statement.specifiers.length !== 0 ||
    declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" || declaration.declarations.length !== 1) return false;
  const entry = asNode(declaration.declarations[0]);
  const factory = asNode(entry?.init);
  if (entry?.id.type !== "Identifier" || factory?.type !== "ArrowFunctionExpression" || factory.async ||
    factory.params.length !== 0 || factory.body.type !== "BlockStatement") return false;
  const statements = factory.body.body as Syntax[];
  const returned = statements.at(-1);
  if (returned?.type !== "ReturnStatement" || returned.argument?.type !== "ObjectExpression") return false;
  const state = new Set<Syntax>();
  for (const local of statements.slice(0, -1)) {
    if (local.type !== "VariableDeclaration" || !["const", "let"].includes(local.kind)) return false;
    for (const variable of local.declarations) {
      if (variable.id.type !== "Identifier" || variable.init?.type !== "Literal" ||
        (variable.init.value !== null && !["string", "number", "boolean"].includes(typeof variable.init.value))) return false;
      state.add(variable.id);
    }
  }
  const allowed = new Set([
    "ArrowFunctionExpression", "BlockStatement", "IfStatement", "ReturnStatement", "ExpressionStatement",
    "ObjectExpression", "Property", "Identifier", "Literal", "BinaryExpression", "LogicalExpression",
    "UnaryExpression", "AssignmentExpression", "UpdateExpression", "CallExpression", "ParenthesizedExpression",
  ]);
  const methods = new Set<Syntax>();
  const parameters = new Set<Syntax>();
  const callbacks = new Set<Syntax>();
  for (const property of returned.argument.properties as Syntax[]) {
    const method = asNode(property.value);
    if (property.type !== "Property" || property.computed || property.method || property.kind !== "init" ||
      method?.type !== "ArrowFunctionExpression" || method.async || method.params.some((param: Syntax) => param.type !== "Identifier")) return false;
    methods.add(method);
    for (const parameter of method.params as Syntax[]) {
      const type = parameter.typeAnnotation?.typeAnnotation;
      if (type?.type === "TSFunctionType" && type.params.length === 0 && type.returnType?.typeAnnotation?.type === "TSVoidKeyword") callbacks.add(parameter);
      else if (!["TSStringKeyword", "TSNumberKeyword", "TSBooleanKeyword"].includes(type?.type ?? "")) return false;
      parameters.add(parameter);
    }
  }
  const inspect = (node: Syntax): boolean => {
    if (!allowed.has(node.type)) return false;
    if (node.type === "ArrowFunctionExpression" && !methods.has(node)) return false;
    if (node.type === "Property" && (node.computed || node.method || node.kind !== "init" || REFLECTIVE_MEMBERS.has(nameOf(asNode(node.key)) ?? ""))) return false;
    if (node.type === "UnaryExpression" && !["!", "+", "-"].includes(node.operator)) return false;
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      const target = asNode(node.type === "AssignmentExpression" ? node.left : node.argument);
      if (target?.type !== "Identifier" || !state.has(source.references.get(target)!)) return false;
    }
    if (node.type === "CallExpression") {
      const callee = asNode(node.callee);
      const binding = callee?.type === "Identifier" ? source.references.get(callee) : null;
      if (node.optional || node.arguments.length !== 0 || binding === null || binding === undefined ||
        !parameters.has(binding) || source.parents.get(node)?.type !== "ExpressionStatement") return false;
      callbacks.add(binding);
    }
    const binding = source.references.get(node);
    if (node.type === "Identifier" && binding !== undefined && (binding === null || (!state.has(binding) && !parameters.has(binding)))) return false;
    return processChildren(node).every(inspect);
  };
  if (!inspect(returned.argument)) return false;
  for (const [reference, binding] of source.references) {
    if (binding !== null && callbacks.has(binding) && directProcessCall(reference, source) === null) return false;
  }
  return true;
}

function testProcessOwner(context: Context, program: ESTree.Program): string | null {
  const filename = nodePath.resolve(context.filename).replaceAll("\\", "/");
  const owner = /^(.*\/app\/(?:apps|verticals)\/[^/]+)\/tests\/support\/.+\.[cm]?[jt]sx?$/u.exec(filename)?.[1];
  if (owner === undefined) return null;
  const source = processSource(program);
  if (program.body.some((node) => node.type.startsWith("Export") && !closedTestControlExport(node as Syntax, source))) return null;
  const capabilities = processCapabilities(program);
  if (!closedProcessSource(program, source, capabilities)) return null;
  const mains = program.body.filter((statement) => {
    if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") return false;
    const call = statement.expression;
    const callee = call.callee;
    if (!call.optional && callee.type === "Identifier" && capabilities.bindings.get(source.references.get(callee as Syntax)!) === "node-main") return true;
    if (call.optional || callee.type !== "MemberExpression" || callee.computed || callee.optional ||
      callee.object.type !== "Identifier" || callee.property.type !== "Identifier" || callee.property.name !== "runMain") return false;
    const binding = source.references.get(callee.object as Syntax);
    if (binding === null || binding === undefined || capabilities.bindings.get(binding) !== "node-runtime") return false;
    const variable = lookupVariable(context, callee.object);
    if (variable === null || variable.defs.length !== 1) return false;
    const definition = variable.defs[0];
    return definition !== undefined && definition.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration" &&
      definition.parent.importKind !== "type" && definition.parent.source.value === "@effect/platform-node" &&
      definition.node.type === "ImportSpecifier" && definition.node.importKind !== "type" &&
      definition.node.local === binding && getImportedName(definition.node) === "NodeRuntime";
  });
  const runtimeCalls = [...source.references].filter(([reference, binding]) => binding !== null && ["node-runtime", "node-main"].includes(capabilities.bindings.get(binding) ?? ""));
  return mains.length === 1 && runtimeCalls.length === 1 ? owner : null;
}

/** A governed assembly is a composition category, not a purity proof for its opaque handlers. */
interface BffImport {
  readonly binding: Syntax;
  readonly imported: string;
  readonly source: string;
  readonly typeOnly: boolean;
}
function bffImports(program: ESTree.Program): BffImport[] {
  return program.body.flatMap((statement) => statement.type === "ImportDeclaration" ?
    statement.specifiers.map((specifier) => ({
      binding: specifier.local as Syntax,
      imported: processExportSlot(specifier) ?? "*",
      source: statement.source.value,
      typeOnly: statement.importKind === "type" || (specifier.type === "ImportSpecifier" && specifier.importKind === "type"),
    })) : []);
}
function bffBinding(node: Syntax, source: ProcessSource): Syntax | null {
  const value = unwrap(node);
  return value.type === "Identifier" ? source.references.get(value) ?? null : null;
}
function bffReferences(binding: Syntax, source: ProcessSource): Syntax[] {
  return [...source.references].filter(([, value]) => value === binding).map(([reference]) => reference);
}
/** Assignment patterns write bindings too; a direct Identifier-only write check is insufficient. */
function bffBindingWritten(reference: Syntax, source: ProcessSource): boolean {
  let current = liftedProcessNode(reference, source);
  let parent = source.parents.get(current);
  while (parent !== undefined) {
    const patternProperty = parent.type === "Property" && parent.value === current && source.parents.get(parent)?.type === "ObjectPattern";
    const pattern = (parent.type === "ObjectPattern" && (parent.properties as Syntax[]).includes(current)) ||
      (parent.type === "ArrayPattern" && (parent.elements as (Syntax | null)[]).includes(current)) ||
      (parent.type === "RestElement" && parent.argument === current) ||
      (parent.type === "AssignmentPattern" && parent.left === current);
    if (!patternProperty && !pattern && !(parent.type === "MemberExpression" && parent.object === current)) break;
    current = liftedProcessNode(parent, source);
    parent = source.parents.get(current);
  }
  return (parent?.type === "AssignmentExpression" && parent.left === current) ||
    (parent?.type === "UpdateExpression" && parent.argument === current) ||
    (parent?.type === "UnaryExpression" && parent.operator === "delete" && parent.argument === current) ||
    ((parent?.type === "ForInStatement" || parent?.type === "ForOfStatement") && parent.left === current);
}
function bffKeyParameterUsesClosed(binding: Syntax, source: ProcessSource, seen = new Set<Syntax>()): boolean {
  if (seen.has(binding)) return false;
  const next = new Set(seen).add(binding);
  const references = bffReferences(binding, source);
  return references.length > 0 && references.every((reference) => {
    if (bffBindingWritten(reference, source)) return false;
    const current = liftedProcessNode(reference, source);
    const parent = source.parents.get(current);
    if (parent?.type === "MemberExpression" && parent.computed && !parent.optional && parent.property === current) return true;
    if (parent?.type !== "VariableDeclarator" || parent.init !== current || parent.id.type !== "Identifier") return false;
    const declaration = source.parents.get(parent);
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" ||
      source.parents.get(declaration)?.type.startsWith("Export") || bffConst(parent.id, source) === null) return false;
    return bffKeyParameterUsesClosed(parent.id, source, next);
  });
}
function bffConst(binding: Syntax, source: ProcessSource): Syntax | null {
  const entry = source.parents.get(binding);
  const statement = entry === undefined ? undefined : source.parents.get(entry);
  return entry?.type === "VariableDeclarator" && entry.id === binding && statement?.type === "VariableDeclaration" &&
    statement.kind === "const" && !bffReferences(binding, source).some((reference) => bffBindingWritten(reference, source)) ? asNode(entry.init) : null;
}
function bffImmutable(binding: Syntax, source: ProcessSource, imports: readonly BffImport[]): boolean {
  return !bffReferences(binding, source).some((reference) => bffBindingWritten(reference, source)) &&
    (bffConst(binding, source) !== null || imports.some((entry) => entry.binding === binding && !entry.typeOnly));
}
function bffKeyValues(node: Syntax, source: ProcessSource, seen = new Set<Syntax>()): readonly (string | number)[] | null {
  const value = unwrap(node);
  if (value.type === "Literal" && (typeof value.value === "string" || typeof value.value === "number")) return [value.value];
  const binding = bffBinding(value, source);
  if (binding === null || seen.has(binding)) return null;
  const next = new Set(seen).add(binding);
  const initializer = bffConst(binding, source);
  if (initializer !== null) return bffKeyValues(initializer, source, next);
  // Only an exact, non-default simple parameter with every direct caller closed can acquire finite keys.
  const owner = source.parents.get(binding);
  if (owner === undefined || !isFunction(owner) || owner.async || owner.generator || !owner.params.includes(binding)) return null;
  if (!bffKeyParameterUsesClosed(binding, source)) return null;
  const entry = source.parents.get(owner);
  const declaration = entry === undefined ? undefined : source.parents.get(entry);
  const functionBinding = asNode(entry?.id);
  if (entry?.type !== "VariableDeclarator" || entry.init !== owner || declaration?.type !== "VariableDeclaration" ||
    declaration.kind !== "const" || functionBinding === null || source.parents.get(declaration)?.type.startsWith("Export") ||
    bffConst(functionBinding, source) !== owner || seen.has(functionBinding)) return null;
  const references = bffReferences(functionBinding, source);
  if (references.length === 0) return null;
  const keys: (string | number)[] = [];
  const index = owner.params.indexOf(binding);
  for (const reference of references) {
    const call = directProcessCall(reference, source);
    if (call === null || call.arguments.some((argument: Syntax) => argument.type === "SpreadElement")) return null;
    // Recursion, including a call inside a nested callback, is unsupported.
    for (let parent = source.parents.get(call); parent !== undefined; parent = source.parents.get(parent)) if (parent === owner) return null;
    const argument = asNode(call.arguments[index]);
    if (argument === null) return null;
    const values = bffKeyValues(argument, source, new Set(next).add(functionBinding));
    if (values === null) return null;
    keys.push(...values);
  }
  return keys;
}
function bffScalarLiteral(node: Syntax | null): boolean {
  const value = node === null ? null : unwrap(node);
  return value?.type === "Literal" && (value.value === null || ["string", "number", "boolean", "bigint"].includes(typeof value.value));
}
function bffObservedOnly(node: Syntax, source: ProcessSource, seen = new Set<Syntax>()): boolean {
  const current = liftedProcessNode(node, source);
  const parent = source.parents.get(current);
  if (parent?.type === "BinaryExpression" && ["===", "!=="].includes(parent.operator)) {
    return (parent.left === current && bffScalarLiteral(asNode(parent.right))) ||
      (parent.right === current && bffScalarLiteral(asNode(parent.left)));
  }
  if (parent?.type !== "VariableDeclarator" || parent.init !== current) return false;
  const binding = asNode(parent.id);
  const declaration = source.parents.get(parent);
  if (binding?.type !== "Identifier" || declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" ||
    source.parents.get(declaration)?.type.startsWith("Export") || seen.has(binding) || bffConst(binding, source) === null) return false;
  const references = bffReferences(binding, source);
  const next = new Set(seen).add(binding);
  return references.length > 0 && references.every((reference) => bffObservedOnly(reference, source, next));
}
function bffKnownFunction(node: Syntax, source: ProcessSource, seen = new Set<Syntax>()): boolean {
  const value = unwrap(node);
  if (isFunction(value) || value.type === "ClassExpression") return true;
  const binding = bffBinding(value, source);
  if (binding === null || seen.has(binding)) return false;
  const declaration = source.parents.get(binding);
  if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") return true;
  const initializer = bffConst(binding, source);
  return initializer !== null && bffKnownFunction(initializer, source, new Set(seen).add(binding));
}
function bffOriginClosed(program: ESTree.Program, source: ProcessSource, capabilities: ProcessCapabilities): boolean {
  if (!source.valid || !capabilities.valid) return false;
  const inspect = (node: Syntax): boolean => {
    if (ERASED_PROCESS_SYNTAX.has(node.type) || node.declare === true || node.type === "ImportDeclaration" ||
      (["ExportNamedDeclaration", "ExportAllDeclaration", "ExportSpecifier"].includes(node.type) && node.exportKind === "type")) return true;
    if (node.type === "ImportExpression" || node.type === "MetaProperty" || UNSUPPORTED_PROCESS_SYNTAX.has(node.type)) return false;
    if (node.type === "ObjectPattern") for (const property of node.properties) {
      if (property.type === "RestElement") continue;
      const key = property.computed ? stringOf(asNode(property.key)) : nameOf(asNode(property.key)) ?? stringOf(asNode(property.key));
      if (key === null || REFLECTIVE_MEMBERS.has(key)) return false;
    }
    if (node.type === "MemberExpression") {
      const key = processMemberKey(node);
      if (REFLECTIVE_MEMBERS.has(key ?? "")) return false;
      if (node.computed && key === null) {
        const property = asNode(node.property);
        const object = asNode(node.object);
        if (node.optional || property === null || object === null) return false;
        const keys = bffKeyValues(property, source);
        if (keys !== null) {
          if (keys.some((candidate) => typeof candidate === "string" && REFLECTIVE_MEMBERS.has(candidate))) return false;
        } else if (bffKnownFunction(object, source) || !bffObservedOnly(node, source)) return false;
      }
    }
    return processChildren(node).every(inspect);
  };
  if (!inspect(program as Syntax)) return false;
  for (const [reference, binding] of source.references) {
    if (binding === null && EVALUATOR_GLOBALS.has(reference.name)) return false;
    if (binding === null && reference.name === "Object") {
      const member = processMember(reference, source);
      if (member === null || !OBJECT_DATA_CALLS.has(staticProcessMember(member) ?? "") || directProcessCall(member, source) === null) return false;
    }
    const capability = binding === null ? (reference.name === "process" ? "process" : null) : capabilities.bindings.get(binding);
    if (capability === "process" && !ordinaryProcessUse(reference, source)) return false;
    if (capability === "node-runtime" || capability === "node-main") return false;
    if (capability === "effect") {
      const member = processMember(reference, source);
      // Assembly classification permits direct public calls, not capability aliases or mutation.
      if (member === null || writtenProcessNode(member, source) ||
        (directProcessCall(member, source) === null && !effectProcessUse(reference, source))) return false;
    }
  }
  return true;
}
function bffImportedType(node: Syntax, imported: string, imports: readonly BffImport[], api: Syntax, program: ESTree.Program): boolean {
  const typeName = node.type === "TSTypeReference" ? asNode(node.typeName) : null;
  if (typeName?.type !== "Identifier") return false;
  const origin = imports.find((entry) => entry.binding.name === typeName.name && entry.imported === imported &&
    entry.source === "@modern-js/bff-effect/effect-edge");
  if (origin === undefined) return false;
  // Type annotations are identity evidence only when no local type declaration can replace the import.
  const conflicting = (value: Syntax): boolean => {
    if ((["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "ClassDeclaration", "TSEnumDeclaration"].includes(value.type) && value.id?.name === origin.binding.name) ||
      (value.type === "TSTypeParameter" && (value.name === origin.binding.name || value.name?.name === origin.binding.name))) return true;
    return Object.entries(value).some(([key, child]) => key !== "parent" &&
      (Array.isArray(child) ? child : [child]).some((entry) => asNode(entry) !== null && conflicting(entry)));
  };
  if (conflicting(program as Syntax)) return false;
  const arguments_ = node.typeArguments?.params ?? node.typeParameters?.params;
  return arguments_?.length === 1 && arguments_[0].type === "TSTypeQuery" && arguments_[0].exprName.type === "Identifier" && arguments_[0].exprName.name === api.name;
}
function bffLayerExpression(node: Syntax, source: ProcessSource, imports: readonly BffImport[], layers: ReadonlySet<Syntax>, mode: "handlers" | "transport"): boolean {
  const immutableArgument = (argument: Syntax): boolean => {
    const binding = bffBinding(argument, source);
    return binding !== null && bffImmutable(binding, source, imports);
  };
  const layerMember = (value: Syntax, name: string): boolean => {
    const object = asNode(value.object);
    const binding = object === null ? null : bffBinding(object, source);
    return value.type === "MemberExpression" && !value.computed && !value.optional && value.property.name === name && binding !== null && layers.has(binding);
  };
  const transform = (value: Syntax): boolean => {
    if (layerMember(value, "orDie")) return true;
    const callee = asNode(value.callee);
    return value.type === "CallExpression" && !value.optional && callee !== null &&
      (layerMember(callee, "provide") || layerMember(callee, "provideMerge")) && value.arguments.length === 1 && immutableArgument(value.arguments[0]);
  };
  let base = unwrap(node);
  if (base.type === "CallExpression" && !base.optional && base.callee.type === "MemberExpression" && !base.callee.computed &&
    !base.callee.optional && base.callee.property.name === "pipe") {
    if (!base.arguments.every((argument: Syntax) => transform(unwrap(argument)))) return false;
    base = unwrap(base.callee.object);
  }
  if (mode === "transport") {
    const binding = bffBinding(base, source);
    const origin = imports.find((entry) => entry.binding === binding && !entry.typeOnly && entry.source.startsWith("."));
    return origin !== undefined && bffImmutable(origin.binding, source, imports);
  }
  const callee = asNode(base.callee);
  return base.type === "CallExpression" && !base.optional && callee !== null && layerMember(callee, "mergeAll") &&
    base.arguments.length > 0 && base.arguments.every((argument: Syntax) => immutableArgument(argument));
}
function bffLayerValueUse(node: Syntax, source: ProcessSource, layers: ReadonlySet<Syntax>, seen = new Set<Syntax>()): boolean {
  const value = liftedProcessNode(node, source);
  const parent = source.parents.get(value);
  if (parent?.type === "ConditionalExpression" && (parent.consequent === value || parent.alternate === value)) return bffLayerValueUse(parent, source, layers, seen);
  if (parent?.type === "VariableDeclarator" && parent.init === value && parent.id.type === "Identifier") {
    const binding = parent.id as Syntax;
    const declaration = source.parents.get(parent);
    if (seen.has(binding) || bffConst(binding, source) === null ||
      (declaration !== undefined && source.parents.get(declaration)?.type.startsWith("Export"))) return false;
    const references = bffReferences(binding, source);
    return references.length > 0 && references.every((reference) => bffLayerValueUse(reference, source, layers, new Set(seen).add(binding)));
  }
  const callee = parent?.type === "CallExpression" ? asNode(parent.callee) : null;
  return parent?.type === "CallExpression" && !parent.optional && (parent.arguments as Syntax[]).includes(value) &&
    callee?.type === "MemberExpression" && !callee.computed && !callee.optional &&
    ["mergeAll", "provide", "provideMerge"].includes(callee.property.name) && layers.has(bffBinding(callee.object, source)!);
}

function ownsGovernedBff(program: ESTree.Program, importedName: string, filename: string, owner: string): boolean {
  if (nodePath.resolve(filename) !== nodePath.join(owner, "api/index.ts")) return false;
  const source = processSource(program);
  const capabilities = processCapabilities(program);
  const imports = bffImports(program);
  if (!bffOriginClosed(program, source, capabilities)) return false;
  const assemblers = imports.filter((entry) => entry.source === "@modern-js/bff-effect/assembly" && !entry.typeOnly);
  if (assemblers.length === 0 || assemblers.some((entry) => entry.imported !== "assembleEffectBffRuntime") ||
    imports.some((entry) => !entry.typeOnly && entry.source.startsWith("@modern-js/bff-effect/assembly/"))) return false;
  const alternateLayerBarrels = new Set(["@modern-js/bff-effect/effect-server", "@modern-js/bff-effect/effect", "@modern-js/plugin-bff/server"]);
  if (imports.some((entry) => !entry.typeOnly && (entry.source.startsWith("effect/Layer") ||
    entry.source.startsWith("@modern-js/bff-effect/effect-edge/") ||
    (alternateLayerBarrels.has(entry.source) && ["Layer", "default", "*"].includes(entry.imported))))) return false;
  const layers = new Set(imports.filter((entry) => !entry.typeOnly && entry.imported === "Layer" &&
    ["effect", "@modern-js/bff-effect/effect-edge"].includes(entry.source)).map((entry) => entry.binding));
  if (layers.size === 0 || imports.some((entry) => !entry.typeOnly && entry.source === "@modern-js/bff-effect/effect-edge" &&
    ["default", "*"].includes(entry.imported))) return false;
  for (const binding of layers) for (const reference of bffReferences(binding, source)) {
    const member = processMember(reference, source);
    if (member === null || writtenProcessNode(member, source)) return false;
    if (staticProcessMember(member) === "empty") {
      if (!bffLayerValueUse(member, source, layers)) return false;
    } else if (directProcessCall(member, source) === null && !(staticProcessMember(member) === "orDie" &&
      source.parents.get(member)?.type === "CallExpression" && source.parents.get(member)?.arguments.includes(member))) return false;
  }
  const exported = program.body.find((statement) => statement.type === "ExportNamedDeclaration" && statement.source === null &&
    statement.declaration?.type === "VariableDeclaration" && statement.declaration.kind === "const" &&
    statement.declaration.declarations.some((entry) => entry.id.type === "Identifier" && entry.id.name === importedName));
  const declaration = exported?.type === "ExportNamedDeclaration" && exported.declaration?.type === "VariableDeclaration" ?
    exported.declaration.declarations.find((entry) => entry.id.type === "Identifier" && entry.id.name === importedName) : undefined;
  const factory = declaration === undefined ? null : asNode(declaration.init);
  if (factory === null || !isFunction(factory) || factory.async || factory.generator || factory.body.type !== "BlockStatement") return false;
  const factoryBinding = declaration!.id as Syntax;
  if (bffConst(factoryBinding, source) !== factory || bffReferences(factoryBinding, source).some((reference) => directProcessCall(reference, source) === null)) return false;
  const ownReturns: Syntax[] = [];
  const collectReturns = (node: Syntax): void => {
    if (node !== factory && isFunction(node)) return;
    if (node.type === "ReturnStatement") ownReturns.push(node);
    for (const child of processChildren(node)) collectReturns(child);
  };
  collectReturns(factory);
  const terminal = factory.body.body.at(-1);
  if (ownReturns.length !== 1 || terminal !== ownReturns[0]) return false;
  const call = asNode(terminal.argument);
  if (call?.type !== "CallExpression" || call.optional || call.arguments.length !== 1) return false;
  const assembler = bffBinding(call.callee, source);
  if (assembler === null || !assemblers.some((entry) => entry.binding === assembler)) return false;
  if (assemblers.some((entry) => bffReferences(entry.binding, source).some((reference) => directProcessCall(reference, source) !== call))) return false;
  const argument = asNode(call.arguments[0]);
  if (argument?.type !== "ObjectExpression" || argument.properties.length < 2 || argument.properties.length > 3) return false;
  const properties = new Map<string, Syntax>();
  for (const property of argument.properties as Syntax[]) {
    const key = property.computed ? null : nameOf(asNode(property.key)) ?? stringOf(asNode(property.key));
    if (property.type !== "Property" || property.kind !== "init" || property.method || key === null ||
      !["api", "handlers", "transport"].includes(key) || properties.has(key)) return false;
    properties.set(key, property.value);
  }
  const api = properties.get("api");
  const apiBinding = api === undefined ? null : bffBinding(api, source);
  const apiOrigin = imports.find((entry) => entry.binding === apiBinding && !entry.typeOnly && entry.source.startsWith("."));
  if (apiBinding === null || apiOrigin === undefined || !bffImmutable(apiBinding, source, imports)) return false;
  const apiFilename = resolveModule(filename, apiOrigin.source);
  try {
    if (apiFilename === null || nodePath.relative(realpathSync(owner), realpathSync(apiFilename)).startsWith("..")) return false;
  } catch { return false; }
  const annotation = factory.returnType?.typeAnnotation;
  if (annotation?.type !== "TSIntersectionType" || annotation.types.length !== 2 ||
    !["EffectBffDefinition", "EffectBffRuntime"].every((type) => annotation.types.some((entry: Syntax) => bffImportedType(entry, type, imports, apiBinding, program)))) return false;
  const builderBindings = new Set(imports.filter((entry) => !entry.typeOnly && entry.source === "@modern-js/bff-effect/effect-edge" && entry.imported === "HttpApiBuilder").map((entry) => entry.binding));
  for (const binding of builderBindings) for (const reference of bffReferences(binding, source)) {
    const member = processMember(reference, source);
    if (member === null || staticProcessMember(member) !== "group" || writtenProcessNode(member, source) || directProcessCall(member, source) === null) return false;
  }
  const apiFamily: Syntax[] = [];
  for (const origin of imports.filter((entry) => !entry.typeOnly && entry.source.startsWith("."))) {
    const resolved = resolveModule(filename, origin.source);
    try {
      if (resolved === null || apiFilename === null || realpathSync(resolved) !== realpathSync(apiFilename)) continue;
    } catch { return false; }
    if (["default", "*"].includes(origin.imported)) return false;
    if (origin.imported === apiOrigin.imported) apiFamily.push(origin.binding);
  }
  for (const binding of apiFamily) for (const reference of bffReferences(binding, source)) {
    if (reference === api) continue;
    const parent = source.parents.get(liftedProcessNode(reference, source));
    const callee = parent?.type === "CallExpression" ? asNode(parent.callee) : null;
    if (parent?.type !== "CallExpression" || parent.optional || parent.arguments[0] !== reference || callee?.type !== "MemberExpression" ||
      callee.computed || callee.optional || callee.property.name !== "group" || !builderBindings.has(bffBinding(callee.object, source)!)) return false;
  }
  const handlers = properties.get("handlers");
  const handlerBinding = handlers === undefined ? null : bffBinding(handlers, source);
  const handlerInitializer = handlerBinding === null ? null : bffConst(handlerBinding, source);
  if (handlerInitializer === null || bffReferences(handlerBinding!, source).some((reference) => reference !== handlers) ||
    !bffLayerExpression(handlerInitializer, source, imports, layers, "handlers")) return false;
  const transport = properties.get("transport");
  if (transport !== undefined) {
    if (!bffLayerExpression(transport, source, imports, layers, "transport")) return false;
    const inspectTransport = unwrap(transport);
    const base = inspectTransport.type === "CallExpression" ? unwrap((inspectTransport.callee as Syntax).object) : inspectTransport;
    const binding = bffBinding(base, source);
    const origin = imports.find((entry) => entry.binding === binding);
    const resolved = origin === undefined ? null : resolveModule(filename, origin.source);
    try {
      if (resolved === null || nodePath.relative(realpathSync(owner), realpathSync(resolved)).startsWith("..") ||
        binding === null || bffReferences(binding, source).some((reference) => reference !== base)) return false;
      for (const candidate of imports.filter((entry) => !entry.typeOnly && entry.source.startsWith("."))) {
        const alternative = resolveModule(filename, candidate.source);
        if (alternative === null || realpathSync(alternative) !== realpathSync(resolved)) continue;
        if (["default", "*"].includes(candidate.imported)) return false;
        if (candidate.imported === origin!.imported && bffReferences(candidate.binding, source).some((reference) => reference !== base)) return false;
      }
    } catch { return false; }
  }
  return true;
}

function isOwnerLocalConstructor(filename: string, source: string, owner: string, importedName: string): boolean {
  const resolved = resolveModule(filename, source);
  if (resolved === null) return false;
  try {
    const relative = nodePath.relative(realpathSync(owner), realpathSync(resolved));
    if (relative === "" || relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) return false;
    const parsed = parseSync(resolved, readFileSync(resolved, "utf8"), { sourceType: "module" });
    const program = asNode(parsed.program);
    return parsed.errors.length === 0 && program?.type === "Program" && (ownsConstructor(program, importedName) ||
      ownsGovernedBff(program, importedName, resolved, realpathSync(owner)));
  } catch {
    return false;
  }
}

function writesMember(identifier: ESTree.Node): boolean {
  let current = identifier;
  while (current.parent?.type === "MemberExpression" && current.parent.object === current) current = current.parent;
  const parent = current.parent;
  return (parent?.type === "AssignmentExpression" && parent.left === current) ||
    (parent?.type === "UpdateExpression" && parent.argument === current) ||
    (parent?.type === "UnaryExpression" && parent.operator === "delete" && parent.argument === current);
}

function unchanged(variable: Variable): boolean {
  return !variable.references.some((reference) =>
    (reference.isWrite() && !reference.init) || writesMember(reference.identifier));
}

function nativeImport(context: Context, node: Syntax | null, source: string, name: string): boolean {
  if (node?.type !== "Identifier") return false;
  const variable = lookupVariable(context, node);
  if (variable?.defs.length !== 1 || !unchanged(variable)) return false;
  const [definition] = variable.defs;
  const declaration = definition?.parent;
  const specifier = definition?.node;
  return definition?.type === "ImportBinding" && declaration?.type === "ImportDeclaration" &&
    declaration.source.value === source && declaration.importKind !== "type" &&
    specifier?.type === "ImportSpecifier" && specifier.importKind !== "type" &&
    getImportedName(specifier) === name &&
    (!["Layer", "Effect"].includes(name) || variable.references.every((reference) => {
      const parent = reference.identifier.parent;
      return (parent?.type === "MemberExpression" && parent.object === reference.identifier) ||
        (parent?.type === "TSQualifiedName" && parent.left === reference.identifier);
    }));
}

function nativeMethod(context: Context, expression: Syntax, namespace: string, method: string): boolean {
  const node = unwrap(expression);
  return node.type === "MemberExpression" && !node.computed &&
    nameOf(asNode(node.property)) === method &&
    nativeImport(context, node.object, "effect", namespace);
}

function intactNamespaces(program: ESTree.Program, namespaces: ReadonlyMap<string, string>): boolean {
  const pending = [program as Syntax];
  while (pending.length > 0) {
    const node = pending.pop()!;
    let target = asNode(node.type === "AssignmentExpression" ? node.left :
      node.type === "UpdateExpression" || (node.type === "UnaryExpression" && node.operator === "delete")
        ? node.argument : null);
    while (target?.type === "MemberExpression") target = asNode(target.object);
    if (target?.type === "Identifier" && namespaces.has(target.name)) return false;
    if (node.type === "VariableDeclarator" && node.init?.type === "Identifier" &&
      namespaces.has(node.init.name)) return false;
    if (node.type === "CallExpression" && node.arguments.some((argument: Syntax) =>
      argument.type === "Identifier" && namespaces.has(argument.name))) return false;
    if (node.type === "Property" && node.value?.type === "Identifier" && namespaces.has(node.value.name)) return false;
    pending.push(...children(node));
  }
  return true;
}

/** Verify the imported implementation defers its work in a native Layer, not an eager constructor. */
function isNativeLayerFactoryImport(filename: string, source: string, name: string): boolean {
  const resolved = resolveModule(filename, source);
  if (resolved === null) return false;
  try {
    const parsed = parseSync(resolved, readFileSync(resolved, "utf8"), { sourceType: "module" });
    if (parsed.errors.length !== 0) return false;
    const program = asNode(parsed.program);
    if (program?.type !== "Program") return false;
    const namespaces = new Map<string, string>();
    for (const statement of program.body) {
      if (statement.type !== "ImportDeclaration" || statement.source.value !== "effect" ||
        statement.importKind === "type") continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
          const imported = getImportedName(specifier);
          if (imported === "Effect" || imported === "Layer") namespaces.set(specifier.local.name, imported);
        }
      }
    }
    if (!intactNamespaces(program, namespaces)) return false;
    const method = (expression: Syntax, namespace: string, member: string): boolean =>
      expression.type === "MemberExpression" && !expression.computed &&
      namespaces.get(nameOf(asNode(expression.object)) ?? "") === namespace &&
      nameOf(asNode(expression.property)) === member;
    for (const statement of program.body) {
      if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration" ||
        statement.declaration.kind !== "const") continue;
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type !== "Identifier" || declaration.id.name !== name || declaration.init === null) continue;
        const factory = unwrap(declaration.init as Syntax);
        if (factory.type !== "ArrowFunctionExpression" || factory.async || factory.params.length !== 1 ||
          factory.params[0]?.type !== "Identifier" || namespaces.has(factory.params[0].name)) return false;
        const layer = unwrap(factory.body);
        if (layer.type !== "CallExpression" || !method(layer.callee, "Layer", "effect") ||
          layer.arguments.length !== 2 || layer.arguments[0]?.type !== "Identifier" ||
          layer.arguments[0].name === factory.params[0].name) return false;
        const effect = asNode(layer.arguments[1]);
        if (effect?.type !== "CallExpression" || !method(effect.callee, "Effect", "gen") ||
          effect.arguments.length !== 1) return false;
        const callback = asNode(effect.arguments[0]);
        return callback?.type === "FunctionExpression" && callback.generator === true &&
          callback.async !== true && callback.params.length === 0;
      }
    }
  } catch {
    // Unreadable or unsupported owner implementations remain constructor diagnostics.
  }
  return false;
}

function layerPipeline(context: Context, expression: Syntax): Syntax | null {
  let current = expression;
  while (current.parent?.type === "MemberExpression" && current.parent.object === current &&
    !current.parent.computed && nameOf(asNode(current.parent.property)) === "pipe") {
    const call = current.parent.parent;
    if (call?.type !== "CallExpression" || call.callee !== current.parent || call.arguments.length === 0 ||
      !call.arguments.every((argument) => argument.type === "CallExpression" &&
        (nativeMethod(context, argument.callee as Syntax, "Layer", "provide") ||
          nativeMethod(context, argument.callee as Syntax, "Layer", "provideMerge")))) return null;
    current = call as Syntax;
  }
  return current;
}

function shellDeploymentRoot(node: Syntax): Syntax | null {
  let current = node;
  for (const member of ["deployment", "shell", "composition"]) {
    if (current.type !== "MemberExpression" || current.computed ||
      nameOf(asNode(current.property)) !== member) return null;
    current = current.object;
  }
  return current.type === "Identifier" ? current : null;
}

function loadedDeployment(context: Context, argument: Syntax, factory: Variable): boolean {
  const root = shellDeploymentRoot(argument);
  const variable = root === null ? null : lookupVariable(context, root);
  if (variable?.defs.length !== 1 || !unchanged(variable)) return false;
  const definition = variable.defs[0]?.node;
  if (definition?.type !== "VariableDeclarator" || definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const") return false;
  const loaded = asNode(definition.init);
  const load = loaded?.type === "YieldExpression" && loaded.delegate ? asNode(loaded.argument) : null;
  const service = load?.type === "MemberExpression" && !load.computed &&
    nameOf(asNode(load.property)) === "load" ? asNode(load.object) : null;
  if (service?.type !== "YieldExpression" || !service.delegate ||
    !nativeImport(context, service.argument, "@app/core-runtime/modules/active-application-composition",
      "ActiveApplicationCompositionService")) return false;
  // A loaded snapshot may only supply this exact deployment slot; mutation and escapes stay rejected.
  return variable.references.every((reference) => {
    if (!reference.isRead()) return true;
    let value = reference.identifier as Syntax;
    while (value.parent?.type === "MemberExpression" && value.parent.object === value) value = value.parent;
    const call = value.parent;
    return shellDeploymentRoot(value) !== null && call?.type === "CallExpression" &&
      call.arguments.length === 1 && call.arguments[0] === value &&
      lookupVariable(context, call.callee) === factory;
  });
}

/** Only a returned Layer in a module-level unwrap may bind the deployment loaded from Core. */
function isDeploymentLayerComposition(context: Context, identifier: ESTree.Node, factory: Variable): boolean {
  const call = identifier.parent;
  if (call?.type !== "CallExpression" || call.callee !== identifier || call.arguments.length !== 1) return false;
  const argument = asNode(call.arguments[0]);
  if (argument === null || !loadedDeployment(context, argument, factory)) return false;
  const returned = layerPipeline(context, call as Syntax);
  const statement = returned?.parent;
  const body = statement?.type === "ReturnStatement" && statement.argument === returned ? statement.parent : null;
  const callback = body?.type === "BlockStatement" ? body.parent : null;
  if (callback?.type !== "FunctionExpression" || !callback.generator || callback.async ||
    callback.params.length !== 0) return false;
  const gen = callback.parent;
  if (gen?.type !== "CallExpression" || gen.arguments.length !== 1 || gen.arguments[0] !== callback ||
    !nativeMethod(context, gen.callee as Syntax, "Effect", "gen")) return false;
  const unwrapCall = gen.parent;
  if (unwrapCall?.type !== "CallExpression" || unwrapCall.arguments.length !== 1 ||
    unwrapCall.arguments[0] !== gen || !nativeMethod(context, unwrapCall.callee as Syntax, "Layer", "unwrap")) return false;
  const pipeline = layerPipeline(context, unwrapCall as Syntax);
  const declaration = pipeline?.parent;
  const binding = declaration?.type === "VariableDeclarator" && declaration.init === pipeline ? declaration.parent : null;
  const parent = binding?.type === "VariableDeclaration" && binding.kind === "const" ? binding.parent : null;
  return parent?.type === "Program" ||
    (parent?.type === "ExportNamedDeclaration" && parent.parent?.type === "Program");
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
    const pending: { readonly node: ESTree.ImportSpecifier; readonly source: string; readonly name: string }[] = [];
    return {
      ImportDeclaration(node) {
        if (isTestFile || (!node.source.value.startsWith("./") && !node.source.value.startsWith("../"))) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const importedName = getImportedName(specifier);
          if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;
          const variable = lookupVariable(context, specifier.local);
          // Core invokes this exact argument with its transaction/scope/revision. Passing the
          // factory is not eager construction; every other reference must still prove its owner.
          if (variable !== null && variable.references.length > 0 && variable.references.every((reference) => {
            const identifier = reference.identifier;
            const parent = identifier.parent;
            return isNativeServiceFactoryArgument(context, identifier) ||
              (parent?.type === "CallExpression" && parent.callee === identifier &&
                isInsideNativeServiceFactoryCallback(context, identifier)) ||
              isNativeServiceFactoryAcquisition(context, identifier);
          })) continue;
          if (variable !== null && variable.references.length > 0 &&
            variable.references.every((reference) => isDeploymentLayerComposition(context, reference.identifier, variable)) &&
            isNativeLayerFactoryImport(context.filename, node.source.value, importedName)) continue;
          // DTO and native migration-metadata construction share the binding-aware proof;
          // Drizzle imports alone never exempt a constructor or one of its runtime operations.
          if (isPureDataFactoryImport(context.filename, node.source.value, importedName, cache) ||
            provesDataFactoryImport(context.filename, node.source.value, importedName)) continue;
          pending.push({ node: specifier, source: node.source.value, name: importedName });
        }
      },
      "Program:exit"(program) {
        const owner = testProcessOwner(context, program);
        for (const entry of pending) {
          if (owner !== null && isOwnerLocalConstructor(context.filename, entry.source, owner, entry.name)) continue;
          context.report({ node: entry.node, messageId: "serviceConstructorImport", data: { name: entry.name } });
        }
      },
    };
  },
});

function getImportedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
}
