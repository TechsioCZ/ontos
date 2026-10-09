import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { Context, ESTree } from '@oxlint/plugins';
import { Result, Schema } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type { Node, Program } from 'oxc-parser';

import { keyName, parentOf, skipWrappers, staticString } from './ast.ts';
import { lookupVariable } from './bindings.ts';
import { importedName } from './imports.ts';

const runner = '@rstest/core';
const packageFile = 'package.json';
const configExtensions = ['mts', 'mjs', 'ts', 'js', 'cjs', 'cts'];
const unsupportedConfig = ['root', 'extends', 'plugins', 'tools', 'resolve'];
const OwnerSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  scripts: Schema.Record(Schema.String, Schema.String),
});
const registrations = new Map<
  string,
  { configuration: string; entries: readonly string[]; filename: string; manifest: string }
>();

const objectFields = (node: Node | undefined): ReadonlyMap<string, Node> | null => {
  if (node?.type !== 'ObjectExpression') {
    return null;
  }
  const fields = new Map<string, Node>();
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') {
      return null;
    }
    const name = keyName(property.key);
    if (name === null || fields.has(name)) {
      return null;
    }
    fields.set(name, property.value);
  }
  return fields;
};

const nativeFactory = (program: Program, callee: Extract<Node, { type: 'Identifier' }>): boolean => {
  const imports = program.body.flatMap((statement) =>
    statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && statement.source.value === runner
      ? statement.specifiers.filter(
          (specifier) =>
            specifier.type === 'ImportSpecifier' &&
            specifier.importKind !== 'type' &&
            keyName(specifier.imported) === 'defineConfig' &&
            specifier.local.name === callee.name,
        )
      : [],
  );
  const [specifier] = imports;
  if (imports.length !== 1 || specifier?.type !== 'ImportSpecifier') {
    return false;
  }
  const expected = new Set([specifier.local.start, specifier.imported.start, callee.start]);
  let escaped = false;
  new Visitor({
    Identifier: (node) => {
      if (node.name === callee.name && !expected.has(node.start)) {
        escaped = true;
      }
    },
  }).visit(program);
  return !escaped;
};

const configFields = (filename: string, source: string): ReadonlyMap<string, Node> | null => {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length !== 0) {
    return null;
  }
  const exported = parsed.program.body.find((statement) => statement.type === 'ExportDefaultDeclaration');
  const call = exported?.type === 'ExportDefaultDeclaration' ? exported.declaration : null;
  if (
    call?.type !== 'CallExpression' ||
    call.optional ||
    call.arguments.length !== 1 ||
    call.callee.type !== 'Identifier' ||
    !nativeFactory(parsed.program, call.callee)
  ) {
    return null;
  }
  return objectFields(call.arguments[0]);
};

const selectedProjects = (owner: typeof OwnerSchema.Type): ReadonlySet<string> => {
  const projects = new Set<string>();
  if ((owner.dependencies?.[runner] ?? owner.devDependencies?.[runner] ?? '').trim() === '') {
    return projects;
  }
  for (const command of Object.values(owner.scripts)) {
    if (/[\r\n\u2028\u2029]/u.test(command)) {
      continue;
    }
    const selected = /^rstest[ \t]+--project[ \t]+(?<project>[\w.-]+)[ \t]*$/u.exec(command)?.groups?.project;
    if (selected !== undefined) {
      projects.add(selected);
    }
  }
  return projects;
};

const setupEntries = (fields: ReadonlyMap<string, Node> | null, selected: ReadonlySet<string>): string[] => {
  if (fields === null || unsupportedConfig.some((key) => fields.has(key))) {
    return [];
  }
  const projects = fields.get('projects');
  if (projects?.type !== 'ArrayExpression') {
    return [];
  }
  const names = new Set<string>();
  const entries: string[] = [];
  for (const project of projects.elements) {
    const configuration = objectFields(project ?? undefined);
    const name = staticString(configuration?.get('name'), { templates: false });
    if (configuration === null || name === null || names.has(name)) {
      return [];
    }
    names.add(name);
    if (!selected.has(name) || unsupportedConfig.some((key) => configuration.has(key))) {
      continue;
    }
    const files = configuration.get('setupFiles');
    if (files?.type === 'ArrayExpression') {
      for (const file of files.elements) {
        const entry = staticString(file, { templates: false });
        if (entry === null) {
          return [];
        }
        entries.push(entry);
      }
    }
  }
  return entries;
};

const contained = (owner: string, filename: string): boolean => {
  const relative = path.relative(owner, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const packageOwner = (filename: string): string | null => {
  let directory = path.dirname(path.resolve(filename));
  while (!existsSync(path.join(directory, packageFile))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  const owner = realpathSync(directory);
  return path.dirname(realpathSync(path.join(directory, packageFile))) === owner ? owner : null;
};

/** Cache parsing by actual bytes; physical source/entry containment is rechecked on every call. */
const registeredEntries = (owner: string, configuration: string): readonly string[] => {
  const manifest = readFileSync(path.join(owner, packageFile), 'utf-8');
  const source = readFileSync(configuration, 'utf-8');
  const cached = registrations.get(owner);
  if (cached?.manifest === manifest && cached.filename === configuration && cached.configuration === source) {
    return cached.entries;
  }
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(OwnerSchema))(manifest);
  const entries = Result.isFailure(decoded)
    ? []
    : setupEntries(configFields(configuration, source), selectedProjects(decoded.success));
  if (registrations.size >= 64) {
    registrations.clear();
  }
  registrations.set(owner, { configuration: source, entries, filename: configuration, manifest });
  return entries;
};

const registeredSetup = (filename: string): boolean => {
  try {
    const owner = packageOwner(filename);
    if (owner === null || !contained(owner, realpathSync(filename))) {
      return false;
    }
    const configuration = configExtensions
      .map((extension) => path.join(owner, `rstest.config.${extension}`))
      .find(existsSync);
    if (configuration === undefined || path.dirname(realpathSync(configuration)) !== owner) {
      return false;
    }
    const target = realpathSync(filename);
    return registeredEntries(owner, configuration).some((entry) => {
      const source = path.resolve(owner, entry);
      return (
        contained(owner, source) &&
        existsSync(source) &&
        contained(owner, realpathSync(source)) &&
        realpathSync(source) === target
      );
    });
  } catch {
    return false;
  }
};

const terminalMutation = (parent: ESTree.Node, target: ESTree.Node): boolean | null => {
  if (parent.type === 'AssignmentExpression' || parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') {
    return parent.left === target;
  }
  if (parent.type === 'UpdateExpression') {
    return parent.argument === target;
  }
  return parent.type === 'UnaryExpression' ? parent.operator === 'delete' && parent.argument === target : null;
};

const mutationContainer = (parent: ESTree.Node, target: ESTree.Node): ESTree.Node | null => {
  if (parent.type === 'Property' && parent.value === target && parentOf(parent)?.type === 'ObjectPattern') {
    return parent;
  }
  if (parent.type === 'MemberExpression' && parent.object === target) {
    return parent;
  }
  return parent.type === 'ObjectPattern' ||
    parent.type === 'ArrayPattern' ||
    parent.type === 'RestElement' ||
    (parent.type === 'AssignmentPattern' && parent.left === target)
    ? parent
    : null;
};

const mutationTarget = (member: ESTree.Node): boolean => {
  let current = member;
  for (;;) {
    const { node, parent } = skipWrappers(current);
    if (parent === null) {
      return false;
    }
    const terminal = terminalMutation(parent, node);
    if (terminal !== null) {
      return terminal;
    }
    const container = mutationContainer(parent, node);
    if (container === null) {
      return false;
    }
    current = container;
  }
};

const directNamespace = (context: Context, node: ESTree.Node, namespace: string): boolean => {
  const variable = lookupVariable(context, node);
  if (variable?.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init)) {
    return false;
  }
  const [definition] = variable.defs;
  const declaration = definition?.parent;
  const specifier = definition?.node;
  if (
    definition?.type !== 'ImportBinding' ||
    declaration?.type !== 'ImportDeclaration' ||
    declaration.importKind === 'type'
  ) {
    return false;
  }
  const imported =
    specifier?.type === 'ImportSpecifier' &&
    specifier.importKind !== 'type' &&
    declaration.source.value === 'effect' &&
    importedName(specifier) === namespace;
  const submodule =
    specifier?.type === 'ImportNamespaceSpecifier' && declaration.source.value === `effect/${namespace}`;
  return (
    (imported || submodule) &&
    variable.references.every((reference) => {
      const member = parentOf(reference.identifier);
      if (
        member?.type !== 'MemberExpression' ||
        member.object !== reference.identifier ||
        member.computed ||
        member.optional
      ) {
        return false;
      }
      return !mutationTarget(member);
    })
  );
};

const directCall = (
  context: Context,
  node: ESTree.Node | undefined,
  namespace: string,
  name: string,
): ESTree.CallExpression | null => {
  if (node?.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) {
    return null;
  }
  const { callee } = node;
  return callee.type === 'MemberExpression' &&
    !callee.computed &&
    !callee.optional &&
    callee.property.type === 'Identifier' &&
    callee.property.name === name &&
    directNamespace(context, callee.object, namespace)
    ? node
    : null;
};

/** Rstest awaits module evaluation; only this single scoped native Layer root crosses into Promise. */
export const isNativeRstestSetupRun = (context: Context, member: ESTree.Node): boolean => {
  const run = directCall(context, parentOf(member) ?? undefined, 'Effect', 'runPromise');
  const awaitExpression = parentOf(run);
  const statement = parentOf(awaitExpression);
  if (
    run === null ||
    awaitExpression?.type !== 'AwaitExpression' ||
    statement?.type !== 'ExpressionStatement' ||
    parentOf(statement)?.type !== 'Program'
  ) {
    return false;
  }
  const scoped = directCall(context, run.arguments[0], 'Effect', 'scoped');
  return (
    scoped !== null &&
    directCall(context, scoped.arguments[0], 'Layer', 'build') !== null &&
    registeredSetup(context.filename)
  );
};
