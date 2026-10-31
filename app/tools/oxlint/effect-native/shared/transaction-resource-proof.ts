import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { asNode, childrenOf, memberName, type Syntax } from './ast.ts';
import { lookupVariable } from './bindings.ts';

interface Origin {
  readonly module: Module;
  readonly name: string;
}
interface Import {
  readonly source: string;
  readonly name: string;
  readonly typeOnly: boolean;
}
interface Module {
  readonly filename: string;
  readonly imports: Map<string, Import>;
  readonly exports: Map<string, string>;
  readonly declarations: Map<string, Syntax>;
}
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const TRANSPARENT = new Set(['ParenthesizedExpression', 'ChainExpression', 'TSNonNullExpression']);
const text = (input: unknown): string | null => {
  const node = asNode(input);
  return node?.type === 'Identifier' ? node.name : typeof node?.value === 'string' ? node.value : null;
};
const unwrap = (input: unknown): Syntax | null => {
  let node = asNode(input);
  for (let depth = 0; node !== null && TRANSPARENT.has(node.type) && depth < 16; depth += 1) {
    node = asNode(node.expression);
  }
  return node;
};

/** Resource dependence, not a general effect or type checker. Unknown source stays unproved.
 * Imported code is parsed, never loaded. Budgets and caches belong to one linted file.
 */
export function transactionResourceProof(context: Context) {
  const modules = new Map<string, Module | null>();
  const summaries = new Map<Syntax, ReadonlySet<number>>();
  const summarizing = new Set<Syntax>();
  let steps = 0;
  const resolve = (filename: string, source: string): string | null => {
    try {
      const resolved = source.startsWith('.')
        ? path.resolve(path.dirname(filename), source)
        : createRequire(path.resolve(filename)).resolve(source);
      if (!/\.[cm]?[jt]sx?$/u.test(resolved)) return null;
      return realpathSync(resolved);
    } catch {
      return null;
    }
  };
  const load = (filename: string): Module | null => {
    if (modules.has(filename)) return modules.get(filename) ?? null;
    if (modules.size >= 24) return null;
    modules.set(filename, null);
    try {
      const stat = statSync(filename);
      if (!stat.isFile() || stat.size > 1_000_000) return null;
      const source = readFileSync(filename, 'utf8');
      if (source.length > 1_000_000) return null;
      const parsed = parseSync(filename, source, { sourceType: 'module' });
      if (parsed.errors.length !== 0) return null;
      const module: Module = { filename, imports: new Map(), exports: new Map(), declarations: new Map() };
      for (const statement of parsed.program.body as unknown as Syntax[]) {
        if (statement.type === 'ImportDeclaration') {
          for (const specifier of statement.specifiers) {
            const name =
              specifier.type === 'ImportNamespaceSpecifier'
                ? '*'
                : specifier.type === 'ImportSpecifier'
                  ? text(specifier.imported)
                  : null;
            if (name !== null)
              module.imports.set(specifier.local.name, {
                source: statement.source.value,
                name,
                typeOnly:
                  statement.importKind === 'type' ||
                  (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'),
              });
          }
          continue;
        }
        const exported = statement.type === 'ExportNamedDeclaration';
        if (exported && statement.source) {
          for (const specifier of statement.specifiers) {
            const name = text(specifier.exported),
              original = text(specifier.local);
            if (name === null || original === null) continue;
            const local = `@export:${name}`;
            module.imports.set(local, {
              source: statement.source.value,
              name: original,
              typeOnly: statement.exportKind === 'type',
            });
            module.exports.set(name, local);
          }
          continue;
        }
        if (exported && !statement.declaration) {
          for (const specifier of statement.specifiers) {
            const name = text(specifier.exported),
              local = text(specifier.local);
            if (name !== null && local !== null) module.exports.set(name, local);
          }
          continue;
        }
        const declaration = asNode(exported ? statement.declaration : statement);
        if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
          for (const item of declaration.declarations) {
            if (item.id.type !== 'Identifier') continue;
            module.declarations.set(item.id.name, item);
            if (exported) module.exports.set(item.id.name, item.id.name);
          }
        } else if (declaration?.id?.type === 'Identifier') {
          module.declarations.set(declaration.id.name, declaration);
          if (exported) module.exports.set(declaration.id.name, declaration.id.name);
        }
      }
      modules.set(filename, module);
      return module;
    } catch {
      return null;
    }
  };
  const origin = (module: Module, name: string, depth = 0): Origin | null => {
    if (++steps > 4000 || depth > 12) return null;
    const imported = module.imports.get(name);
    if (imported) {
      const filename = resolve(module.filename, imported.source),
        target = filename === null ? null : load(filename);
      const local = target?.exports.get(imported.name);
      return target && local ? origin(target, local, depth + 1) : null;
    }
    return module.declarations.has(name) ? { module, name } : null;
  };
  let canonical: Origin | null | undefined;
  const canonicalType = (): Origin | null => {
    if (canonical !== undefined) return canonical;
    canonical = null;
    const filename = resolve(context.filename, '@app/core-runtime'),
      module = filename === null ? null : load(filename);
    const local = module?.exports.get('ScopedTransactionExecutor');
    const found = module && local ? origin(module, local) : null;
    const declaration = found?.module.declarations.get(found.name);
    // The canonical capability must still carry its private unique-symbol brand.
    if (declaration?.type !== 'TSInterfaceDeclaration') return null;
    const branded = declaration.body.body.some((property: Syntax) => {
      if (property.type !== 'TSPropertySignature' || !property.computed || property.key.type !== 'Identifier')
        return false;
      const symbol = found!.module.declarations.get(property.key.name);
      const annotation = symbol?.id?.typeAnnotation?.typeAnnotation;
      const value = property.typeAnnotation?.typeAnnotation;
      return (
        symbol?.type === 'VariableDeclarator' &&
        annotation?.type === 'TSTypeOperator' &&
        annotation.operator === 'unique' &&
        annotation.typeAnnotation?.type === 'TSSymbolKeyword' &&
        value?.type === 'TSLiteralType' &&
        value.literal.type === 'Literal' &&
        value.literal.value === true
      );
    });
    if (branded) canonical = found;
    return canonical;
  };
  const sameCanonical = (found: Origin | null): boolean => {
    const target = canonicalType();
    return found !== null && target !== null && found.module === target.module && found.name === target.name;
  };
  const parsedType = (module: Module, input: unknown): boolean => {
    const annotation = asNode(input),
      type = annotation?.type === 'TSTypeAnnotation' ? asNode(annotation.typeAnnotation) : annotation;
    return (
      type?.type === 'TSTypeReference' &&
      type.typeName.type === 'Identifier' &&
      sameCanonical(origin(module, type.typeName.name))
    );
  };
  const lexicalImport = (identifier: ESTree.Node): Import | null => {
    const variable = lookupVariable(context, identifier);
    if (variable?.defs.length !== 1) return null;
    const definition = variable.defs[0]!,
      specifier = asNode(definition.node),
      parent = asNode(definition.parent);
    const name = text(specifier?.imported);
    return definition.type === 'ImportBinding' && parent?.type === 'ImportDeclaration' && name !== null
      ? {
          source: parent.source.value,
          name,
          typeOnly: parent.importKind === 'type' || specifier?.importKind === 'type',
        }
      : null;
  };
  const lexicalType = (input: unknown): boolean => {
    const annotation = asNode(input),
      type = annotation?.type === 'TSTypeAnnotation' ? asNode(annotation.typeAnnotation) : annotation;
    if (type?.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') return false;
    const imported = lexicalImport(type.typeName);
    if (imported === null) return false;
    const filename = resolve(context.filename, imported.source),
      module = filename === null ? null : load(filename);
    const local = module?.exports.get(imported.name);
    return module !== null && local !== undefined && sameCanonical(origin(module, local));
  };
  const root = (input: unknown, seen = new Set<Variable>()): Variable | null => {
    const node = unwrap(input);
    if (node?.type !== 'Identifier') return null;
    const variable = lookupVariable(context, node);
    if (
      !variable ||
      variable.defs.length !== 1 ||
      seen.has(variable) ||
      variable.references.some((reference) => reference.init !== true && reference.isWrite())
    )
      return null;
    const definition = variable.defs[0]!,
      binding = asNode(definition.name);
    if (definition.type === 'Parameter' && lexicalType(binding?.typeAnnotation)) return variable;
    const declaration = asNode(definition.node),
      parent = asNode(definition.parent ?? declaration?.parent);
    if (definition.type !== 'Variable' || declaration?.type !== 'VariableDeclarator' || parent?.kind !== 'const')
      return null;
    return root(declaration.init, new Set(seen).add(variable));
  };
  const query = <T>(input: unknown, identify: (node: Syntax) => T | null): T | null => {
    let node = unwrap(input);
    for (let depth = 0; node?.type === 'CallExpression' && depth < 24; depth += 1) {
      const callee = unwrap(node.callee);
      if (callee?.type !== 'MemberExpression') return null;
      if (memberName(callee) === 'select') return identify(callee.object);
      node = unwrap(callee.object);
    }
    return null;
  };
  const functionOf = (module: Module, value: Syntax): Syntax | null => {
    const node = unwrap(value.type === 'VariableDeclarator' ? value.init : value);
    if (node === null || FUNCTIONS.has(node.type)) return node;
    if (node.type !== 'CallExpression') return null;
    const direct = unwrap(node.callee),
      builder = direct?.type === 'CallExpression' ? unwrap(direct.callee) : direct;
    if (builder?.type !== 'MemberExpression' || builder.object.type !== 'Identifier') return null;
    const imported = module.imports.get(builder.object.name),
      method = memberName(builder);
    if (
      !imported ||
      imported.typeOnly ||
      !['fn', 'fnUntraced', 'gen'].includes(method ?? '') ||
      !(
        (imported.source === 'effect' && imported.name === 'Effect') ||
        (imported.source === 'effect/Effect' && imported.name === '*')
      )
    )
      return null;
    const fn = node.arguments[0];
    return node.arguments.length === 1 && FUNCTIONS.has(fn?.type) ? fn : null;
  };
  const summary = (owner: Origin, depth = 0): ReadonlySet<number> => {
    const declaration = owner.module.declarations.get(owner.name),
      fn = declaration ? functionOf(owner.module, declaration) : null;
    if (!fn || fn.typeParameters || summarizing.has(fn) || depth > 4 || steps > 4000) return new Set();
    if (summaries.has(fn)) return summaries.get(fn)!;
    summarizing.add(fn);
    const parameters = new Map<string, number>();
    for (const [index, parameter] of fn.params.entries()) {
      if (parameter.type === 'Identifier' && parsedType(owner.module, parameter.typeAnnotation))
        parameters.set(parameter.name, index);
    }
    const used = new Set<number>(),
      invalid = new Set<string>(),
      shadowed = new Set<string>(),
      effects: Syntax[] = [];
    const body = asNode(fn.body);
    const stack = body === null ? [] : [body];
    if (body && body.type !== 'BlockStatement') effects.push(body);
    const patternNames = (input: unknown): string[] => {
      const pending = asNode(input),
        names: string[] = [],
        nodes = pending ? [pending] : [];
      while (nodes.length > 0 && ++steps <= 4000) {
        const node = nodes.pop()!;
        if (node.type === 'Identifier') names.push(node.name);
        else for (const child of childrenOf(node, {})) nodes.push(child);
      }
      return names;
    };
    while (stack.length > 0 && ++steps <= 4000) {
      const node = stack.pop()!;
      if (FUNCTIONS.has(node.type)) {
        for (const name of patternNames(node.id)) {
          invalid.add(name);
          shadowed.add(name);
        }
        // A closure may reassign the captured parameter. Its query is not this helper's
        // yielded effect, but its writes still make the binding unsafe to summarize.
        const nested = [node];
        while (nested.length > 0 && ++steps <= 4000) {
          const child = nested.pop()!;
          if (child.type === 'AssignmentExpression' || child.type === 'UpdateExpression') {
            for (const name of patternNames(child.left ?? child.argument)) invalid.add(name);
          }
          for (const descendant of childrenOf(child, {})) nested.push(descendant);
        }
        continue;
      }
      const binding = node.type === 'VariableDeclarator' ? node.id : node.type === 'CatchClause' ? node.param : null;
      for (const name of patternNames(binding)) {
        invalid.add(name);
        shadowed.add(name);
      }
      if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
        for (const name of patternNames(node.left ?? node.argument)) {
          invalid.add(name);
          shadowed.add(name);
        }
      }
      const effect =
        node.type === 'YieldExpression' && node.delegate === true
          ? node.argument
          : node.type === 'ReturnStatement'
            ? node.argument
            : null;
      const expression = asNode(effect);
      if (expression) effects.push(expression);
      for (const child of childrenOf(node, {})) stack.push(child);
    }
    for (const effect of effects) {
      const found = query(effect, (subject) =>
        subject.type === 'Identifier' && !invalid.has(subject.name) ? (parameters.get(subject.name) ?? null) : null,
      );
      if (found !== null) used.add(found);
      const call = unwrap(effect);
      if (call?.type === 'CallExpression' && call.callee.type === 'Identifier' && !shadowed.has(call.callee.name)) {
        const child = origin(owner.module, call.callee.name);
        if (child)
          for (const index of summary(child, depth + 1)) {
            const argument = unwrap(call.arguments[index]);
            const parameter =
              argument?.type === 'Identifier' && !invalid.has(argument.name)
                ? parameters.get(argument.name)
                : undefined;
            if (parameter !== undefined) used.add(parameter);
          }
      }
    }
    summarizing.delete(fn);
    const result = steps > 4000 ? new Set<number>() : used;
    summaries.set(fn, result);
    return result;
  };
  return (input: unknown): ReadonlySet<Variable> => {
    const result = new Set<Variable>(),
      direct = query(input, root);
    if (direct !== null) result.add(direct);
    const call = unwrap(input);
    if (
      call?.type !== 'CallExpression' ||
      call.callee.type !== 'Identifier' ||
      call.arguments.some((argument: Syntax) => argument.type === 'SpreadElement')
    )
      return result;
    const argumentsByIndex = call.arguments.map((argument: Syntax) => root(argument));
    if (!argumentsByIndex.some((value: Variable | null) => value !== null)) return result;
    const imported = lexicalImport(call.callee);
    if (!imported || imported.typeOnly) return result;
    const filename = resolve(context.filename, imported.source),
      module = filename === null ? null : load(filename);
    const local = module?.exports.get(imported.name),
      owner = module && local ? origin(module, local) : null;
    if (owner)
      for (const index of summary(owner)) {
        const argument = argumentsByIndex[index];
        if (argument) result.add(argument);
      }
    return result;
  };
}
