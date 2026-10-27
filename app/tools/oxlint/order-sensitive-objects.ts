/// <reference types="node" />

import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Context, ESTree, Variable } from '@oxlint/plugins';
import perfectionist, { rules as nativeRules } from 'eslint-plugin-perfectionist';
import { parseSync } from 'oxc-parser';

import { asNode, literalText, memberName, unwrapNode, walk } from './effect-native/shared/ast.ts';
import { lookupVariable } from './effect-native/shared/bindings.ts';
import { importedName } from './effect-native/shared/imports.ts';

type Identity = 'pg-core' | 'pgSchema' | 'pgTable' | 'schema' | null;
type Identifier = Extract<ESTree.Node, { type: 'Identifier' }>;
interface ImportOrigin {
  readonly name: string;
  readonly source: string;
}
type ExportOrigin =
  | { readonly kind: 'local'; readonly name: string }
  | { readonly kind: 'import'; readonly origin: ImportOrigin };
interface Module {
  readonly exports: Map<string, ExportOrigin>;
  readonly filename: string;
  readonly imports: Map<string, ImportOrigin>;
  readonly unsafe: Set<string>;
  readonly values: Map<string, ESTree.Node>;
}

const pgCore = 'drizzle-orm/pg-core';
const unwrap = (node: ESTree.Node): ESTree.Node => unwrapNode(node);
const name = (node: ESTree.Node): string | null => (node.type === 'Identifier' ? node.name : literalText(node));
const member = (node: ESTree.MemberExpression): string | null => (node.optional ? null : memberName(node));
const nativeMember = (base: Identity, property: string | null): Identity =>
  base === 'pg-core' && (property === 'pgSchema' || property === 'pgTable') ? property : null;

const recordImports = (module: Module, statement: ESTree.Statement | ESTree.ModuleDeclaration): void => {
  if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') {
    return;
  }
  for (const specifier of statement.specifiers) {
    if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
      module.imports.set(specifier.local.name, { name: importedName(specifier), source: statement.source.value });
    } else if (specifier.type === 'ImportNamespaceSpecifier') {
      module.imports.set(specifier.local.name, { name: '*', source: statement.source.value });
    }
  }
};

const recordExports = (module: Module, statement: ESTree.Statement | ESTree.ModuleDeclaration): void => {
  if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') {
    return;
  }
  for (const specifier of statement.specifiers) {
    if (specifier.exportKind === 'type') {
      continue;
    }
    const exported = name(specifier.exported);
    const local = name(specifier.local);
    if (exported !== null && local !== null) {
      module.exports.set(
        exported,
        statement.source === null
          ? { kind: 'local', name: local }
          : { kind: 'import', origin: { name: local, source: statement.source.value } },
      );
    }
  }
};

const recordValues = (module: Module, statement: ESTree.Statement | ESTree.ModuleDeclaration): void => {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
  if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
    return;
  }
  for (const value of declaration.declarations) {
    if (value.id.type !== 'Identifier' || value.init === null) {
      continue;
    }
    module.values.set(value.id.name, value.init);
    if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
      module.exports.set(value.id.name, { kind: 'local', name: value.id.name });
    }
  }
};

const unsafeTargets = (node: ESTree.Node): readonly ESTree.Node[] => {
  if (node.type === 'AssignmentExpression') {
    return [node.left, node.right];
  }
  if (node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
    return [node.argument];
  }
  if (node.type === 'CallExpression') {
    return node.arguments.filter((argument) => argument.type === 'Identifier');
  }
  if (node.type === 'Property' && node.value.type === 'Identifier') {
    return [node.value];
  }
  if (node.type === 'ReturnStatement' && node.argument?.type === 'Identifier') {
    return [node.argument];
  }
  if (node.type === 'ArrowFunctionExpression' && node.body.type === 'Identifier') {
    return [node.body];
  }
  if (node.type === 'VariableDeclaration' && node.kind !== 'const') {
    return node.declarations.flatMap((declaration) =>
      declaration.init?.type === 'Identifier' ? [declaration.init] : [],
    );
  }
  return [];
};

const recordUnsafeReferences = (module: Module, program: ESTree.Program, context: Context): void => {
  walk(program, context.sourceCode.visitorKeys, (node: ESTree.Node) => {
    for (const target of unsafeTargets(node)) {
      walk(target, context.sourceCode.visitorKeys, (assigned: ESTree.Node) => {
        if (assigned.type === 'Identifier') {
          module.unsafe.add(assigned.name);
        }
      });
    }
  });
  // A mutation through a const alias also invalidates the original exported receiver.
  for (let pass = 0; pass < 16; pass += 1) {
    for (const [alias, initializer] of module.values) {
      if (module.unsafe.has(alias) && initializer.type === 'Identifier') {
        module.unsafe.add(initializer.name);
      }
    }
  }
};

const isMutation = (node: ESTree.Node): boolean => {
  for (let held: ESTree.Node = node; held.parent !== null; held = held.parent) {
    const ancestor: ESTree.Node = held.parent;
    if (
      (ancestor.type === 'AssignmentExpression' && ancestor.left === held) ||
      ancestor.type === 'UpdateExpression' ||
      (ancestor.type === 'UnaryExpression' && ancestor.operator === 'delete')
    ) {
      return true;
    }
  }
  return false;
};

/** Per-file proof state. Only source is read; imported application modules are never evaluated.
 * The existing lexical resolver proves local bindings. Node's resolver follows exact owner
 * imports and package exports; bounded, const-only source inspection proves exported schemas.
 */
const drizzleColumns = (context: Context): ((node: ESTree.ObjectExpression) => boolean) => {
  const modules = new Map<string, Module | null>();
  const visited = new Set<string | Variable>();
  const resolveModule = (filename: string, source: string): Module | null => {
    if (!source.startsWith('.') && !source.startsWith('@app/')) {
      return null;
    }
    let target: string;
    try {
      target = realpathSync(createRequire(path.resolve(filename)).resolve(source));
    } catch {
      return null;
    }
    if (
      path.basename(target).startsWith('.env') ||
      !['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(path.extname(target))
    ) {
      return null;
    }
    if (modules.has(target)) {
      return modules.get(target) ?? null;
    }
    if (modules.size >= 32) {
      return null;
    }
    modules.set(target, null);
    try {
      const sourceText = readFileSync(target, 'utf-8');
      if (sourceText.length > 1_000_000) {
        return null;
      }
      const parsed = parseSync(target, sourceText);
      const program: ESTree.Node | null = asNode(parsed.program);
      if (parsed.errors.length !== 0 || program?.type !== 'Program') {
        return null;
      }
      const module: Module = {
        exports: new Map(),
        filename: target,
        imports: new Map(),
        unsafe: new Set(),
        values: new Map(),
      };
      for (const statement of program.body) {
        recordImports(module, statement);
        recordExports(module, statement);
        recordValues(module, statement);
      }
      recordUnsafeReferences(module, program, context);
      modules.set(target, module);
      return module;
    } catch {
      return null;
    }
  };
  const guarded = (key: string | Variable, evaluate: () => Identity): Identity => {
    if (visited.size >= 16 || visited.has(key)) {
      return null;
    }
    visited.add(key);
    try {
      return evaluate();
    } finally {
      visited.delete(key);
    }
  };
  const proof = {
    expression(input: ESTree.Node, resolve: (node: Identifier) => Identity): Identity {
      const node = unwrap(input);
      if (node.type === 'Identifier') {
        return resolve(node);
      }
      if (node.type === 'MemberExpression') {
        return nativeMember(proof.expression(node.object, resolve), member(node));
      }
      if (
        node.type === 'CallExpression' &&
        !node.optional &&
        node.arguments.length === 1 &&
        node.arguments[0]?.type !== 'SpreadElement' &&
        proof.expression(node.callee, resolve) === 'pgSchema'
      ) {
        return 'schema';
      }
      return null;
    },
    imported(filename: string, origin: ImportOrigin): Identity {
      if (origin.source === pgCore) {
        return origin.name === '*' ? 'pg-core' : nativeMember('pg-core', origin.name);
      }
      const owner = resolveModule(filename, origin.source);
      if (owner === null) {
        return null;
      }
      return guarded(`${owner.filename}:${origin.name}`, () => {
        const exported = owner.exports.get(origin.name);
        if (exported === undefined) {
          return null;
        }
        return exported.kind === 'local'
          ? proof.moduleValue(owner, exported.name)
          : proof.imported(owner.filename, exported.origin);
      });
    },
    moduleValue(module: Module, local: string): Identity {
      return guarded(`${module.filename}:local:${local}`, () => {
        if (module.unsafe.has(local)) {
          return null;
        }
        const value = module.values.get(local);
        if (value !== undefined) {
          return proof.expression(value, (identifier) => proof.moduleValue(module, identifier.name));
        }
        const origin = module.imports.get(local);
        return origin === undefined ? null : proof.imported(module.filename, origin);
      });
    },
  };
  const stable = {
    reference(identifier: ESTree.Node, seen: Set<Variable>): boolean {
      let node = identifier;
      while (node.parent?.type === 'MemberExpression' && node.parent.object === node) {
        node = node.parent;
      }
      if (isMutation(node)) {
        return false;
      }
      const { parent } = node;
      if (parent?.type === 'CallExpression') {
        return parent.callee === node;
      }
      if (parent?.type === 'VariableDeclarator' && parent.init === node) {
        const alias = lookupVariable(context, parent.id);
        return alias !== null && stable.variable(alias, seen);
      }
      // Bare values must not escape into arbitrary records, callbacks or mutable aliases.
      return node !== identifier || parent?.type === 'ExportSpecifier' || parent?.type === 'TSTypeQuery';
    },
    variable(variable: Variable, seen = new Set<Variable>()): boolean {
      if (seen.size >= 16 || seen.has(variable)) {
        return false;
      }
      seen.add(variable);
      const result = variable.references.every(
        (reference) => reference.init || (!reference.isWrite() && stable.reference(reference.identifier, seen)),
      );
      seen.delete(variable);
      return result;
    },
  };
  const localValue = (identifier: Identifier): Identity => {
    const variable = lookupVariable(context, identifier);
    if (variable?.defs.length !== 1 || !stable.variable(variable)) {
      return null;
    }
    return guarded(variable, () => {
      const [definition] = variable.defs;
      if (definition?.type === 'ImportBinding' && definition.parent?.type === 'ImportDeclaration') {
        const specifier = definition.node;
        if (definition.parent.importKind === 'type') {
          return null;
        }
        if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
          return proof.imported(context.filename, {
            name: importedName(specifier),
            source: definition.parent.source.value,
          });
        }
        return specifier.type === 'ImportNamespaceSpecifier'
          ? proof.imported(context.filename, { name: '*', source: definition.parent.source.value })
          : null;
      }
      if (
        definition?.type === 'Variable' &&
        definition.parent?.type === 'VariableDeclaration' &&
        definition.parent.kind === 'const' &&
        definition.node.type === 'VariableDeclarator' &&
        definition.node.id.type === 'Identifier' &&
        definition.node.init !== null
      ) {
        return proof.expression(definition.node.init, localValue);
      }
      return null;
    });
  };
  return (node) => {
    const call = node.parent;
    if (
      call?.type !== 'CallExpression' ||
      call.optional ||
      call.arguments[1] !== node ||
      call.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return false;
    }
    let callee = unwrap(call.callee);
    if (callee.type === 'MemberExpression' && member(callee) === 'withRLS') {
      callee = unwrap(callee.object);
    }
    return (
      proof.expression(callee, localValue) === 'pgTable' ||
      (callee.type === 'MemberExpression' &&
        member(callee) === 'table' &&
        proof.expression(callee.object, localValue) === 'schema')
    );
  };
};

const nativeSortObjects = nativeRules?.['sort-objects'];
if (nativeSortObjects === undefined) {
  throw new Error('Perfectionist sort-objects is unavailable');
}
type NativeContext = Parameters<typeof nativeSortObjects.create>[0];

/** Oxlint marks its ESTree context explicitly. Other hosts receive the unmodified native rule. */
const isOxlintContext = (context: NativeContext): context is NativeContext & Context =>
  'isESTree' in context.sourceCode && context.sourceCode.isESTree === true;

const rules: NonNullable<typeof nativeRules> = {
  ...nativeRules,
  'sort-objects': {
    ...nativeSortObjects,
    create(context: NativeContext) {
      const listeners = nativeSortObjects.create(context);
      if (!isOxlintContext(context)) {
        return listeners;
      }
      const exit = listeners['ObjectExpression:exit'];
      if (exit === undefined) {
        throw new Error('Perfectionist sort-objects listener contract changed');
      }
      const exempt = drizzleColumns(context);
      return {
        ...listeners,
        'ObjectExpression:exit'(node: ESTree.ObjectExpression) {
          if (!exempt(node)) {
            exit(node);
          }
        },
      };
    },
  },
};

export default { ...perfectionist, rules };
