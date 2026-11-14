import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseSync } from 'oxc-parser';

type Syntax = { readonly type: string; readonly [key: string]: unknown };

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TEST_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORY = /(?:^|[/\\])(?:tests?|__tests__)[/\\]/u;
// These are dependency, VCS, and emitted-artifact boundaries, not source ownership exemptions.
const ARTIFACT_DIRECTORIES = new Set(['node_modules', '.git', '.codex', '.output', '.cache', 'dist', 'coverage']);
const NODE_ENTRY = /^node (?<entry>\.\/[A-Za-z0-9_./-]+\.[cm]?[jt]s)$/u;

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const node = (value: unknown): Syntax | null => {
  const candidate = object(value);
  return candidate !== null && typeof candidate.type === 'string' ? candidate as Syntax : null;
};
const string = (value: unknown): string | null => {
  const candidate = node(value);
  return candidate?.type === 'Literal' && typeof candidate.value === 'string' ? candidate.value : null;
};
interface LexicalBinding {
  readonly initializer: Syntax | null;
  readonly constant: boolean;
  readonly imported: { readonly source: string; readonly name: string } | null;
  readonly projectedMember: string | null;
  written: boolean;
  ambiguous: boolean;
}
interface LexicalScope {
  readonly parent: LexicalScope | null;
  readonly functionScope: boolean;
  readonly bindings: Map<string, LexicalBinding>;
}
interface LexicalSource {
  readonly nodes: readonly Syntax[];
  readonly parents: ReadonlyMap<Syntax, Syntax>;
  readonly parameters: ReadonlyMap<LexicalBinding, { readonly owner: Syntax; readonly index: number }>;
  readonly lookup: (identifier: Syntax) => LexicalBinding | null;
  readonly unboundWrites: ReadonlySet<string>;
  readonly metaClosed: boolean;
  readonly commonJs: boolean;
}
const FUNCTION_SYNTAX = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'ParenthesizedExpression']);
function unwrap(value: Syntax): Syntax {
  let current = value;
  while (WRAPPERS.has(current.type)) {
    const inner = node(current.expression);
    if (inner === null) break;
    current = inner;
  }
  return current;
}
function lexicalSource(program: Syntax): LexicalSource {
  const root: LexicalScope = { parent: null, functionScope: true, bindings: new Map() };
  const scopes = new Map<Syntax, LexicalScope>();
  const parents = new Map<Syntax, Syntax>();
  const nodes: Syntax[] = [];
  const parameters = new Map<LexicalBinding, { readonly owner: Syntax; readonly index: number }>();
  const unboundWrites = new Set<string>();
  const bind = (pattern: Syntax | null, scope: LexicalScope, initializer: Syntax | null, constant: boolean,
    imported: LexicalBinding['imported'] = null, projectedMember: string | null = null): void => {
    if (pattern === null) return;
    if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
      const previous = scope.bindings.get(pattern.name);
      if (previous === undefined) scope.bindings.set(pattern.name, { initializer, constant, imported, projectedMember, written: false, ambiguous: false });
      else previous.ambiguous = true;
      return;
    }
    if (pattern.type === 'AssignmentPattern') { bind(node(pattern.left), scope, null, false); return; }
    if (pattern.type === 'RestElement') { bind(node(pattern.argument), scope, null, false); return; }
    if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
      for (const value of pattern.properties) {
        const property = node(value);
        if (property?.type === 'RestElement') { bind(node(property.argument), scope, null, false); continue; }
        const key = node(property?.key);
        const member = property?.computed === true ? string(key) : typeof key?.name === 'string' ? key.name : string(key);
        bind(node(property?.value), scope, member === null ? null : initializer, constant, null, member);
      }
    }
    if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements)) for (const value of pattern.elements) bind(node(value), scope, null, false);
  };
  const visit = (value: Syntax, inherited: LexicalScope): void => {
    nodes.push(value);
    if (value.type === 'FunctionDeclaration' || value.type === 'ClassDeclaration') bind(node(value.id), inherited, null, false);
    let active = inherited;
    if (FUNCTION_SYNTAX.has(value.type)) {
      active = { parent: inherited, functionScope: true, bindings: new Map() };
      if (value.type === 'FunctionExpression') bind(node(value.id), active, null, false);
      if (Array.isArray(value.params)) for (const [index, parameter] of value.params.entries()) {
        const selected = node(parameter);
        bind(selected, active, null, false);
        if (selected?.type === 'Identifier' && typeof selected.name === 'string') {
          const binding = active.bindings.get(selected.name);
          if (binding !== undefined) parameters.set(binding, { owner: value, index });
        }
      }
    } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'ClassExpression', 'ClassDeclaration', 'StaticBlock'].includes(value.type)) {
      active = { parent: inherited, functionScope: false, bindings: new Map() };
      if (value.type === 'CatchClause') bind(node(value.param), active, null, false);
      if (value.type === 'ClassExpression') bind(node(value.id), active, null, false);
    }
    scopes.set(value, active);
    if (value.type === 'ImportDeclaration') {
      const source = string(value.source);
      for (const entry of Array.isArray(value.specifiers) ? value.specifiers : []) {
        const specifier = node(entry);
        const imported = node(specifier?.imported);
        const name = specifier?.type === 'ImportNamespaceSpecifier' ? '*' : specifier?.type === 'ImportDefaultSpecifier' ? 'default' :
          typeof imported?.name === 'string' ? imported.name : string(imported);
        bind(node(specifier?.local), active, null, true, source !== null && name !== null && value.importKind !== 'type' && specifier?.importKind !== 'type' ? { source, name } : null);
      }
    }
    if (value.type === 'TSImportEqualsDeclaration') {
      const reference = node(value.moduleReference);
      const source = reference?.type === 'TSExternalModuleReference' ? string(reference.expression) : null;
      bind(node(value.id), active, null, true, source !== null && value.importKind !== 'type' ? { source, name: '*' } : null);
    }
    if (value.type === 'VariableDeclaration' && Array.isArray(value.declarations)) {
      let target = active;
      if (value.kind === 'var') while (!target.functionScope && target.parent !== null) target = target.parent;
      for (const entry of value.declarations) { const declaration = node(entry); bind(node(declaration?.id), target, node(declaration?.init), value.kind === 'const'); }
    }
    for (const child of children(value)) { parents.set(child, value); visit(child, active); }
  };
  visit(program, root);
  const lookup = (identifier: Syntax): LexicalBinding | null => {
    if (identifier.type !== 'Identifier' || typeof identifier.name !== 'string') return null;
    const parent = parents.get(identifier);
    if (parent?.type === 'MetaProperty' ||
      (parent?.type === 'MemberExpression' && parent.property === identifier && !parent.computed) ||
      (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type ?? '') && parent?.key === identifier && !parent.computed && parent.value !== identifier) ||
      (parent?.type === 'ImportSpecifier' && parent.imported === identifier && parent.local !== identifier) ||
      (parent?.type === 'ExportSpecifier' && parent.exported === identifier && parent.local !== identifier) ||
      (parent?.type.startsWith('TS') && !(WRAPPERS.has(parent.type) && parent.expression === identifier))) return null;
    let scope: LexicalScope | null = scopes.get(identifier) ?? null;
    while (scope !== null) {
      const selected = scope.bindings.get(identifier.name);
      if (selected !== undefined) return selected;
      scope = scope.parent;
    }
    return null;
  };
  const write = (target: Syntax | null): void => {
    if (target === null) return;
    if (target.type === 'Identifier') {
      const binding = lookup(target);
      if (binding !== null) binding.written = true;
      else if (typeof target.name === 'string') unboundWrites.add(target.name);
      return;
    }
    if (target.type === 'MemberExpression') { write(node(target.object)); return; }
    if (target.type === 'Property') { write(node(target.value)); return; }
    if (target.type === 'AssignmentPattern') { write(node(target.left)); return; }
    if (target.type === 'RestElement') { write(node(target.argument)); return; }
    for (const child of children(target)) write(child);
  };
  for (const value of nodes) {
    if (value.type === 'AssignmentExpression') write(node(value.left));
    else if (value.type === 'UpdateExpression') write(node(value.argument));
    else if (value.type === 'ForInStatement' || value.type === 'ForOfStatement') { const left = node(value.left); if (left?.type !== 'VariableDeclaration') write(left); }
    else if (value.type === 'CallExpression') {
      const callee = node(value.callee);
      const receiver = node(callee?.object);
      const key = node(callee?.property);
      const member = callee?.computed === true ? string(key) : key?.name;
      if (callee?.type !== 'MemberExpression' || receiver?.type !== 'Identifier' || lookup(receiver) !== null || typeof member !== 'string') continue;
      const mutator = receiver.name === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(member) ||
        receiver.name === 'Reflect' && ['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf'].includes(member);
      if (mutator && Array.isArray(value.arguments)) write(node(value.arguments[0]));
    }
  }
  const lexical: LexicalSource = { nodes, parents, parameters, lookup, unboundWrites, metaClosed: true, commonJs: program.sourceType === 'script' };
  return { ...lexical, metaClosed: closedImportMeta(lexical, parents) };
}
function importMeta(value: Syntax): boolean {
  const current = unwrap(value);
  return current.type === 'MetaProperty' && node(current.meta)?.name === 'import' && node(current.property)?.name === 'meta';
}
function importMetaObject(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>()): boolean {
  const current = unwrap(value);
  if (importMeta(current)) return true;
  if (current.type !== 'Identifier') return false;
  const binding = lexical.lookup(current);
  return binding !== null && !binding.ambiguous && binding.projectedMember === null && binding.initializer !== null && !visiting.has(binding) &&
    importMetaObject(binding.initializer, lexical, new Set([...visiting, binding]));
}
function closedImportMeta(lexical: LexicalSource, parents: ReadonlyMap<Syntax, Syntax>): boolean {
  for (const value of lexical.nodes) {
    const immediate = parents.get(value);
    if (immediate?.type === 'MetaProperty' ||
      (immediate?.type === 'MemberExpression' && immediate.property === value && !immediate.computed) ||
      (immediate?.type === 'Property' && immediate.key === value && !immediate.computed && immediate.value !== value) ||
      (immediate?.type === 'ExportSpecifier' && immediate.exported === value && immediate.local !== value)) continue;
    if (!importMetaObject(value, lexical)) continue;
    let held = value;
    let parent = parents.get(held);
    while (parent !== undefined && WRAPPERS.has(parent.type) && parent.expression === held) { held = parent; parent = parents.get(held); }
    if (parent?.type === 'VariableDeclarator' && parent.id === held) continue;
    if (parent?.type === 'MemberExpression' && parent.object === held) {
      const property = node(parent.property);
      const name = parent.computed === true ? string(property) : property?.name;
      let member: Syntax = parent;
      let used = parents.get(member);
      while (used !== undefined && WRAPPERS.has(used.type) && used.expression === member) { member = used; used = parents.get(member); }
      if (!['url', 'filename', 'dirname', 'main', 'resolve'].includes(typeof name === 'string' ? name : '') ||
        (used?.type === 'AssignmentExpression' && used.left === member) ||
        (used?.type === 'UpdateExpression' && used.argument === member) ||
        (used?.type === 'UnaryExpression' && used.operator === 'delete' && used.argument === member) ||
        (['ForInStatement', 'ForOfStatement'].includes(used?.type ?? '') && used?.left === member)) return false;
      continue;
    }
    if (parent?.type === 'VariableDeclarator' && parent.init === held) {
      const declaration = parents.get(parent);
      const exported = declaration === undefined ? undefined : parents.get(declaration);
      if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const' || exported?.type.startsWith('Export')) return false;
      const pattern = node(parent.id);
      if (pattern?.type === 'Identifier') continue;
      if (pattern?.type !== 'ObjectPattern' || !Array.isArray(pattern.properties)) return false;
      if (pattern.properties.some((entry) => {
        const property = node(entry);
        const key = node(property?.key);
        const name = property?.computed === true ? string(key) : key?.name ?? string(key);
        return property?.type !== 'Property' || node(property.value)?.type !== 'Identifier' || !['url', 'filename', 'dirname', 'main'].includes(typeof name === 'string' ? name : '');
      })) return false;
      continue;
    }
    return false;
  }
  return true;
}
function staticSource(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>(), loose = false): string | null {
  const current = unwrap(value);
  const literal = string(current);
  if (literal !== null) return literal;
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    if (binding === null || binding.initializer === null || binding.ambiguous || visiting.has(binding) ||
      (!loose && (!binding.constant || binding.written))) return null;
    return staticSource(binding.initializer, lexical, new Set([...visiting, binding]), loose);
  }
  if (current.type === 'TemplateLiteral' && Array.isArray(current.expressions) && Array.isArray(current.quasis)) {
    let result = '';
    for (let index = 0; index < current.quasis.length; index += 1) {
      const text = object(node(current.quasis[index])?.value)?.cooked;
      if (typeof text !== 'string') return null;
      result += text;
      if (index < current.expressions.length) {
        const expression = node(current.expressions[index]);
        const selected = expression === null ? null : staticSource(expression, lexical, visiting, loose);
        if (selected === null) return null;
        result += selected;
      }
    }
    return result;
  }
  if (current.type !== 'BinaryExpression' || current.operator !== '+') return null;
  const left = node(current.left);
  const right = node(current.right);
  const prefix = left === null ? null : staticSource(left, lexical, visiting, loose);
  const suffix = right === null ? null : staticSource(right, lexical, visiting, loose);
  return prefix !== null && suffix !== null ? prefix + suffix : null;
}
function invalidSourceBinding(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>()): boolean {
  const current = unwrap(value);
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    if (binding === null) return false;
    if (binding.ambiguous || binding.written || visiting.has(binding) ||
      (!binding.constant && binding.initializer !== null && staticSource(binding.initializer, lexical, new Set([...visiting, binding]), true) !== null)) return true;
    return binding.initializer !== null && invalidSourceBinding(binding.initializer, lexical, new Set([...visiting, binding]));
  }
  return children(current).some((child) => invalidSourceBinding(child, lexical, visiting));
}
function sourcePrefix(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>()): string | null {
  const current = unwrap(value);
  const complete = staticSource(current, lexical, visiting, true);
  if (complete !== null) return complete;
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    return binding === null || binding.initializer === null || visiting.has(binding) ? null :
      sourcePrefix(binding.initializer, lexical, new Set([...visiting, binding]));
  }
  if (current.type === 'BinaryExpression' && current.operator === '+') { const left = node(current.left); return left === null ? null : sourcePrefix(left, lexical, visiting); }
  if (current.type !== 'TemplateLiteral' || !Array.isArray(current.quasis) || !Array.isArray(current.expressions)) return null;
  const initial = object(node(current.quasis[0])?.value)?.cooked;
  if (typeof initial !== 'string') return null;
  let result = initial;
  for (let index = 0; index < current.expressions.length; index += 1) {
    const expression = node(current.expressions[index]);
    const selected = expression === null ? null : staticSource(expression, lexical, visiting, true);
    if (selected === null) return result;
    const text = object(node(current.quasis[index + 1])?.value)?.cooked;
    if (typeof text !== 'string') return result;
    result += selected + text;
  }
  return result;
}
type NativeLoader = 'loader' | 'factory' | 'module';
function nativeLoader(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>()): NativeLoader | null {
  const current = unwrap(value);
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    if (binding === null) return current.name === 'require' ? 'loader' : null;
    if (binding.ambiguous || visiting.has(binding)) return null;
    if (binding.imported !== null) {
      if (!['node:module', 'module'].includes(binding.imported.source)) return null;
      return binding.imported.name === 'createRequire' ? 'factory' : ['*', 'default'].includes(binding.imported.name) ? 'module' : null;
    }
    if (binding.projectedMember !== null) {
      return binding.projectedMember === 'createRequire' && binding.initializer !== null &&
        nativeLoader(binding.initializer, lexical, new Set([...visiting, binding])) === 'module' ? 'factory' : null;
    }
    return binding.initializer === null ? null : nativeLoader(binding.initializer, lexical, new Set([...visiting, binding]));
  }
  if (current.type === 'MemberExpression') {
    const object = node(current.object);
    const property = node(current.property);
    const name = current.computed === true ? string(property) : property?.name;
    if (name === 'require' && object?.type === 'Identifier' && object.name === 'module' && lexical.lookup(object) === null) return 'loader';
    return name === 'createRequire' && object !== null && nativeLoader(object, lexical, visiting) === 'module' ? 'factory' : null;
  }
  if (current.type !== 'CallExpression') return null;
  const callee = node(current.callee);
  const origin = callee === null ? null : nativeLoader(callee, lexical, visiting);
  if (origin === 'factory') return 'loader';
  if (origin !== 'loader' || !Array.isArray(current.arguments) || current.arguments.length !== 1) return null;
  const argument = node(current.arguments[0]);
  const builtin = argument === null ? null : staticSource(argument, lexical, new Set(), true);
  return builtin === 'node:module' || builtin === 'module' ? 'module' : null;
}
/** Retain potential native origin for consumers, but never certify mutable loader custody. */
function invalidNativeLoaderBinding(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>()): boolean {
  const current = unwrap(value);
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    if (binding === null) return current.name !== 'require' ||
      ['require', 'globalThis', 'global'].some((name) => lexical.unboundWrites.has(name));
    if (!binding.constant || binding.written || binding.ambiguous || visiting.has(binding)) return true;
    if (binding.imported !== null) return !['node:module', 'module'].includes(binding.imported.source);
    return binding.initializer === null || invalidNativeLoaderBinding(binding.initializer, lexical, new Set([...visiting, binding]));
  }
  if (current.type === 'MemberExpression') {
    const receiver = node(current.object);
    const property = node(current.property);
    const member = current.computed === true ? string(property) : property?.name;
    if (member === 'require' && receiver?.type === 'Identifier' && receiver.name === 'module' && lexical.lookup(receiver) === null) {
      return ['module', 'globalThis', 'global'].some((name) => lexical.unboundWrites.has(name));
    }
    return receiver === null || invalidNativeLoaderBinding(receiver, lexical, visiting);
  }
  if (current.type !== 'CallExpression') return true;
  const callee = node(current.callee);
  if (callee === null || invalidNativeLoaderBinding(callee, lexical, visiting) ||
    !Array.isArray(current.arguments) || current.arguments.length !== 1) return true;
  const argument = node(current.arguments[0]);
  if (argument === null || invalidSourceBinding(argument, lexical)) return true;
  return nativeLoader(callee, lexical, visiting) === 'loader' &&
    !['node:module', 'module'].includes(staticSource(argument, lexical) ?? '');
}
function importerBaseValue(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>()): boolean {
  const current = unwrap(value);
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    if (binding === null) return current.name === '__filename' && lexical.commonJs &&
      !['__filename', 'globalThis', 'global'].some((name) => lexical.unboundWrites.has(name));
    if (!binding.constant || binding.written || binding.ambiguous || binding.initializer === null || visiting.has(binding)) return false;
    if (binding.projectedMember !== null) return ['url', 'filename'].includes(binding.projectedMember) && lexical.metaClosed && importMetaObject(binding.initializer, lexical);
    return importerBaseValue(binding.initializer, lexical, new Set([...visiting, binding]));
  }
  if (current.type !== 'MemberExpression' || !lexical.metaClosed) return false;
  const receiver = node(current.object);
  const property = node(current.property);
  const member = current.computed === true ? string(property) : property?.name;
  return ['url', 'filename'].includes(typeof member === 'string' ? member : '') && receiver !== null && importMetaObject(receiver, lexical);
}
/** Only a closed importer-owned filename/URL gives relative loader calls an importer base. */
function nativeLoaderBase(value: Syntax, lexical: LexicalSource, visiting = new Set<LexicalBinding>()): 'importer' | 'unproven' {
  const current = unwrap(value);
  if (invalidNativeLoaderBinding(current, lexical)) return 'unproven';
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    if (binding === null) return current.name === 'require' ? 'importer' : 'unproven';
    if (binding.initializer === null || visiting.has(binding)) return 'unproven';
    return nativeLoaderBase(binding.initializer, lexical, new Set([...visiting, binding]));
  }
  if (current.type === 'MemberExpression') {
    const receiver = node(current.object);
    const property = node(current.property);
    const member = current.computed === true ? string(property) : property?.name;
    return member === 'require' && receiver?.type === 'Identifier' && receiver.name === 'module' && lexical.lookup(receiver) === null ? 'importer' : 'unproven';
  }
  if (current.type !== 'CallExpression' || !Array.isArray(current.arguments) || current.arguments.length !== 1) return 'unproven';
  const callee = node(current.callee);
  const argument = node(current.arguments[0]);
  return callee !== null && nativeLoader(callee, lexical, visiting) === 'factory' && argument !== null && importerBaseValue(argument, lexical) ? 'importer' : 'unproven';
}
const FINITE_MODULE_LIMIT = 64;
function enclosingFunction(value: Syntax, lexical: LexicalSource): Syntax | null {
  let parent = lexical.parents.get(value);
  while (parent !== undefined) {
    if (FUNCTION_SYNTAX.has(parent.type) || parent.type === 'Program') return parent;
    parent = lexical.parents.get(parent);
  }
  return null;
}
function hasAmbientEvaluator(lexical: LexicalSource): boolean {
  return lexical.nodes.some((value) => {
    if (value.type !== 'CallExpression' && value.type !== 'NewExpression') return false;
    const callee = node(value.callee);
    if (callee === null) return false;
    const selected = unwrap(callee);
    if (selected.type === 'Identifier' && ['eval', 'Function'].includes(typeof selected.name === 'string' ? selected.name : '') && lexical.lookup(selected) === null) return true;
    if (selected.type !== 'MemberExpression') return false;
    const receiver = node(selected.object);
    const property = node(selected.property);
    const name = selected.computed === true ? string(property) : property?.name;
    return receiver?.type === 'Identifier' && ['globalThis', 'global', 'window', 'self'].includes(typeof receiver.name === 'string' ? receiver.name : '') &&
      lexical.lookup(receiver) === null && ['eval', 'Function'].includes(typeof name === 'string' ? name : '');
  });
}
interface FiniteModuleState {
  readonly bindings: ReadonlySet<LexicalBinding>;
  readonly functions: ReadonlySet<Syntax>;
}
function finiteParameterSpecifiers(source: Syntax, binding: LexicalBinding, lexical: LexicalSource, state: FiniteModuleState): readonly string[] | null {
  const origin = lexical.parameters.get(binding);
  if (origin === undefined || binding.written || binding.ambiguous || state.functions.size !== 0 || hasAmbientEvaluator(lexical)) return null;
  const owner = origin.owner;
  if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(owner.type) || owner.async === true || owner.generator === true || owner.id !== null && owner.id !== undefined ||
    !Array.isArray(owner.params) || owner.params.some((parameter) => node(parameter)?.type !== 'Identifier') || enclosingFunction(source, lexical) !== owner) return null;
  let initializer = owner;
  let declarator = lexical.parents.get(initializer);
  while (declarator !== undefined && WRAPPERS.has(declarator.type) && declarator.expression === initializer) { initializer = declarator; declarator = lexical.parents.get(initializer); }
  if (declarator?.type !== 'VariableDeclarator' || declarator.init !== initializer) return null;
  const identifier = node(declarator.id);
  const declaration = lexical.parents.get(declarator);
  const exported = declaration === undefined ? undefined : lexical.parents.get(declaration);
  if (identifier?.type !== 'Identifier' || declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const' || exported?.type.startsWith('Export')) return null;
  const callable = lexical.lookup(identifier);
  if (callable === null || !callable.constant || callable.written || callable.ambiguous || callable.initializer === null || unwrap(callable.initializer) !== owner) return null;
  const scope = enclosingFunction(declarator, lexical);
  const result = new Set<string>();
  let calls = 0;
  for (const reference of lexical.nodes) {
    if (reference.type !== 'Identifier' || lexical.lookup(reference) !== callable) continue;
    const direct = lexical.parents.get(reference);
    if (direct === declarator && declarator.id === reference) continue;
    let held = reference;
    let call = direct;
    while (call !== undefined && WRAPPERS.has(call.type) && call.expression === held) { held = call; call = lexical.parents.get(held); }
    if (call?.type !== 'CallExpression' || call.callee !== held || call.optional === true || !Array.isArray(call.arguments) ||
      call.arguments.some((argument) => node(argument)?.type === 'SpreadElement') || enclosingFunction(call, lexical) !== scope) return null;
    const argument = node(call.arguments[origin.index]);
    if (argument === null) return null;
    const selected = finiteModuleValues(argument, lexical, { bindings: state.bindings, functions: new Set([...state.functions, owner]) });
    if (selected === null || selected.length === 0) return null;
    for (const value of selected) result.add(value);
    if (result.size > FINITE_MODULE_LIMIT) return null;
    calls += 1;
  }
  return calls === 0 ? null : [...result];
}
function finiteModuleValues(source: Syntax, lexical: LexicalSource, state: FiniteModuleState): readonly string[] | null {
  const current = unwrap(source);
  const literal = string(current);
  if (literal !== null) return [literal];
  if (current.type === 'Identifier') {
    const binding = lexical.lookup(current);
    if (binding === null || binding.written || binding.ambiguous || state.bindings.has(binding)) return null;
    if (lexical.parameters.has(binding)) return finiteParameterSpecifiers(current, binding, lexical, state);
    if (!binding.constant || binding.initializer === null || binding.projectedMember !== null) return null;
    return finiteModuleValues(binding.initializer, lexical, { bindings: new Set([...state.bindings, binding]), functions: state.functions });
  }
  const concatenate = (left: readonly string[] | null, right: readonly string[] | null): readonly string[] | null => {
    if (left === null || right === null || left.length * right.length > FINITE_MODULE_LIMIT) return null;
    return [...new Set(left.flatMap((prefix) => right.map((suffix) => prefix + suffix)))];
  };
  if (current.type === 'BinaryExpression' && current.operator === '+') {
    const left = node(current.left);
    const right = node(current.right);
    return left === null || right === null ? null : concatenate(finiteModuleValues(left, lexical, state), finiteModuleValues(right, lexical, state));
  }
  if (current.type !== 'TemplateLiteral' || !Array.isArray(current.expressions) || !Array.isArray(current.quasis)) return null;
  let result: readonly string[] | null = [''];
  for (let index = 0; index < current.quasis.length; index += 1) {
    const text = object(node(current.quasis[index])?.value)?.cooked;
    if (typeof text !== 'string') return null;
    result = concatenate(result, [text]);
    if (index < current.expressions.length) {
      const expression = node(current.expressions[index]);
      if (expression === null) return null;
      result = concatenate(result, finiteModuleValues(expression, lexical, state));
    }
  }
  return result;
}
/** One closed local wrapper may specialize its module parameter from all direct finite callers. */
function finiteModuleSpecifiers(source: Syntax, lexical: LexicalSource): readonly string[] | null {
  return finiteModuleValues(source, lexical, { bindings: new Set(), functions: new Set() });
}
const within = (owner: string, filename: string): boolean => {
  const relative = path.relative(owner, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function packageOwner(filename: string): string | null {
  let directory = path.dirname(filename);
  while (true) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function moduleCandidates(filename: string, source: string): string[] {
  if (!source.startsWith('./') && !source.startsWith('../')) return [];
  if (source.includes('\\') || source.includes('\0') || /[?#]/u.test(source)) return [];
  const base = path.resolve(path.dirname(filename), source);
  const extension = path.extname(base);
  if (extension !== '') {
    const emitted = new Map([['.js', '.ts'], ['.jsx', '.tsx'], ['.mjs', '.mts'], ['.cjs', '.cts']]);
    const native = emitted.get(extension);
    return native === undefined ? [base] : [base, base.slice(0, -extension.length) + native];
  }
  return SOURCE_EXTENSIONS.flatMap((suffix) => [base + suffix, path.join(base, `index${suffix}`)]);
}

function existingModules(filename: string, source: string): string[] {
  const result = new Set<string>();
  for (const candidate of moduleCandidates(filename, source)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) result.add(realpathSync(candidate));
  }
  return [...result];
}

/** Local construction stays within one real package, including after native TS/JS resolution. */
export function resolveOwnedToolingImport(owner: string, filename: string, source: string): string | null {
  try {
    const canonicalOwner = realpathSync(owner);
    const canonicalFile = realpathSync(filename);
    if (canonicalOwner !== path.resolve(owner) || canonicalFile !== path.resolve(filename) ||
      !within(canonicalOwner, canonicalFile) || packageOwner(canonicalFile) !== canonicalOwner) return null;
    const candidates = moduleCandidates(canonicalFile, source);
    const resolved = existingModules(canonicalFile, source);
    if (resolved.length !== 1) return null;
    const target = resolved[0];
    if (target === undefined || !within(canonicalOwner, target) || packageOwner(target) !== canonicalOwner ||
      !candidates.includes(target)) return null;
    return target;
  } catch {
    return null;
  }
}

function sourceFiles(owner: string): string[] | null {
  const result = new Set<string>();
  const directories = [owner];
  const visited = new Set<string>();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined || visited.has(directory)) continue;
    visited.add(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ARTIFACT_DIRECTORIES.has(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const information = lstatSync(filename);
      const canonical = realpathSync(filename);
      if (!within(owner, canonical)) return null;
      if (information.isSymbolicLink()) {
        // A source alias cannot create a second package boundary or hide an incoming consumer.
        if (statSync(filename).isDirectory()) directories.push(canonical);
        else if (SOURCE_EXTENSIONS.includes(path.extname(filename))) result.add(canonical);
      } else if (information.isDirectory()) directories.push(filename);
      else if (information.isFile() && SOURCE_EXTENSIONS.includes(path.extname(filename))) result.add(filename);
    }
  }
  return [...result];
}

function children(value: Syntax): Syntax[] {
  return Object.entries(value).flatMap(([key, entry]) => key === 'parent' ? [] :
    (Array.isArray(entry) ? entry : [entry]).flatMap((child) => {
      const selected = node(child);
      return selected === null ? [] : [selected];
    }));
}

function importSource(value: Syntax, lexical: LexicalSource): Syntax | null {
  if (value.type === 'TSImportEqualsDeclaration' && value.importKind !== 'type') {
    const reference = node(value.moduleReference);
    const source = node(reference?.expression);
    return reference?.type === 'TSExternalModuleReference' && string(source) !== null ? source : null;
  }
  if ((value.type === 'ImportDeclaration' || value.type === 'ExportNamedDeclaration' || value.type === 'ExportAllDeclaration') &&
    value.importKind !== 'type' && value.exportKind !== 'type') {
    const specifiers = Array.isArray(value.specifiers) ? value.specifiers.map(node) : [];
    if (specifiers.length > 0 && specifiers.every((specifier) => specifier?.importKind === 'type' || specifier?.exportKind === 'type')) return null;
    return node(value.source);
  }
  if (value.type === 'ImportExpression') return node(value.source);
  if (value.type !== 'CallExpression') return null;
  const callee = node(value.callee);
  if (callee === null || nativeLoader(callee, lexical) !== 'loader') return null;
  return Array.isArray(value.arguments) && value.arguments.length > 0 ? node(value.arguments[0]) : null;
}

export interface NativeModuleSourceReference {
  readonly base: 'importer' | 'unproven';
  readonly staticSpecifier: string | null;
  readonly prefix: string | null;
  readonly invalidBinding: boolean;
  readonly kind: 'native-loader' | 'dynamic-import';
}

/** Pure shared evidence: consumers retain their own file inventory and acceptance policy. */
export function nativeModuleSourceReferences(program: unknown): readonly NativeModuleSourceReference[] | null {
  const root = node(program);
  if (root?.type !== 'Program' || !Array.isArray(root.body)) return null;
  const lexical = lexicalSource(root);
  const references: NativeModuleSourceReference[] = [];
  for (const current of lexical.nodes) {
    let kind: NativeModuleSourceReference['kind'];
    let base: NativeModuleSourceReference['base'] = 'importer';
    let invalidLoaderBinding = false;
    if (current.type === 'ImportExpression') kind = 'dynamic-import';
    else if (current.type === 'TSImportEqualsDeclaration' && current.importKind !== 'type' && node(current.moduleReference)?.type === 'TSExternalModuleReference') kind = 'native-loader';
    else if (current.type === 'CallExpression') {
      const callee = node(current.callee);
      if (callee === null || nativeLoader(callee, lexical) !== 'loader') continue;
      base = nativeLoaderBase(callee, lexical);
      invalidLoaderBinding = invalidNativeLoaderBinding(callee, lexical);
      kind = 'native-loader';
    } else continue;
    const source = importSource(current, lexical);
    const specifiers = source === null ? null : finiteModuleSpecifiers(source, lexical);
    for (const staticSpecifier of specifiers ?? [null]) {
      references.push({
        base,
        staticSpecifier,
        prefix: staticSpecifier ?? (source === null ? null : sourcePrefix(source, lexical)),
        invalidBinding: source === null || invalidLoaderBinding || invalidSourceBinding(source, lexical),
        kind,
      });
    }
  }
  return references;
}

function staticSelectsEntry(importer: string, specifier: string, entry: string): boolean {
  if (specifier.startsWith('file:')) {
    try { return realpathSync(fileURLToPath(specifier)) === entry; } catch { return false; }
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      const decoded = fileURLToPath(new URL(specifier, pathToFileURL(importer)));
      const relative = `./${path.relative(path.dirname(importer), decoded).replaceAll(path.sep, '/')}`;
      return existingModules(importer, relative).includes(entry);
    } catch { return true; }
  }
  if (specifier.startsWith('node:')) return false;
  try { return realpathSync(createRequire(importer).resolve(specifier)) === entry; } catch { return false; }
}
function selectsEntry(importer: string, source: Syntax, entry: string, lexical: LexicalSource): boolean {
  if (invalidSourceBinding(source, lexical)) return true;
  const specifiers = finiteModuleSpecifiers(source, lexical);
  if (specifiers !== null) return specifiers.some((specifier) => staticSelectsEntry(importer, specifier, entry));
  const text = sourcePrefix(source, lexical);
  if (typeof text !== 'string' || (!text.startsWith('./') && !text.startsWith('../'))) return false;
  // An unresolved dynamic suffix is relevant when its literal directory can contain this entry.
  const directory = text.endsWith('/') ? text : path.dirname(text);
  return within(path.resolve(path.dirname(importer), directory), entry);
}

function hasProductionConsumer(owner: string, entry: string, packageName: string | null): boolean {
  const sources = sourceFiles(owner);
  if (sources === null) return true;
  for (const filename of sources) {
    if (filename === entry || TEST_SOURCE.test(filename) || TEST_DIRECTORY.test(filename)) continue;
    const parsed = parseSync(filename, readFileSync(filename, 'utf8'), { sourceType: 'module' });
    if (parsed.errors.length !== 0) return true;
    const lexical = lexicalSource(parsed.program as unknown as Syntax);
    for (const current of lexical.nodes) {
      const source = importSource(current, lexical);
      const callee = current.type === 'CallExpression' ? node(current.callee) : null;
      if (source !== null && callee !== null && nativeLoader(callee, lexical) === 'loader' && nativeLoaderBase(callee, lexical) === 'unproven') {
        const selected = finiteModuleSpecifiers(source, lexical) ?? [sourcePrefix(source, lexical)];
        if (selected.some((specifier) => specifier !== null && (specifier.startsWith('./') || specifier.startsWith('../') ||
          (packageName !== null && (specifier === packageName || specifier.startsWith(`${packageName}/`)))))) return true;
      }
      if (source !== null && selectsEntry(filename, source, entry, lexical)) return true;
    }
  }
  return false;
}

function exposesEntry(value: unknown, owner: string, entry: string): boolean {
  if (typeof value === 'string') {
    if (path.isAbsolute(value) || value.includes('\\') || value.includes(':')) return false;
    const relative = value.startsWith('./') ? value : `./${value}`;
    if (relative.includes('*')) return entry.startsWith(path.resolve(owner, relative.slice(0, relative.indexOf('*'))));
    return existingModules(path.join(owner, 'package.json'), relative).includes(entry);
  }
  return value !== null && typeof value === 'object' && Object.values(value).some((child) => exposesEntry(child, owner, entry));
}

/** Registration grants process-root custody only; the caller must still prove the native CLI guard. */
export function registeredToolingPackageOwner(filename: string): string | null {
  try {
    const canonicalFile = realpathSync(filename);
    if (canonicalFile !== path.resolve(filename) || !statSync(canonicalFile).isFile()) return null;
    const owner = packageOwner(canonicalFile);
    if (owner === null || realpathSync(owner) !== owner) return null;
    const packageJson = object(JSON.parse(readFileSync(path.join(owner, 'package.json'), 'utf8')));
    const scripts = object(packageJson?.scripts);
    if (packageJson === null || scripts === null) return null;
    const registered = Object.values(scripts).some((command) => {
      if (typeof command !== 'string') return false;
      const source = NODE_ENTRY.exec(command)?.groups?.['entry'];
      if (source === undefined || source.slice(2).split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) return false;
      return resolveOwnedToolingImport(owner, path.join(owner, 'package.json'), source) === canonicalFile;
    });
    if (!registered || exposesEntry(packageJson.exports, owner, canonicalFile) || exposesEntry(packageJson.main, owner, canonicalFile) ||
      exposesEntry(packageJson.module, owner, canonicalFile) || hasProductionConsumer(owner, canonicalFile, typeof packageJson.name === 'string' ? packageJson.name : null)) return null;
    return owner;
  } catch {
    return null;
  }
}
