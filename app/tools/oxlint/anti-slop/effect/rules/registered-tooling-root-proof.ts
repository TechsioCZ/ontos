import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import type { Context, ESTree, Variable } from "@oxlint/plugins";

import { lookupVariable } from "../../../effect-native/shared/bindings.ts";
import { registeredToolingPackageOwner, resolveOwnedToolingImport } from "./registered-tooling-package-proof.ts";

type Syntax = ESTree.Node & Record<string, any>;
const wrappers = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSInstantiationExpression", "TSTypeAssertion", "ParenthesizedExpression"]);
const erased = new Set(["TSTypeAnnotation", "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSDeclareFunction"]);
const forbiddenMembers = new Set(["constructor", "prototype", "__proto__"]);
const asNode = (value: unknown): Syntax | null => typeof value === "object" && value !== null && typeof (value as Syntax).type === "string" ? value as Syntax : null;
const children = (node: Syntax): Syntax[] => Object.entries(node).flatMap(([key, value]) => key === "parent" || key === "type" ? [] :
  (Array.isArray(value) ? value : [value]).map(asNode).filter((child): child is Syntax => child !== null));
const unwrapped = (node: Syntax): Syntax => wrappers.has(node.type) && asNode(node.expression) !== null ? unwrapped(node.expression) : node;
const callable = (node: Syntax): boolean => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
const keyOf = (node: Syntax | null | undefined): string | null => node?.type === "MemberExpression" && !node.computed && !node.optional && node.property.type === "Identifier" ? node.property.name : null;

function referencesOf(variable: Variable) {
  return variable.references.filter(({ identifier }) => {
    if (variable.defs.some((definition) => definition.name === identifier)) return false;
    let current = (identifier as Syntax).parent;
    while (current) {
      if (erased.has(current.type) || (current.type.startsWith("TS") && !wrappers.has(current.type))) return false;
      current = current.parent;
    }
    return true;
  });
}
const globalName = (context: Context, node: Syntax, name: string): boolean => node.type === "Identifier" && node.name === name &&
  (lookupVariable(context, node)?.defs.length ?? 0) === 0;

function imported(context: Context, node: Syntax, module: string, name: string): Variable | null {
  const variable = lookupVariable(context, node);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  const specifier = definition?.node;
  const declaration = definition?.parent;
  return definition?.type === "ImportBinding" && declaration?.type === "ImportDeclaration" && declaration.importKind !== "type" &&
    declaration.source.value === module && specifier?.type === "ImportSpecifier" && specifier.importKind !== "type" &&
    (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value) === name ? variable : null;
}

function written(node: Syntax): boolean {
  let current = node;
  while (current.parent?.type === "MemberExpression" && current.parent.object === current) current = current.parent;
  return (current.parent?.type === "AssignmentExpression" && current.parent.left === current) ||
    (current.parent?.type === "UpdateExpression" && current.parent.argument === current) ||
    (current.parent?.type === "UnaryExpression" && current.parent.operator === "delete");
}

function namespaceClosed(context: Context, variable: Variable, only?: string): boolean {
  return referencesOf(variable).every(({ identifier }) => {
    const node = identifier as Syntax;
    const parent = asNode(node.parent);
    if (written(node)) return false;
    if (parent?.type === "CallExpression" && parent.arguments[0] === node && parent.arguments.length === 1) {
      const callee = asNode(parent.callee);
      return only === undefined && callee?.type === "MemberExpression" && keyOf(callee) === "keys" && globalName(context, callee.object, "Object");
    }
    const key = parent === undefined ? null : keyOf(parent);
    return parent?.type === "MemberExpression" && parent.object === node && key !== null && !forbiddenMembers.has(key) && (only === undefined || key === only);
  });
}

function declaration(node: Syntax): Syntax | null {
  return node.type === "ExportNamedDeclaration" ? asNode(node.declaration) : node;
}

/** The fresh-freeze category contains data properties; function bodies stay lazy. */
function frozenDataInitializer(node: Syntax): boolean {
  const current = unwrapped(node);
  if (callable(current)) return true;
  if (current.type === "Property" && (current.kind !== "init" || current.method || current.computed)) return false;
  return children(current).every(frozenDataInitializer);
}

/** All executable root work is lazy or inside the one proven argv/filename guard. */
function inertTopLevel(node: Syntax, context: Context): boolean {
  const current = unwrapped(node);
  if (erased.has(current.type) || current.declare === true || callable(current) || current.type === "Literal") return true;
  if (current.type === "Identifier") return !["process", "globalThis", "require", "eval", "Function"].includes(current.name);
  if (current.type === "MemberExpression") return imported(context, current.object, "effect", "Schema") !== null &&
    ["Number", "String", "Boolean", "Int", "Unknown", "Never", "Void"].includes(keyOf(current) ?? "");
  if (["ObjectExpression", "ArrayExpression", "Property", "TemplateLiteral", "TemplateElement", "BinaryExpression", "UnaryExpression", "LogicalExpression", "ConditionalExpression"].includes(current.type)) {
    return !current.computed && !current.method && children(current).every((child) => inertTopLevel(child, context));
  }
  if (current.type === "TaggedTemplateExpression") return current.tag.type === "MemberExpression" && keyOf(current.tag) === "raw" &&
    current.tag.object.type === "Identifier" && current.tag.object.name === "String" && globalName(context, current.tag.object, "String") && inertTopLevel(current.quasi, context);
  if (current.type === "NewExpression") return current.callee.type === "Identifier" && ["Set", "Map", "RegExp"].includes(current.callee.name) &&
    (lookupVariable(context, current.callee)?.defs.length ?? 0) === 0 && current.arguments.every((argument: Syntax) => inertTopLevel(argument, context));
  if (current.type === "CallExpression" && !current.optional) {
    const callee = unwrapped(current.callee);
    if (callee.type === "CallExpression") return inertTopLevel(callee, context) && current.arguments.every((argument: Syntax) => inertTopLevel(argument, context));
    if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier" || keyOf(callee) === null) return false;
    const member = keyOf(callee)!;
    if (member.startsWith("run") || forbiddenMembers.has(member)) return false;
    if (globalName(context, callee.object, "Object") && member === "freeze") {
      const argument = current.arguments.length === 1 ? asNode(current.arguments[0]) : null;
      const value = argument === null ? null : unwrapped(argument);
      return value?.type === "ObjectExpression" && frozenDataInitializer(value) && inertTopLevel(value, context);
    }
    if (globalName(context, callee.object, "Object") && member === "keys") return current.arguments.length === 1 && current.arguments[0].type === "Identifier" &&
      ["Effect", "Predicate"].some((slot) => imported(context, current.arguments[0], "effect", slot) !== null);
    const origin = lookupVariable(context, callee.object)?.defs[0];
    return origin?.type === "ImportBinding" && origin.parent?.type === "ImportDeclaration" && origin.parent.source.value === "effect" &&
      origin.node.type === "ImportSpecifier" && origin.node.importKind !== "type" && !["ManagedRuntime", "Runtime"].includes(origin.node.imported.type === "Identifier" ? origin.node.imported.name : "") &&
      current.arguments.every((argument: Syntax) => inertTopLevel(argument, context));
  }
  if (current.type === "ClassDeclaration") return (current.decorators?.length ?? 0) === 0 &&
    (current.superClass === null || inertTopLevel(current.superClass, context)) &&
    current.body.body.every((member: Syntax) => member.type !== "StaticBlock" && member.static !== true && (member.decorators?.length ?? 0) === 0);
  return false;
}

function directExportedFunction(file: string, name: string): boolean {
  try {
    const parsed = parseSync(file, readFileSync(file, "utf8"), { sourceType: "module" });
    if (parsed.errors.length !== 0) return false;
    return parsed.program.body.some((entry) => {
      if (entry.type !== "ExportNamedDeclaration" || entry.source !== null || entry.declaration === null) return false;
      const value = entry.declaration as Syntax;
      if (value.type === "FunctionDeclaration") return value.id?.name === name;
      return value.type === "VariableDeclaration" && value.kind === "const" && value.declarations.some((item: Syntax) =>
        item.id.type === "Identifier" && item.id.name === name && item.init !== null && callable(unwrapped(item.init)));
    });
  } catch {
    return false;
  }
}

/** A process may consume its local construction, never publish the raw constructed identity. */
function constructedValueStaysLocal(context: Context, call: Syntax): boolean {
  const parent = asNode(call.parent);
  if (parent?.type === "ExpressionStatement") return true;
  if (parent?.type !== "VariableDeclarator" || parent.init !== call || parent.id.type !== "Identifier" ||
    parent.parent?.type !== "VariableDeclaration" || parent.parent.kind !== "const") return false;
  const variable = lookupVariable(context, parent.id);
  return variable !== null && referencesOf(variable).every(({ identifier }) => {
    const reference = identifier as Syntax;
    const member = asNode(reference.parent);
    const invocation = asNode(member?.parent);
    return member?.type === "MemberExpression" && member.object === reference && !written(reference) &&
      keyOf(member) !== null && !forbiddenMembers.has(keyOf(member)!) && invocation?.type === "CallExpression" &&
      !invocation.optional && invocation.callee === member;
  });
}

export interface RegisteredToolingRoot {
  readonly ownsImport: (specifier: ESTree.ImportSpecifier, source: string, name: string) => boolean;
}

/** Registration grants custody only to the genuine guarded process and its main-reachable local functions. */
export function registeredToolingRoot(context: Context, program: ESTree.Program): RegisteredToolingRoot | null {
  const owner = registeredToolingPackageOwner(context.filename);
  if (owner === null) return null;
  const body = program.body as Syntax[];
  const guards = body.filter((node) => node.type === "IfStatement");
  if (guards.length !== 1) return null;
  const guard = guards[0]!;
  const test = unwrapped(guard.test);
  if (guard.alternate !== null || guard.consequent.type !== "BlockStatement" || test.type !== "BinaryExpression" || test.operator !== "===") return null;
  const moduleFilename = (node: Syntax): boolean => keyOf(node) === "filename" && node.object.type === "MetaProperty" && node.object.meta.name === "import" && node.object.property.name === "meta";
  const invoked = moduleFilename(test.right) ? test.left : moduleFilename(test.left) ? test.right : null;
  if (invoked?.type !== "Identifier") return null;
  const invokedVariable = lookupVariable(context, invoked);
  const invokedDefinition = invokedVariable?.defs.length === 1 ? invokedVariable.defs[0] : undefined;
  const argv = invokedDefinition?.node as Syntax | undefined;
  const argvRead = asNode(argv?.init);
  if (argv?.type !== "VariableDeclarator" || argv.id.type !== "ArrayPattern" || argv.id.elements.length !== 2 || argv.id.elements[0] !== null ||
    argv.id.elements[1] !== invokedDefinition?.name || argv.parent?.type !== "VariableDeclaration" || argv.parent.kind !== "const" ||
    argvRead?.type !== "MemberExpression" || keyOf(argvRead) !== "argv" || argvRead.object.type !== "Identifier" || !globalName(context, argvRead.object, "process")) return null;
  if (referencesOf(invokedVariable!).length !== 1 || referencesOf(invokedVariable!)[0]?.identifier !== invoked) return null;
  const statements = guard.consequent.body as Syntax[];
  if (statements.length !== 3) return null;
  const oneConst = (node: Syntax): Syntax | null => node.type === "VariableDeclaration" && node.kind === "const" && node.declarations.length === 1 && node.declarations[0].id.type === "Identifier" ? node.declarations[0] : null;
  const runtime = oneConst(statements[0]!);
  const settled = oneConst(statements[1]!);
  const creation = runtime?.init;
  if (creation?.type !== "CallExpression" || creation.optional || keyOf(creation.callee) !== "make" || creation.arguments.length !== 1 ||
    keyOf(creation.arguments[0]) !== "layer") return null;
  const managed = imported(context, creation.callee.object, "effect", "ManagedRuntime");
  const nodeServices = imported(context, creation.arguments[0].object, "@effect/platform-node", "NodeServices");
  if (managed === null || nodeServices === null || referencesOf(managed).length !== 1 || referencesOf(nodeServices).length !== 1 ||
    !namespaceClosed(context, managed, "make") || !namespaceClosed(context, nodeServices, "layer")) return null;
  const awaited = settled?.init;
  const run = awaited?.type === "AwaitExpression" ? awaited.argument : null;
  if (run?.type !== "CallExpression" || run.optional || keyOf(run.callee) !== "runPromiseExit" || run.arguments.length !== 1 || run.arguments[0].type !== "Identifier" ||
    run.callee.object.type !== "Identifier" || lookupVariable(context, run.callee.object) !== lookupVariable(context, runtime!.id)) return null;
  const runtimeVariable = lookupVariable(context, runtime!.id);
  if (runtimeVariable === null || referencesOf(runtimeVariable).length !== 1) return null;
  const mainVariable = lookupVariable(context, run.arguments[0]);
  const mainDefinition = mainVariable?.defs.length === 1 ? mainVariable.defs[0] : undefined;
  const main = mainDefinition?.node as Syntax | undefined;
  const mainCall = main?.init;
  if (main?.type !== "VariableDeclarator" || main.parent?.type !== "VariableDeclaration" || main.parent.kind !== "const" || main.parent.parent?.type !== "Program" ||
    mainCall?.type !== "CallExpression" || mainCall.optional || keyOf(mainCall.callee) !== "gen" || mainCall.arguments.length !== 1 || !callable(mainCall.arguments[0])) return null;
  const effect = imported(context, mainCall.callee.object, "effect", "Effect");
  if (effect === null || !namespaceClosed(context, effect)) return null;
  const assignment = statements[2]?.type === "ExpressionStatement" ? asNode(statements[2].expression) : null;
  if (assignment?.type !== "AssignmentExpression") return null;
  const exitCode = asNode(assignment.left);
  const status = asNode(assignment.right);
  if (assignment.operator !== "=" || exitCode?.type !== "MemberExpression" || keyOf(exitCode) !== "exitCode" || exitCode.object.type !== "Identifier" ||
    exitCode.object.name !== "process" || !globalName(context, exitCode.object, "process") || status?.type !== "ConditionalExpression" ||
    status.consequent.type !== "Literal" || status.consequent.value !== 0 || status.alternate.type !== "Literal" || status.alternate.value !== 1 ||
    status.test.type !== "CallExpression" || status.test.optional || keyOf(status.test.callee) !== "isSuccess" || status.test.arguments.length !== 1 ||
    lookupVariable(context, status.test.arguments[0]) !== lookupVariable(context, settled!.id)) return null;
  const statusCallee = asNode(status.test.callee);
  const exit = statusCallee?.type === "MemberExpression" ? imported(context, statusCallee.object, "effect", "Exit") : null;
  if (exit === null || !namespaceClosed(context, exit) || (lookupVariable(context, settled!.id) === null || referencesOf(lookupVariable(context, settled!.id)!).length !== 1)) return null;
  const declarations = new Map<Variable, Syntax>();
  for (const statement of body) {
    if (statement === guard) continue;
    const value = declaration(statement);
    if (value === null) return null;
    if (value.type === "ImportDeclaration") {
      if (value.specifiers.length === 0) return null;
      continue;
    }
    if (erased.has(value.type)) continue;
    if (value.type === "VariableDeclaration" && value.kind === "const") {
      for (const item of value.declarations) {
        if (item === argv) continue;
        if (item.id.type !== "Identifier" || item.init === null || !inertTopLevel(item.init, context)) return null;
        const variable = lookupVariable(context, item.id);
        if (variable === null || referencesOf(variable).some(({ identifier }) => written(identifier as Syntax))) return null;
        declarations.set(variable, item.init);
      }
      continue;
    }
    if (["FunctionDeclaration", "ClassDeclaration"].includes(value.type) && inertTopLevel(value, context) && value.id !== null) {
      const variable = lookupVariable(context, value.id);
      if (variable === null || referencesOf(variable).some(({ identifier }) => written(identifier as Syntax))) return null;
      declarations.set(variable, value);
      continue;
    }
    return null;
  }
  const reachable = new Set<Variable>();
  const visit = (variable: Variable): void => {
    if (reachable.has(variable)) return;
    reachable.add(variable);
    const root = declarations.get(variable);
    if (root === undefined) return;
    const walk = (node: Syntax): void => {
      if (erased.has(node.type)) return;
      if (node.type === "Identifier") {
        const target = lookupVariable(context, node);
        if (target !== null && declarations.has(target)) visit(target);
      }
      for (const child of children(node)) walk(child);
    };
    walk(root);
  };
  visit(mainVariable!);
  return {
    ownsImport(specifier, source, name) {
      const file = resolveOwnedToolingImport(owner, context.filename, source);
      const variable = lookupVariable(context, specifier.local);
      if (file === null || !directExportedFunction(file, name) || variable === null || referencesOf(variable).length === 0) return false;
      return referencesOf(variable).every(({ identifier }) => {
        const reference = identifier as Syntax;
        if (reference.parent?.type !== "CallExpression" || reference.parent.optional || reference.parent.callee !== reference) return false;
        if (!constructedValueStaysLocal(context, reference.parent as Syntax)) return false;
        let current: Syntax = reference;
        while (current.parent && current.parent.type !== "Program" && current.parent.type !== "ExportNamedDeclaration") current = current.parent;
        const top = current.type === "VariableDeclaration" ? current.declarations.find((item: Syntax) => {
          let nested: Syntax = reference;
          while (nested.parent && nested.parent !== current) nested = nested.parent;
          return nested === item;
        }) : current;
        const ownerVariable = top?.id?.type === "Identifier" ? lookupVariable(context, top.id) : null;
        const initializer = asNode(top?.type === "VariableDeclarator" ? top.init : top);
        return ownerVariable !== null && reachable.has(ownerVariable) && initializer !== null && (callable(initializer) || initializer === mainCall);
      });
    },
  };
}
