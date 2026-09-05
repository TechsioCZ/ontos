/**
 * effect-native/no-symbol-slotted-operation-record
 *
 * Audit B4: operation capabilities stored under locally proven symbol keys.
 * Covers declaration/construction, class accessors, mapped types and built-in Record forms.
 * Module and TypeScript namespace declarations are scope-resolved; inner shadows are not slots.
 * Literal/scalar nominal markers and well-known Symbol protocols are not operation capabilities.
 * Destructuring is a read, subject to allowSameFileAccessors, not a record construction.
 * Static limitation: imported computed keys can be either unique symbols OR literal strings.
 * Without cross-file type information neither named nor namespace imports prove symbol identity;
 * these are intentionally not reported. Arbitrary value flow and defineProperty are not modeled.
 * Symbol-backed non-marker records remain a syntactic approximation of operation records.
 * Report only; no fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope } from '@oxlint/plugins';

import { isTestFile, matchesAny, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

const WORKSPACE_MARKERS: readonly string[] = ['/apps/', '/verticals/', '/packages/', '/scripts/'];

/**
 * Absolute filename → the workspace-relative path the scope globs are written against.
 *
 * The *last* workspace marker wins so real sources (`<root>/packages/core-runtime/src/x.ts`) and
 * this plugin's fixtures (`tools/.../fixtures/<rule>/invalid/packages/...`) classify identically.
 */
function workspacePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  let best = -1;
  for (const marker of WORKSPACE_MARKERS) best = Math.max(best, unified.lastIndexOf(marker));
  return best === -1 ? normalisePath(unified) : unified.slice(best + 1);
}

const DEFAULT_INCLUDE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];

/** `Symbol.iterator` and friends implement a language protocol, not a hand-rolled capability slot. */
const WELL_KNOWN_SYMBOLS = new Set([
  'asyncDispose',
  'asyncIterator',
  'dispose',
  'hasInstance',
  'isConcatSpreadable',
  'iterator',
  'match',
  'matchAll',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
  'unscopables',
]);

interface RuleOptions {
  readonly allowBrandMarkers: boolean;
  readonly allowSameFileAccessors: boolean;
  readonly ignore: readonly string[];
  readonly includePaths: readonly string[];
  readonly includeTests: boolean;
}

const DEFAULTS: RuleOptions = {
  allowBrandMarkers: true,
  allowSameFileAccessors: true,
  ignore: [],
  includePaths: DEFAULT_INCLUDE_PATHS,
  includeTests: false,
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const includePaths = stringList(given.includePaths, DEFAULTS.includePaths);
  return {
    allowBrandMarkers: boolean(given.allowBrandMarkers, DEFAULTS.allowBrandMarkers),
    allowSameFileAccessors: boolean(given.allowSameFileAccessors, DEFAULTS.allowSameFileAccessors),
    ignore: stringList(given.ignore, DEFAULTS.ignore),
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
    includeTests: boolean(given.includeTests, DEFAULTS.includeTests),
  };
}

interface Span {
  readonly end: number;
  readonly start: number;
}

function spanOf(node: AnyNode | null | undefined): Span | null {
  const span = node as unknown as { end?: number; start?: number } | null | undefined;
  if (span === null || span === undefined) return null;
  if (typeof span.start !== 'number' || typeof span.end !== 'number') return null;
  return { end: span.end, start: span.start };
}

/**
 * `true` when a scope `Definition` node is (or textually wraps) one of the collected declarators.
 *
 * Containment rather than equality keeps the check working whether the scope analyser reports the
 * `VariableDeclarator` or the enclosing `VariableDeclaration` as the definition node.
 */
function definesSpan(definitionNode: AnyNode | null, declarators: readonly Span[]): boolean {
  const span = spanOf(definitionNode);
  if (span === null) return false;
  return declarators.some(
    (declarator) => span.start <= declarator.start && span.end >= declarator.end,
  );
}

/** `(x)` / `x as const` / `x satisfies T` / `<T>x` → `x`. */
function unwrapValue(node: AnyNode): AnyNode {
  let current = node;
  for (let guard = 0; guard < 8; guard += 1) {
    if (
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSInstantiationExpression'
    ) {
      current = (current as unknown as { expression: AnyNode }).expression;
      continue;
    }
    return current;
  }
  return current;
}

function unwrapType(node: AnyNode): AnyNode {
  let current = node;
  for (let guard = 0; guard < 8 && current.type === 'TSParenthesizedType'; guard += 1) {
    current = (current as ESTree.TSParenthesizedType).typeAnnotation as AnyNode;
  }
  return current;
}

/** `Record` → `"Record"`, `A.B` → `"A.B"`. */
function dottedTypeName(node: AnyNode | null): string | null {
  if (node === null) return null;
  if (node.type === 'Identifier') return (node as { name: string }).name;
  if (node.type === 'TSQualifiedName') {
    const qualified = node as ESTree.TSQualifiedName;
    const left = dottedTypeName(qualified.left as AnyNode);
    return left === null ? null : `${left}.${qualified.right.name}`;
  }
  return null;
}

/** `const x: unique symbol` / `const x: symbol`. */
function isSymbolTypeAnnotation(annotation: AnyNode | null | undefined): boolean {
  if (annotation === null || annotation === undefined) return false;
  const inner = unwrapType(annotation);
  if (inner.type === 'TSSymbolKeyword') return true;
  if (inner.type !== 'TSTypeOperator') return false;
  const operator = inner as ESTree.TSTypeOperator;
  return (
    operator.operator === 'unique' &&
    unwrapType(operator.typeAnnotation as AnyNode).type === 'TSSymbolKeyword'
  );
}

/** `Symbol('…')` / `Symbol.for('…')` — the callee must be the *global* `Symbol`. */
function isSymbolFactoryCall(node: AnyNode | null | undefined, symbolIsGlobal: boolean): boolean {
  if (node === null || node === undefined || !symbolIsGlobal) return false;
  const call = unwrapValue(node);
  if (call.type !== 'CallExpression') return false;
  const callee = unwrapValue((call as ESTree.CallExpression).callee as AnyNode);
  if (callee.type === 'Identifier') return (callee as { name: string }).name === 'Symbol';
  if (callee.type !== 'MemberExpression') return false;
  const member = callee as unknown as { computed: boolean; object: AnyNode; property: AnyNode };
  if (
    member.computed ||
    member.object.type !== 'Identifier' ||
    member.property.type !== 'Identifier'
  )
    return false;
  return (
    (member.object as { name: string }).name === 'Symbol' &&
    (member.property as { name: string }).name === 'for'
  );
}

/** A type that carries no capability: `true`, `'tag'`, `typeof X`, `symbol`, or `X` named like the key. */
function isMarkerType(annotation: AnyNode | null | undefined, keyName: string): boolean {
  if (annotation === null || annotation === undefined) return true; // `readonly [brand];` — no capability.
  const type = unwrapType(annotation);
  if (
    [
      'TSLiteralType',
      'TSTemplateLiteralType',
      'TSBooleanKeyword',
      'TSStringKeyword',
      'TSNumberKeyword',
      'TSBigIntKeyword',
    ].includes(type.type)
  )
    return true;
  if (type.type === 'TSUnionType')
    return type.types.every((member) => isMarkerType(member, keyName));
  if (type.type === 'TSTypeQuery') return true;
  if (type.type === 'TSSymbolKeyword') return true;
  if (type.type === 'TSTypeOperator') return isSymbolTypeAnnotation(type);
  if (type.type === 'TSTypeReference') {
    // Effect's `readonly [TypeId]: TypeId` idiom — the slot re-states its own key, nothing else.
    return dottedTypeName((type as ESTree.TSTypeReference).typeName as AnyNode) === keyName;
  }
  return false;
}

/** A value that carries no capability: a literal (optionally `as const`) or the key symbol itself. */
function isMarkerValue(value: AnyNode | null | undefined, keyName: string): boolean {
  if (value === null || value === undefined) return true;
  const inner = unwrapValue(value);
  if (inner.type === 'Literal' || inner.type === 'TemplateLiteral') return true;
  return inner.type === 'Identifier' && (inner as { name: string }).name === keyName;
}

function typeOfAnnotation(holder: { typeAnnotation?: unknown } | null | undefined): AnyNode | null {
  const annotation = holder?.typeAnnotation as { typeAnnotation?: AnyNode } | null | undefined;
  return (annotation?.typeAnnotation as AnyNode | undefined) ?? null;
}

type SymbolKind = 'local' | 'import';

/** Statements that can hold the program-scope `const x: unique symbol = Symbol(…)` declarations. */
function programVariableDeclarations(
  program: ESTree.Program,
): readonly ESTree.VariableDeclaration[] {
  const declarations: ESTree.VariableDeclaration[] = [];
  const statements = [...program.body] as AnyNode[];
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index]!;
    if (statement.type === 'TSModuleDeclaration' && statement.body?.type === 'TSModuleBlock')
      statements.push(...statement.body.body);
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration)
      statements.push(statement.declaration);
    if (statement.type === 'VariableDeclaration') {
      declarations.push(statement as unknown as ESTree.VariableDeclaration);
      continue;
    }
    if (statement.type === 'ExportNamedDeclaration') {
      const inner = (statement as unknown as { declaration: AnyNode | null }).declaration;
      if (inner !== null && inner.type === 'VariableDeclaration') {
        declarations.push(inner as unknown as ESTree.VariableDeclaration);
      }
    }
  }
  return declarations;
}

/** Effect-native rule: capabilities belong on a declared service surface, not in a symbol slot. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B4: detect non-marker records keyed by locally proven symbols, including mapped/Record forms. Imported computed keys cannot be distinguished from literal strings without cross-file types. Nominal markers and well-known Symbol protocols are excluded; arbitrary value flow is not modeled.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#b4-make-context-services-and-effectfn-the-default-dependency-vocabulary',
    },
    messages: {
      symbolSlot:
        "Audit B4: '{{slot}}' stores a non-marker value/type under a locally proven symbol. Prefer explicit Context.Service capabilities or typed definition fields over symbol-slotted operation records.",
      importedSymbolSlot:
        "Audit B4: symbol-slotted operation record '{{slot}}'. Prefer explicit service capabilities or typed definition fields.",
      symbolSlotAccess:
        "Audit B4: read of local symbol slot '{{slot}}' is disallowed by allowSameFileAccessors. Prefer explicit service capabilities or typed definition fields for operations.",
      symbolIndexSignature:
        "Audit B4: '{{slot}}' has a symbol-keyed non-marker record shape. Prefer explicit service capabilities or typed definition fields for operations.",
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowBrandMarkers: {
            type: 'boolean',
            description:
              'Allow capability-free nominal markers — a slot whose type is a literal / `typeof X` / `symbol` / a type reference named like the key, or whose value is a literal or the key symbol (default: true).',
          },
          allowSameFileAccessors: {
            type: 'boolean',
            description:
              'Allow `record[localSymbol]` reads inside the module that declares the symbol (default: true — the owner legitimately opens its own private record; imported-key identity is not inferred).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs exempted from the rule (default: none — no carve-out has been ratified).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs the rule applies to (default: apps/**, verticals/**, packages/**).',
          },
          includeTests: {
            type: 'boolean',
            description: 'Also check test files (default: false).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        allowBrandMarkers: true,
        allowSameFileAccessors: true,
        ignore: [],
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        includeTests: false,
      },
    ],
  },
  create(context: Context) {
    const options = readOptions(context.options[0]);
    const path = workspacePath(context.filename);
    if (!matchesAny(path, options.includePaths)) return {};
    if (matchesAny(path, options.ignore)) return {};
    if (!options.includeTests && isTestFile(path)) return {};

    const program = context.sourceCode.ast;

    // `Symbol` must be the global one; a module-level `const Symbol = …` shadow disables the
    // initialiser heuristic (the explicit `unique symbol` annotation still counts).
    let symbolIsGlobal = true;
    for (const declaration of programVariableDeclarations(program)) {
      for (const declarator of declaration.declarations as readonly AnyNode[]) {
        const id = (declarator as unknown as { id: AnyNode }).id;
        if (id.type === 'Identifier' && (id as { name: string }).name === 'Symbol')
          symbolIsGlobal = false;
      }
    }
    for (const statement of program.body as readonly AnyNode[]) {
      if (statement.type !== 'ImportDeclaration') continue;
      for (const specifier of (statement as unknown as { specifiers: readonly AnyNode[] })
        .specifiers) {
        const local = (specifier as unknown as { local: { name: string } }).local;
        if (local.name === 'Symbol') symbolIsGlobal = false;
      }
    }

    /** Program-scope symbol bindings, by name, with the declarator spans that define them. */
    const localSymbols = new Map<string, Span[]>();
    for (const declaration of programVariableDeclarations(program)) {
      for (const raw of declaration.declarations as readonly AnyNode[]) {
        const declarator = raw as unknown as { id: AnyNode; init: AnyNode | null };
        const id = declarator.id;
        if (id.type !== 'Identifier') continue;
        const annotated = isSymbolTypeAnnotation(
          typeOfAnnotation(id as unknown as { typeAnnotation?: unknown }),
        );
        if (!annotated && !isSymbolFactoryCall(declarator.init, symbolIsGlobal)) continue;
        const span = spanOf(raw);
        if (span === null) continue;
        const name = (id as { name: string }).name;
        const spans = localSymbols.get(name) ?? [];
        spans.push(span);
        localSymbols.set(name, spans);
      }
    }

    const importedBindings = new Set<string>();
    for (const statement of program.body as readonly AnyNode[]) {
      if (statement.type !== 'ImportDeclaration') continue;
      for (const specifier of (statement as unknown as { specifiers: readonly AnyNode[] })
        .specifiers) {
        if (specifier.type !== 'ImportSpecifier' && specifier.type !== 'ImportDefaultSpecifier')
          continue;
        importedBindings.add((specifier as unknown as { local: { name: string } }).local.name);
      }
    }

    if (localSymbols.size === 0 && importedBindings.size === 0) return {};

    /**
     * Classify a computed-key / computed-property identifier.
     *
     * Scope resolution decides: a nested `const actionHandler = 'x'` shadow wins over the
     * program-scope symbol, and an import binding is reported separately. When the scope chain
     * cannot resolve the name (type positions are not always part of the reference graph) the
     * program-scope declaration is used as the answer.
     */
    const classify = (node: AnyNode, name: string): SymbolKind | null => {
      // A binding named `search`/`dispose` is not Symbol.search/Symbol.dispose.
      let scope: Scope | null = null;
      try {
        scope = context.sourceCode.getScope(node);
      } catch {
        scope = null;
      }
      while (scope !== null) {
        const variable = scope.set.get(name);
        if (variable !== undefined) {
          if (variable.defs.some((definition) => definition.type === 'ImportBinding')) {
            return null; // Imported strings and symbols are indistinguishable without cross-file types.
          }
          const spans = localSymbols.get(name);
          if (spans === undefined) return null;
          return variable.defs.some((definition) => definesSpan(definition.node as AnyNode, spans))
            ? 'local'
            : null;
        }
        scope = scope.upper;
      }
      if (localSymbols.has(name)) return 'local';
      return null; // Imported strings and symbols are indistinguishable without cross-file types.
    };

    const keyName = (key: AnyNode, computed: boolean): string | null => {
      if (!computed) return null;
      const inner = unwrapValue(key);
      return inner.type === 'Identifier' ? (inner as { name: string }).name : null;
    };

    interface Pending {
      readonly kind: SymbolKind;
      readonly messageId: string;
      readonly node: AnyNode;
      readonly slot: string;
    }

    const pending: Pending[] = [];
    /** Imported names proven to be symbol slots because this file uses them as *type* member keys. */
    const importedSlotKeys = new Set<string>();
    /** `record[importedKey]` reads, resolved once the whole program has been walked. */
    const importedAccesses: { readonly node: AnyNode; readonly slot: string }[] = [];

    const recordSlot = (
      node: AnyNode,
      name: string,
      kind: SymbolKind,
      isTypeMember: boolean,
    ): void => {
      if (kind === 'import' && isTypeMember) importedSlotKeys.add(name);
      pending.push({
        kind,
        messageId: kind === 'import' ? 'importedSymbolSlot' : 'symbolSlot',
        node,
        slot: name,
      });
    };

    const inspectKeyType = (node: any, keyType: any, valueType: any): void => {
      if (keyType?.type !== 'TSTypeQuery') return;
      const name = keyName(keyType.exprName, true);
      if (!name) return;
      const kind = classify(keyType, name);
      if (!kind || (options.allowBrandMarkers && isMarkerType(valueType, name))) return;
      recordSlot(node, name, kind, true);
    };

    return {
      TSMappedType(node: any) {
        inspectKeyType(
          node,
          node.typeParameter?.constraint ?? node.constraint,
          node.typeAnnotation,
        );
      },
      TSTypeReference(node: any) {
        if (node.typeName.type !== 'Identifier' || node.typeName.name !== 'Record') return;
        for (
          let scope: import('@oxlint/plugins').Scope | null = context.sourceCode.getScope(node);
          scope;
          scope = scope.upper
        ) {
          if (scope.set.get('Record')?.defs.length) return;
        }
        const args = node.typeArguments?.params ?? [];
        inspectKeyType(node, args[0], args[1]);
      },
      // `readonly [actionHandler]: ActionHandler<…>` in an interface or type literal.
      TSPropertySignature(node) {
        const signature = node as unknown as {
          computed: boolean;
          key: AnyNode;
          typeAnnotation?: unknown;
        };
        const name = keyName(signature.key, signature.computed);
        if (name === null) return;
        const kind = classify(node as unknown as AnyNode, name);
        if (kind === null) return;
        if (options.allowBrandMarkers && isMarkerType(typeOfAnnotation(signature), name)) return;
        recordSlot(node as unknown as AnyNode, name, kind, true);
      },

      // `[actionHandler](payload: P): Effect<…>` — a method slot is never a brand marker.
      TSMethodSignature(node) {
        const signature = node as unknown as { computed: boolean; key: AnyNode };
        const name = keyName(signature.key, signature.computed);
        if (name === null) return;
        const kind = classify(node as unknown as AnyNode, name);
        if (kind === null) return;
        recordSlot(node as unknown as AnyNode, name, kind, true);
      },

      // `{ [actionHandler]: handler, [actionRegistration]: true as const }`.
      Property(node) {
        const property = node as unknown as { computed: boolean; key: AnyNode; value: AnyNode };
        const name = keyName(property.key, property.computed);
        if (name === null) return;
        const kind = classify(node as unknown as AnyNode, name);
        if (kind === null) return;
        if ((node as any).parent?.type === 'ObjectPattern') {
          if (!options.allowSameFileAccessors)
            context.report({ node, messageId: 'symbolSlotAccess', data: { slot: name } });
          return;
        }
        if (options.allowBrandMarkers && isMarkerValue(property.value, name)) return;
        recordSlot(node as unknown as AnyNode, name, kind, false);
      },

      // `class R { [actionHandler] = handler }` / `static readonly [actionHandler]: Handler`.
      'PropertyDefinition, AccessorProperty'(node: any) {
        const property = node as unknown as {
          computed: boolean;
          key: AnyNode;
          typeAnnotation?: unknown;
          value: AnyNode | null;
        };
        const name = keyName(property.key, property.computed);
        if (name === null) return;
        const kind = classify(node as unknown as AnyNode, name);
        if (kind === null) return;
        if (options.allowBrandMarkers) {
          const annotation = typeOfAnnotation(property);
          if (
            annotation !== null
              ? isMarkerType(annotation, name)
              : isMarkerValue(property.value, name)
          )
            return;
        }
        recordSlot(node as unknown as AnyNode, name, kind, false);
      },

      // `class R { [actionHandler]() { … } }`.
      MethodDefinition(node) {
        const method = node as unknown as { computed: boolean; key: AnyNode };
        const name = keyName(method.key, method.computed);
        if (name === null) return;
        const kind = classify(node as unknown as AnyNode, name);
        if (kind === null) return;
        recordSlot(node as unknown as AnyNode, name, kind, false);
      },

      // `{ readonly [key: symbol]: OperationHandler }`.
      TSIndexSignature(node) {
        const parameter = (node.parameters as readonly AnyNode[])[0];
        if (parameter === undefined) return;
        const keyType = typeOfAnnotation(parameter as unknown as { typeAnnotation?: unknown });
        if (keyType === null || unwrapType(keyType).type !== 'TSSymbolKeyword') return;
        const valueType = typeOfAnnotation(node as unknown as { typeAnnotation?: unknown });
        const parameterName = (parameter as unknown as { name?: string }).name ?? 'key';
        if (options.allowBrandMarkers && isMarkerType(valueType, parameterName)) return;
        context.report({
          node: node as unknown as AnyNode,
          messageId: 'symbolIndexSignature',
          data: { slot: `[${parameterName}: symbol]` },
        });
      },

      // `registration[actionHandler]` — the accessor a symbol slot forces on consumers.
      MemberExpression(node) {
        const member = node as unknown as { computed: boolean; property: AnyNode };
        if (!member.computed) return;
        const inner = unwrapValue(member.property);
        if (inner.type !== 'Identifier') return;
        const name = (inner as { name: string }).name;
        const kind = classify(node as unknown as AnyNode, name);
        if (kind === null) return;
        if (kind === 'import') {
          importedAccesses.push({ node: node as unknown as AnyNode, slot: name });
          return;
        }
        if (options.allowSameFileAccessors) return;
        context.report({
          node: node as unknown as AnyNode,
          messageId: 'symbolSlotAccess',
          data: { slot: name },
        });
      },

      'Program:exit'() {
        for (const entry of pending) {
          // A value-position imported key only counts once this file proves it is the symbol
          // slot by also using it as a type-member key.
          if (
            entry.kind === 'import' &&
            entry.messageId === 'importedSymbolSlot' &&
            !importedSlotKeys.has(entry.slot)
          ) {
            continue;
          }
          context.report({
            node: entry.node,
            messageId: entry.messageId,
            data: { slot: entry.slot },
          });
        }
        for (const access of importedAccesses) {
          if (!importedSlotKeys.has(access.slot)) continue;
          context.report({
            node: access.node,
            messageId: 'symbolSlotAccess',
            data: { slot: access.slot },
          });
        }
      },
    };
  },
});
