import { readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

type Node = Record<string, any>;
interface Scope {
  readonly parent: Scope | null;
  readonly bindings: Map<string, Binding>;
}
type Binding =
  | { readonly kind: 'data'; readonly mutable: boolean }
  | { readonly kind: 'function'; readonly node: Node; readonly scope: Scope }
  | { readonly kind: 'uninitialized' };

const erasedDeclaration = (node: Node): boolean =>
  node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration';
const callable = (node: Node): boolean =>
  ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type) &&
  !node.async && !node.generator && node.id == null;
const scope = (parent: Scope | null): Scope => ({ parent, bindings: new Map() });
const lookup = (current: Scope, name: string): Binding | undefined =>
  current.bindings.get(name) ?? (current.parent === null ? undefined : lookup(current.parent, name));
const literal = (node: Node): boolean =>
  node.type === 'Literal' && node.regex === undefined &&
  (node.value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof node.value));

/**
 * A deliberately bounded proof of controller-originated effects, not closed payload data.
 * All method inputs and slot reads are opaque, even when TypeScript says they are primitives.
 * Transport/identity/truthiness cannot activate a getter, Proxy trap or callback. Observation,
 * coercion, external writes and calls through those opaque values are never admitted.
 */
class PassiveStateProof {
  private readonly active = new Set<Node>();
  private readonly proven = new WeakMap<Node, WeakSet<Scope>>();

  private data(node: Node | null, current: Scope): boolean {
    if (node === null) return true;
    if (node.type === 'ParenthesizedExpression') return this.data(node.expression, current);
    if (literal(node)) return true;
    if (node.type === 'Identifier') return lookup(current, node.name)?.kind === 'data';
    if (node.type === 'UnaryExpression')
      return ['!', 'typeof', 'void'].includes(node.operator) && this.data(node.argument, current);
    if (node.type === 'BinaryExpression')
      return ['===', '!=='].includes(node.operator) && this.data(node.left, current) && this.data(node.right, current);
    if (node.type === 'LogicalExpression')
      return ['&&', '||', '??'].includes(node.operator) && this.data(node.left, current) && this.data(node.right, current);
    if (node.type === 'ConditionalExpression')
      return this.data(node.test, current) && this.data(node.consequent, current) && this.data(node.alternate, current);
    if (node.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier') {
      const target = lookup(current, node.callee.name);
      return target?.kind === 'function' &&
        node.arguments.every((argument: Node) => this.data(argument, current)) &&
        this.functionBody(target.node, target.scope);
    }
    return false;
  }

  private functionBody(node: Node, captured: Scope): boolean {
    if (!callable(node) || this.active.has(node)) return false;
    if (this.proven.get(node)?.has(captured)) return true;
    const parameters = scope(captured);
    for (const parameter of node.params) {
      // Destructuring, rest and defaults may activate caller-owned behavior.
      if (parameter.type !== 'Identifier' || parameters.bindings.has(parameter.name)) return false;
      parameters.bindings.set(parameter.name, { kind: 'data', mutable: true });
    }
    this.active.add(node);
    try {
      const valid = node.body.type === 'BlockStatement'
        ? this.block(node.body.body, parameters)
        : this.data(node.body, parameters);
      if (valid) {
        // Successful proofs read only initialized lexical bindings. Their callable/data
        // classification cannot change: helpers are const and every writable slot is opaque.
        // Cache by BOTH syntax and capture scope, never by a helper's spelling or input value.
        const scopes = this.proven.get(node) ?? new WeakSet<Scope>();
        scopes.add(captured);
        this.proven.set(node, scopes);
      }
      return valid;
    } finally {
      this.active.delete(node);
    }
  }

  private block(statements: readonly Node[], parent: Scope): boolean {
    const current = scope(parent);
    // Bind lexical declarations before inspecting any statement: a shadowing declaration
    // must never be mistaken for an outer safe helper, including before its initialization.
    for (const statement of statements) {
      if (statement.type !== 'VariableDeclaration') continue;
      if (statement.declare === true || !['const', 'let'].includes(statement.kind)) return false;
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || current.bindings.has(declaration.id.name)) return false;
        current.bindings.set(declaration.id.name, { kind: 'uninitialized' });
      }
    }
    for (const statement of statements) {
      if (erasedDeclaration(statement) || statement.type === 'EmptyStatement') continue;
      if (statement.type === 'VariableDeclaration') {
        for (const declaration of statement.declarations) {
          const initial = declaration.init;
          if (initial === null) return false;
          if (callable(initial)) {
            if (statement.kind !== 'const') return false;
            current.bindings.set(declaration.id.name, { kind: 'function', node: initial, scope: current });
            // Check unused helpers too. Otherwise unused executable capability code would
            // silently acquire authority when later referenced by a returned method.
            if (!this.functionBody(initial, current)) return false;
          } else {
            if (!this.data(initial, current)) return false;
            current.bindings.set(declaration.id.name, { kind: 'data', mutable: statement.kind === 'let' });
          }
        }
      } else if (statement.type === 'ExpressionStatement') {
        const value = statement.expression;
        if (value.type === 'AssignmentExpression') {
          if (value.operator !== '=' || value.left.type !== 'Identifier') return false;
          const target = lookup(current, value.left.name);
          if (target?.kind !== 'data' || !target.mutable || !this.data(value.right, current)) return false;
        } else if (!this.data(value, current)) return false;
      } else if (statement.type === 'ReturnStatement') {
        if (!this.data(statement.argument, current)) return false;
      } else if (statement.type === 'BlockStatement') {
        if (!this.block(statement.body, current)) return false;
      } else if (statement.type === 'IfStatement') {
        if (!this.data(statement.test, current) || !this.block([statement.consequent], current) ||
          (statement.alternate !== null && !this.block([statement.alternate], current))) return false;
      } else return false;
    }
    return true;
  }

  factory(node: Node): boolean {
    if (!callable(node) || node.params.length !== 0) return false;
    const current = scope(null);
    const body: readonly Node[] = node.body.type === 'BlockStatement' ? node.body.body : [];
    let returned = node.body.type === 'BlockStatement' ? body.at(-1)?.argument : node.body;
    while (returned?.type === 'ParenthesizedExpression') returned = returned.expression;
    if (node.body.type === 'BlockStatement' && body.at(-1)?.type !== 'ReturnStatement') return false;
    // Factory initialization is allocation only: private literal slots and lexical helpers.
    for (const statement of body.slice(0, -1)) {
      if (erasedDeclaration(statement)) continue;
      if (statement.type !== 'VariableDeclaration' || statement.declare === true || !['const', 'let'].includes(statement.kind)) return false;
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || current.bindings.has(declaration.id.name)) return false;
        const initial = declaration.init;
        if (initial === null) return false;
        if (callable(initial) && statement.kind === 'const')
          current.bindings.set(declaration.id.name, { kind: 'function', node: initial, scope: current });
        else if (literal(initial))
          current.bindings.set(declaration.id.name, { kind: 'data', mutable: statement.kind === 'let' });
        else return false;
      }
    }
    for (const binding of current.bindings.values())
      if (binding.kind === 'function' && !this.functionBody(binding.node, binding.scope)) return false;
    if (returned?.type !== 'ObjectExpression' || returned.properties.length === 0) return false;
    const names = new Set<string>();
    for (const property of returned.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.computed) return false;
      const name = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      if (typeof name !== 'string' || name === '__proto__' || names.has(name)) return false;
      names.add(name);
      const value = property.value;
      if (value.type === 'Identifier') {
        const binding = lookup(current, value.name);
        if (binding?.kind !== 'function' || !this.functionBody(binding.node, binding.scope)) return false;
      } else if (!this.functionBody(value, current)) return false;
    }
    return true;
  }
}

/** Direct, single-runtime-export modules only. Re-exports and captured module state fail closed. */
export const provesPassiveStateFactoryExport = (filename: string, exportedName: string): boolean => {
  if (/\.d\.[cm]?ts$/u.test(filename)) return false;
  try {
    const parsed = parseSync(filename, readFileSync(filename, 'utf8'));
    if (parsed.errors.length !== 0) return false;
    let target: Node | undefined;
    for (const statement of parsed.program.body) {
      const node = statement as Node;
      if (erasedDeclaration(node) || node.type === 'EmptyStatement') continue;
      if (node.type === 'ImportDeclaration' && node.importKind === 'type') continue;
      if (node.type !== 'ExportNamedDeclaration' || node.source !== null || node.declaration === null) return false;
      if (erasedDeclaration(node.declaration)) continue;
      const declaration = node.declaration;
      if (node.exportKind !== 'value' || target !== undefined || declaration.type !== 'VariableDeclaration' ||
        declaration.declare === true || declaration.kind !== 'const' ||
        declaration.declarations.length !== 1 || declaration.declarations[0].id.type !== 'Identifier' ||
        declaration.declarations[0].id.name !== exportedName) return false;
      target = declaration.declarations[0].init;
    }
    return target !== undefined && new PassiveStateProof().factory(target);
  } catch {
    return false;
  }
};
