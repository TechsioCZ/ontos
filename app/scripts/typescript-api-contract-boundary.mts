import path from 'node:path';

import type { CallExpression, Expression, MemberExpression, VariableDeclarator } from 'oxc-parser';
import {
  ExportExportNameKind,
  ExportImportNameKind,
  ImportNameKind,
  parseSync,
  Visitor,
} from 'oxc-parser';
import { Result, Schema } from 'effect';

/* oxlint-disable no-nested-ternary, no-use-before-define, prefer-destructuring, prefer-template, anti-slop/require-safety-comment-for-type-assertion, perfectionist/sort-interfaces, perfectionist/sort-objects, sonarjs/function-name, sonarjs/no-collapsible-if, sonarjs/no-duplicate-string, sonarjs/too-many-break-or-continue-in-loop, typescript/no-unsafe-type-assertion, unicorn/no-array-reverse, unicorn/no-array-sort, unicorn/no-lonely-if, unicorn/no-nested-ternary -- Oxc requires syntax-node callback keys, narrowed generated-node bridges, mutually recursive graph resolvers, and a single indexed resolver model; remove-when: Oxc exposes a typed scope/module graph or these resolvers move behind dedicated typed modules; expires: 2026-12-31. */

export interface ApiContractSourceContext {
  readonly file: string;
  readonly sources: ReadonlyMap<string, string>;
}

interface Span {
  readonly end: number;
  readonly start: number;
}

interface ImportBinding {
  readonly imported: string;
  readonly kind: 'default' | 'named' | 'namespace';
  readonly specifier: string;
}

type ExportBinding =
  | { readonly kind: 'expression'; readonly span: Span }
  | { readonly kind: 'local'; readonly local: string }
  | { readonly imported: string; readonly kind: 'reexport'; readonly specifier: string }
  | { readonly kind: 'namespace'; readonly specifier: string }
  | { readonly kind: 'star'; readonly specifier: string };

interface DestructuredBinding {
  readonly member: string;
  readonly source: Expression;
}

type ScopedBinding = { readonly at?: number; readonly scope: Span } & (
  | ({ readonly kind: 'destructured' } & DestructuredBinding)
  | { readonly expression: Expression; readonly kind: 'expression' }
  | { readonly body: Span; readonly kind: 'function' }
  | { readonly kind: 'namespace-rest'; readonly source: Expression }
  | { readonly kind: 'shadow' }
);

interface SourceModel {
  readonly bindings: ReadonlyMap<string, readonly ScopedBinding[]>;
  readonly calls: readonly CallExpression[];
  readonly declarations: ReadonlyMap<string, Expression>;
  readonly destructured: ReadonlyMap<string, DestructuredBinding>;
  readonly exports: ReadonlyMap<string, readonly ExportBinding[]>;
  readonly identifiers: readonly (Span & { readonly name: string })[];
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly members: readonly MemberExpression[];
  readonly memberAssignments: readonly {
    readonly at: number;
    readonly expression: Expression;
    readonly path: readonly string[];
    readonly scope: Span;
  }[];
  readonly moduleScope: Span;
  readonly returns: readonly {
    readonly expression: Expression;
    readonly scope: Span;
  }[];
  readonly starExports: readonly ExportBinding[];
}

const forbiddenSchemaMembers = new Set(['Any', 'Json', 'Unknown', 'UnknownFromJsonString']);
const problemDetailsFactoryNames = new Set([
  'makeProblemDetailsSchema',
  'makeRetryableProblemDetailsSchema',
]);
const endpointMethods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
const schemaProviderSpecifiers = new Set([
  '@modern-js/plugin-bff/effect-client',
  'effect',
  'effect/Schema',
]);
const endpointProviderSpecifiers = new Set([
  '@modern-js/plugin-bff/effect-client',
  '@modern-js/plugin-bff/effect-edge',
  'effect/unstable/httpapi',
  'effect/unstable/httpapi/HttpApiEndpoint',
]);
const externalModulePrefix = 'external:';
const isKnownProviderSpecifier = (specifier: string): boolean =>
  schemaProviderSpecifiers.has(specifier) ||
  endpointProviderSpecifiers.has(specifier) ||
  specifier === '@app/shared-contracts' ||
  specifier.startsWith('@app/shared-contracts/');

type PackageExportValue =
  | null
  | string
  | readonly PackageExportValue[]
  | { readonly [key: string]: PackageExportValue };
const PackageExportValueSchema: Schema.Codec<PackageExportValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.String,
    Schema.Array(PackageExportValueSchema),
    Schema.Record(Schema.String, PackageExportValueSchema),
  ]),
);
const PackageJsonExportsSchema = Schema.fromJsonString(
  Schema.Struct({ exports: PackageExportValueSchema }),
);
const isPackageExportString = Schema.is(Schema.String);
const isPackageExportArray = Schema.is(Schema.Array(PackageExportValueSchema));
const isPackageExportRecord = Schema.is(Schema.Record(Schema.String, PackageExportValueSchema));

const exportTargets = (value: PackageExportValue): readonly string[] => {
  if (isPackageExportString(value)) {
    return [value];
  }
  if (isPackageExportArray(value)) {
    return value.flatMap(exportTargets);
  }
  return isPackageExportRecord(value) ? Object.values(value).flatMap(exportTargets) : [];
};

interface PackageExportResolution {
  readonly governed: boolean;
  readonly targets: readonly string[];
}

const packageExportResolution = (
  packageJson: string,
  exportKey: string,
): PackageExportResolution => {
  const parsed = Schema.decodeUnknownResult(PackageJsonExportsSchema)(packageJson);
  if (Result.isFailure(parsed)) {
    return { governed: false, targets: [] };
  }
  const exportsField = parsed.success.exports;
  if (
    exportsField === null ||
    isPackageExportString(exportsField) ||
    isPackageExportArray(exportsField)
  ) {
    return { governed: true, targets: exportKey === '.' ? exportTargets(exportsField) : [] };
  }
  if (!isPackageExportRecord(exportsField)) {
    return { governed: true, targets: [] };
  }
  if (exportKey === '.' && !Object.keys(exportsField).some((key) => key.startsWith('.'))) {
    return { governed: true, targets: exportTargets(exportsField) };
  }
  if (Object.hasOwn(exportsField, exportKey)) {
    return { governed: true, targets: exportTargets(exportsField[exportKey] ?? null) };
  }
  const wildcardMatches = Object.entries(exportsField).flatMap(([key, value]) => {
    const wildcard = key.indexOf('*');
    if (wildcard === -1) {
      return [];
    }
    const prefix = key.slice(0, wildcard);
    const suffix = key.slice(wildcard + 1);
    if (!exportKey.startsWith(prefix) || !exportKey.endsWith(suffix)) {
      return [];
    }
    const substitution = exportKey.slice(prefix.length, exportKey.length - suffix.length);
    return [
      { key, targets: exportTargets(value).map((target) => target.replaceAll('*', substitution)) },
    ];
  });
  if (wildcardMatches.length === 0) {
    return { governed: true, targets: [] };
  }
  const mostSpecific = [...wildcardMatches].sort((left, right) => {
    const leftPrefixLength = left.key.indexOf('*');
    const rightPrefixLength = right.key.indexOf('*');
    return rightPrefixLength - leftPrefixLength || right.key.length - left.key.length;
  })[0];
  return { governed: true, targets: mostSpecific?.targets ?? [] };
};

const resolveSources = (
  context: ApiContractSourceContext,
  importingFile: string,
  specifier: string,
): readonly string[] => {
  const appPackage = /^@app\/(?<packageName>[^/]+)(?:\/(?<subpath>.+))?$/u.exec(specifier);
  const packageName = appPackage?.groups?.packageName;
  if (!specifier.startsWith('.') && packageName === undefined) {
    return [];
  }
  const packageRoots = ['packages', 'apps', 'verticals'].map((root) => `${root}/${packageName}`);
  const subpath = appPackage?.groups?.subpath;
  const packageRootsWithManifest = packageRoots.filter((packageRoot) =>
    context.sources.has(`${packageRoot}/package.json`),
  );
  const bases = specifier.startsWith('.')
    ? [path.posix.normalize(path.posix.join(path.posix.dirname(importingFile), specifier))]
    : (packageRootsWithManifest.length === 0 ? packageRoots : packageRootsWithManifest).flatMap(
        (packageRoot) => {
          const packageJson = context.sources.get(`${packageRoot}/package.json`);
          if (packageJson !== undefined) {
            const exportKey = subpath === undefined ? '.' : `./${subpath}`;
            const resolution = packageExportResolution(packageJson, exportKey);
            if (resolution.governed) {
              return resolution.targets.map((target) =>
                path.posix.normalize(path.posix.join(packageRoot, target)),
              );
            }
          }
          return subpath === undefined
            ? [`${packageRoot}/src/index`, `${packageRoot}/index`]
            : [`${packageRoot}/src/${subpath}`, `${packageRoot}/${subpath}`];
        },
      );
  return [
    ...new Set(
      bases.flatMap((base) => {
        const sourceSubstitutions = base.endsWith('.js')
          ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx']
          : base.endsWith('.mjs')
            ? [base.slice(0, -4) + '.mts']
            : base.endsWith('.cjs')
              ? [base.slice(0, -4) + '.cts']
              : [];
        const candidate = [
          base,
          ...sourceSubstitutions,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.mts`,
          `${base}.cts`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
          `${base}/index.mts`,
        ].find((possible) => context.sources.has(possible));
        return candidate === undefined ? [] : [candidate];
      }),
    ),
  ];
};

const moduleSpecifierTargets = (
  context: ApiContractSourceContext,
  importingFile: string,
  specifier: string,
): readonly string[] => {
  const resolved = resolveSources(context, importingFile, specifier);
  return resolved.length > 0
    ? resolved
    : isKnownProviderSpecifier(specifier)
      ? [`${externalModulePrefix}${specifier}`]
      : [];
};

const externalSpecifier = (file: string): string | undefined =>
  file.startsWith(externalModulePrefix) ? file.slice(externalModulePrefix.length) : undefined;

const addExport = (
  exports: Map<string, ExportBinding[]>,
  exportedName: string,
  binding: ExportBinding,
): void => {
  const existing = exports.get(exportedName) ?? [];
  existing.push(binding);
  exports.set(exportedName, existing);
};

const sourceModels = new WeakMap<ReadonlyMap<string, string>, Map<string, SourceModel>>();

// eslint-disable-next-line complexity -- This is the single TypeScript-AST indexing pass for imports, exports, calls, declarations, and references.
const parseSourceModel = (file: string, content: string): SourceModel => {
  const parsed = parseSync(file, content, {
    astType: 'ts',
    lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
    sourceType: 'module',
  });
  const calls: CallExpression[] = [];
  const bindings = new Map<string, ScopedBinding[]>();
  const declarations = new Map<string, Expression>();
  const destructured = new Map<string, DestructuredBinding>();
  const identifiers: (Span & { readonly name: string })[] = [];
  const members: MemberExpression[] = [];
  const memberAssignments: {
    readonly at: number;
    readonly expression: Expression;
    readonly path: readonly string[];
    readonly scope: Span;
  }[] = [];
  const returns: { readonly expression: Expression; readonly scope: Span }[] = [];
  const scopes: Span[] = [parsed.program];
  const functionScopes: Span[] = [];
  const varDeclarators = new Set<number>();
  new Visitor({
    ArrowFunctionExpression: (node) => {
      functionScopes.push(node.body.type === 'BlockStatement' ? node.body : node);
    },
    BlockStatement: (node) => {
      scopes.push(node);
    },
    CatchClause: (node) => {
      scopes.push(node);
    },
    ClassBody: (node) => {
      scopes.push(node);
    },
    ForInStatement: (node) => {
      scopes.push(node);
    },
    ForOfStatement: (node) => {
      scopes.push(node);
    },
    ForStatement: (node) => {
      scopes.push(node);
    },
    FunctionDeclaration: (node) => {
      functionScopes.push(node.body ?? node);
    },
    FunctionExpression: (node) => {
      functionScopes.push(node.body ?? node);
    },
    StaticBlock: (node) => {
      scopes.push(node);
    },
    SwitchStatement: (node) => {
      scopes.push(node);
    },
    VariableDeclaration: (node) => {
      if (node.kind === 'var') {
        for (const declaration of node.declarations) {
          varDeclarators.add(declaration.start);
        }
      }
    },
  }).visit(parsed.program);

  const enclosingScope = (span: Span): Span =>
    scopes
      .filter((scope) => within(span, scope))
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0] ??
    parsed.program;
  const enclosingFunctionScope = (span: Span): Span =>
    functionScopes
      .filter((scope) => within(span, scope))
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0] ??
    parsed.program;
  const addBinding = (name: string, binding: ScopedBinding): void => {
    const existing = bindings.get(name) ?? [];
    existing.push(binding);
    bindings.set(name, existing);
  };
  const addShadowPattern = (pattern: { readonly type: string } & Span, scope: Span): void => {
    if (pattern.type === 'Identifier') {
      const named = pattern as typeof pattern & { readonly name: string };
      addBinding(named.name, { kind: 'shadow', scope });
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      const assigned = pattern as typeof pattern & {
        readonly left: { readonly type: string } & Span;
      };
      addShadowPattern(assigned.left, scope);
      return;
    }
    if (pattern.type === 'RestElement') {
      const rest = pattern as typeof pattern & {
        readonly argument: { readonly type: string } & Span;
      };
      addShadowPattern(rest.argument, scope);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      const object = pattern as typeof pattern & {
        readonly properties: readonly ({ readonly type: string } & Span)[];
      };
      for (const property of object.properties) {
        if (property.type === 'Property') {
          const value = property as typeof property & {
            readonly value: { readonly type: string } & Span;
          };
          addShadowPattern(value.value, scope);
        } else if (property.type === 'RestElement') {
          const rest = property as typeof property & {
            readonly argument: { readonly type: string } & Span;
          };
          addShadowPattern(rest.argument, scope);
        }
      }
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      const array = pattern as typeof pattern & {
        readonly elements: readonly (({ readonly type: string } & Span) | null)[];
      };
      for (const element of array.elements) {
        if (element !== null) {
          addShadowPattern(element, scope);
        }
      }
    }
  };

  new Visitor({
    ArrowFunctionExpression: (node) => {
      const scope = node.body.type === 'BlockStatement' ? node.body : node;
      for (const parameter of node.params) {
        addShadowPattern(parameter, scope);
      }
    },
    AssignmentExpression: (node) => {
      if (node.operator === '=' && node.left.type === 'Identifier') {
        const owner = scopedBindingAt({ bindings }, node.left.name, node.start);
        addBinding(node.left.name, {
          at: node.start,
          expression: node.right,
          kind: 'expression',
          scope: owner?.scope ?? enclosingScope(node),
        });
      } else if (node.operator === '=' && node.left.type === 'MemberExpression') {
        const assignmentPath = memberPath(node.left);
        const root = assignmentPath?.[0];
        if (assignmentPath !== undefined && root !== undefined) {
          const owner = scopedBindingAt({ bindings }, root, node.start);
          memberAssignments.push({
            at: node.start,
            expression: node.right,
            path: assignmentPath,
            scope: owner?.scope ?? enclosingScope(node),
          });
        }
      }
    },
    CallExpression: (node) => {
      calls.push(node);
    },
    CatchClause: (node) => {
      if (node.param !== null) {
        addShadowPattern(node.param, node.body);
      }
    },
    ClassDeclaration: (node) => {
      if (node.id !== null) {
        addBinding(node.id.name, { kind: 'shadow', scope: enclosingScope(node) });
      }
    },
    FunctionDeclaration: (node) => {
      if (node.id !== null) {
        addBinding(node.id.name, {
          body: node.body ?? node,
          kind: 'function',
          scope: enclosingScope(node),
        });
      }
      const scope = node.body ?? node;
      for (const parameter of node.params) {
        addShadowPattern(parameter, scope);
      }
    },
    FunctionExpression: (node) => {
      const scope = node.body ?? node;
      if (node.id !== null) {
        addBinding(node.id.name, { kind: 'shadow', scope });
      }
      for (const parameter of node.params) {
        addShadowPattern(parameter, scope);
      }
    },
    Identifier: (node) => {
      identifiers.push({ end: node.end, name: node.name, start: node.start });
    },
    MemberExpression: (node) => {
      members.push(node);
    },
    ReturnStatement: (node) => {
      if (node.argument !== null) {
        returns.push({ expression: node.argument, scope: enclosingFunctionScope(node) });
      }
    },
    TSEnumDeclaration: (node) => {
      addBinding(node.id.name, { kind: 'shadow', scope: enclosingScope(node) });
    },
    TSModuleDeclaration: (node) => {
      if (node.id.type === 'Identifier') {
        addBinding(node.id.name, { kind: 'shadow', scope: enclosingScope(node) });
      }
    },
    VariableDeclarator: (node: VariableDeclarator) => {
      const scope = varDeclarators.has(node.start)
        ? enclosingFunctionScope(node)
        : enclosingScope(node);
      if (node.id.type === 'Identifier') {
        if (node.init === null) {
          addBinding(node.id.name, { kind: 'shadow', scope });
        } else {
          addBinding(node.id.name, { expression: node.init, kind: 'expression', scope });
          if (scope === parsed.program) {
            declarations.set(node.id.name, node.init);
          }
        }
      } else if (node.id.type === 'ObjectPattern' && node.init !== null) {
        for (const property of node.id.properties) {
          const propertyName =
            property.type === 'Property' && property.key.type === 'Identifier'
              ? property.key.name
              : property.type === 'Property' && property.key.type !== 'PrivateIdentifier'
                ? staticString(property.key)
                : undefined;
          if (
            property.type === 'Property' &&
            propertyName !== undefined &&
            property.value.type === 'Identifier'
          ) {
            const binding = {
              member: propertyName,
              source: node.init,
            };
            addBinding(property.value.name, { ...binding, kind: 'destructured', scope });
            if (scope === parsed.program) {
              destructured.set(property.value.name, binding);
            }
          } else if (property.type === 'RestElement' && property.argument.type === 'Identifier') {
            addBinding(property.argument.name, {
              kind: 'namespace-rest',
              scope,
              source: node.init,
            });
          } else if (property.type === 'Property') {
            addShadowPattern(property.value, scope);
          } else {
            addShadowPattern(property.argument, scope);
          }
        }
      } else {
        addShadowPattern(node.id, scope);
      }
    },
  }).visit(parsed.program);

  const imports = new Map<string, ImportBinding>();
  for (const declaration of parsed.module.staticImports) {
    for (const entry of declaration.entries) {
      const local = entry.localName.value;
      let kind: ImportBinding['kind'] = 'named';
      if (entry.importName.kind === ImportNameKind.NamespaceObject) {
        kind = 'namespace';
      } else if (entry.importName.kind === ImportNameKind.Default) {
        kind = 'default';
      }
      imports.set(local, {
        imported: entry.importName.name ?? (kind === 'default' ? 'default' : '*'),
        kind,
        specifier: declaration.moduleRequest.value,
      });
    }
  }

  const exports = new Map<string, ExportBinding[]>();
  const starExports: ExportBinding[] = [];
  for (const declaration of parsed.module.staticExports) {
    for (const entry of declaration.entries) {
      const exportedName =
        entry.exportName.kind === ExportExportNameKind.Default
          ? 'default'
          : (entry.exportName.name ?? undefined);
      const specifier = entry.moduleRequest?.value;
      if (entry.importName.kind === ExportImportNameKind.AllButDefault && specifier !== undefined) {
        starExports.push({ kind: 'star', specifier });
      } else if (
        exportedName !== undefined &&
        entry.importName.kind === ExportImportNameKind.All &&
        specifier !== undefined
      ) {
        addExport(exports, exportedName, { kind: 'namespace', specifier });
      } else if (exportedName !== undefined && specifier !== undefined) {
        addExport(exports, exportedName, {
          imported: entry.importName.name ?? exportedName,
          kind: 'reexport',
          specifier,
        });
      } else if (exportedName !== undefined && entry.localName.name !== null) {
        addExport(exports, exportedName, { kind: 'local', local: entry.localName.name });
      } else if (exportedName !== undefined) {
        addExport(exports, exportedName, {
          kind: 'expression',
          span: { end: entry.end, start: entry.start },
        });
      }
    }
  }
  return {
    bindings,
    calls,
    declarations,
    destructured,
    exports,
    identifiers,
    imports,
    members,
    memberAssignments,
    moduleScope: parsed.program,
    returns,
    starExports,
  };
};

const sourceModel = (context: ApiContractSourceContext, file: string): SourceModel | undefined => {
  const content = context.sources.get(file);
  if (content === undefined) {
    return undefined;
  }
  let models = sourceModels.get(context.sources);
  if (models === undefined) {
    models = new Map();
    sourceModels.set(context.sources, models);
  }
  const cached = models.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseSourceModel(file, content);
  models.set(file, parsed);
  return parsed;
};

const scopedBindingsAt = (
  model: Pick<SourceModel, 'bindings'>,
  name: string,
  position: number,
): readonly ScopedBinding[] => {
  const candidates =
    model.bindings
      .get(name)
      ?.filter(
        ({ at, scope }) =>
          position >= scope.start && position <= scope.end && (at === undefined || at <= position),
      )
      .sort(
        (left, right) =>
          left.scope.end - left.scope.start - (right.scope.end - right.scope.start) ||
          (right.at ?? right.scope.start) - (left.at ?? left.scope.start),
      ) ?? [];
  const nearest = candidates[0]?.scope;
  return nearest === undefined
    ? []
    : candidates.filter(({ scope }) => scope.start === nearest.start && scope.end === nearest.end);
};

const scopedBindingAt = (
  model: Pick<SourceModel, 'bindings'>,
  name: string,
  position: number,
): ScopedBinding | undefined => scopedBindingsAt(model, name, position)[0];

const unwrapExpression = (expression: Expression): Expression => {
  if (
    expression.type === 'ChainExpression' ||
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSInstantiationExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSTypeAssertion'
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
};

const staticString = (expression: Expression): string | undefined => {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'Literal' && Schema.is(Schema.String)(unwrapped.value)) {
    return unwrapped.value;
  }
  if (unwrapped.type === 'BinaryExpression' && unwrapped.operator === '+') {
    const left = staticString(unwrapped.left);
    const right = staticString(unwrapped.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (unwrapped.type === 'TemplateLiteral' && unwrapped.expressions.length === 0) {
    return unwrapped.quasis[0]?.value.cooked ?? unwrapped.quasis[0]?.value.raw;
  }
  return undefined;
};

const memberPath = (expression: Expression): readonly string[] | undefined => {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'Identifier') {
    return [unwrapped.name];
  }
  if (unwrapped.type !== 'MemberExpression') {
    return undefined;
  }
  const object = memberPath(unwrapped.object);
  if (object === undefined) {
    return undefined;
  }
  if (!unwrapped.computed && unwrapped.property.type === 'Identifier') {
    return [...object, unwrapped.property.name];
  }
  if (unwrapped.computed) {
    const property = staticString(unwrapped.property);
    return property === undefined ? undefined : [...object, property];
  }
  return undefined;
};

const objectPathExpression = (
  expression: Expression,
  pathParts: readonly string[],
): Expression | undefined => {
  const unwrapped = unwrapExpression(expression);
  const [member, ...rest] = pathParts;
  if (member === undefined || unwrapped.type !== 'ObjectExpression') {
    return undefined;
  }
  for (const property of [...unwrapped.properties].reverse()) {
    if (property.type !== 'Property' || property.key.type === 'PrivateIdentifier') {
      continue;
    }
    const propertyName =
      !property.computed && property.key.type === 'Identifier'
        ? property.key.name
        : staticString(property.key);
    if (propertyName !== member) {
      continue;
    }
    return rest.length === 0 ? property.value : objectPathExpression(property.value, rest);
  }
  return undefined;
};

const staticStringAt = (
  context: ApiContractSourceContext,
  file: string,
  expression: Expression,
  position: number,
  visited: Set<string>,
): string | undefined => {
  const direct = staticString(expression);
  if (direct !== undefined) {
    return direct;
  }
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'Identifier') {
    const key = `${file}:${unwrapped.name}:${position}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const model = sourceModel(context, file);
    const values =
      model === undefined
        ? []
        : scopedBindingsAt(model, unwrapped.name, position).flatMap((binding) =>
            binding.kind === 'expression'
              ? [
                  staticStringAt(
                    context,
                    file,
                    binding.expression,
                    binding.expression.start,
                    visited,
                  ),
                ]
              : [],
          );
    return values.find((value) => value !== undefined);
  }
  if (unwrapped.type === 'BinaryExpression' && unwrapped.operator === '+') {
    const left = staticStringAt(context, file, unwrapped.left, position, visited);
    const right = staticStringAt(context, file, unwrapped.right, position, visited);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

const memberPathAt = (
  context: ApiContractSourceContext,
  file: string,
  expression: Expression,
  position: number,
): readonly string[] | undefined => {
  const direct = memberPath(expression);
  if (direct !== undefined) {
    return direct;
  }
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type !== 'MemberExpression' || !unwrapped.computed) {
    return undefined;
  }
  const object = memberPathAt(context, file, unwrapped.object, position);
  const property = staticStringAt(context, file, unwrapped.property, position, new Set());
  return object === undefined || property === undefined ? undefined : [...object, property];
};

const memberNameAt = (
  context: ApiContractSourceContext,
  file: string,
  member: MemberExpression,
): string | undefined =>
  !member.computed && member.property.type === 'Identifier'
    ? member.property.name
    : member.computed
      ? staticStringAt(context, file, member.property, member.start, new Set())
      : undefined;

const within = (inner: Span, outer: Span): boolean =>
  inner.start >= outer.start && inner.end <= outer.end;

const isForbiddenMember = (member: string, forbidRecord: boolean): boolean =>
  forbiddenSchemaMembers.has(member) || (forbidRecord && member === 'Record');

// eslint-disable-next-line complexity -- Namespace provenance intentionally handles lexical aliases, destructuring, imports, and local shadows together.
const schemaNamespacePath = (
  context: ApiContractSourceContext,
  file: string,
  pathParts: readonly string[],
  position: number,
  visited: Set<string>,
): boolean => {
  const [root, ...rest] = pathParts;
  if (root === undefined) {
    return false;
  }
  const key = `schema:${file}:${position}:${pathParts.join('.')}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  if (model === undefined) {
    return false;
  }
  const scoped = scopedBindingAt(model, root, position);
  if (scoped?.kind === 'expression') {
    const declarationPath = memberPath(scoped.expression);
    if (declarationPath !== undefined) {
      return schemaNamespacePath(
        context,
        file,
        [...declarationPath, ...rest],
        scoped.expression.start,
        visited,
      );
    }
    const unwrapped = unwrapExpression(scoped.expression);
    return (
      rest.length === 0 &&
      unwrapped.type === 'ObjectExpression' &&
      unwrapped.properties.some(
        (property) =>
          property.type === 'SpreadElement' &&
          memberPath(property.argument) !== undefined &&
          schemaNamespacePath(
            context,
            file,
            memberPath(property.argument) ?? [],
            property.argument.start,
            visited,
          ),
      )
    );
  }
  if (scoped?.kind === 'destructured') {
    const sourcePath = memberPath(scoped.source);
    return (
      sourcePath !== undefined &&
      schemaNamespacePath(
        context,
        file,
        [...sourcePath, scoped.member, ...rest],
        scoped.source.start,
        visited,
      )
    );
  }
  if (scoped?.kind === 'namespace-rest') {
    const sourcePath = memberPath(scoped.source);
    return (
      sourcePath !== undefined &&
      schemaNamespacePath(context, file, [...sourcePath, ...rest], scoped.source.start, visited)
    );
  }
  if (scoped?.kind === 'shadow') {
    return false;
  }
  const binding = model.imports.get(root);
  if (binding === undefined) {
    return root === 'Schema' && rest.length === 0;
  }
  if (!schemaProviderSpecifiers.has(binding.specifier)) {
    return false;
  }
  if (binding.kind === 'named' && binding.imported === 'Schema') {
    return rest.length === 0;
  }
  if (binding.kind === 'namespace' && binding.specifier === 'effect/Schema') {
    return rest.length === 0;
  }
  return binding.kind === 'namespace' && rest.length === 1 && rest[0] === 'Schema';
};

const moduleExportsName = (
  context: ApiContractSourceContext,
  file: string,
  exportedName: string,
  visited: Set<string>,
): boolean => {
  if (externalSpecifier(file) !== undefined) {
    return true;
  }
  const key = `${file}:${exportedName}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  if (model?.exports.has(exportedName) === true) {
    return true;
  }
  return (
    model?.starExports.some(
      (binding) =>
        binding.kind === 'star' &&
        moduleSpecifierTargets(context, file, binding.specifier).some((target) =>
          moduleExportsName(context, target, exportedName, new Set(visited)),
        ),
    ) === true
  );
};

const exportOrigins = (
  context: ApiContractSourceContext,
  file: string,
  exportedName: string,
  visited: Set<string>,
): ReadonlySet<string> => {
  const provider = externalSpecifier(file);
  if (provider !== undefined) {
    return new Set([`external:${provider}:${exportedName}`]);
  }
  const key = `${file}:${exportedName}`;
  if (visited.has(key)) {
    return new Set();
  }
  visited.add(key);
  const model = sourceModel(context, file);
  const explicit = model?.exports.get(exportedName) ?? [];
  if (explicit.length > 0) {
    const origins = explicit.flatMap((binding) => {
      if (binding.kind === 'reexport') {
        const targets = moduleSpecifierTargets(context, file, binding.specifier);
        return targets.length === 0
          ? [`external:${binding.specifier}:${binding.imported}`]
          : targets.flatMap((target) => [
              ...exportOrigins(context, target, binding.imported, new Set(visited)),
            ]);
      }
      if (binding.kind === 'namespace') {
        return [`namespace:${file}:${exportedName}:${binding.specifier}`];
      }
      if (binding.kind === 'local') {
        const imported = model?.imports.get(binding.local);
        if (imported !== undefined && imported.kind !== 'namespace') {
          const targets = moduleSpecifierTargets(context, file, imported.specifier);
          return targets.length === 0
            ? [`external:${imported.specifier}:${imported.imported}`]
            : targets.flatMap((target) => [
                ...exportOrigins(context, target, imported.imported, new Set(visited)),
              ]);
        }
      }
      return [`local:${file}:${binding.kind === 'local' ? binding.local : exportedName}`];
    });
    return new Set(origins);
  }
  return new Set(
    (model?.starExports ?? []).flatMap((binding) =>
      binding.kind === 'star'
        ? moduleSpecifierTargets(context, file, binding.specifier).flatMap((target) => [
            ...exportOrigins(context, target, exportedName, new Set(visited)),
          ])
        : [],
    ),
  );
};

const unambiguousStarTargets = (
  context: ApiContractSourceContext,
  file: string,
  exportedName: string,
): readonly string[] => {
  const model = sourceModel(context, file);
  if (model?.exports.has(exportedName) === true) {
    return [];
  }
  const matchingBindings = (model?.starExports ?? []).flatMap((binding) => {
    if (binding.kind !== 'star') {
      return [];
    }
    const targets = moduleSpecifierTargets(context, file, binding.specifier).filter((target) =>
      moduleExportsName(context, target, exportedName, new Set()),
    );
    return targets.length === 0 ? [] : [targets];
  });
  if (matchingBindings.length === 1) {
    return matchingBindings[0] ?? [];
  }
  const origins = new Set(
    matchingBindings.flatMap((targets) =>
      targets.flatMap((target) => [...exportOrigins(context, target, exportedName, new Set())]),
    ),
  );
  return origins.size === 1 ? matchingBindings.flat() : [];
};

// eslint-disable-next-line func-style -- Namespace exports recurse through local aliases and module barrels.
function exportedNamespaceTargets(
  context: ApiContractSourceContext,
  file: string,
  exportedName: string,
  visited: Set<string>,
): readonly string[] {
  const key = `namespace-export:${file}:${exportedName}`;
  if (visited.has(key)) {
    return [];
  }
  visited.add(key);
  const model = sourceModel(context, file);
  const targets: string[] = [];
  for (const binding of model?.exports.get(exportedName) ?? []) {
    if (binding.kind === 'namespace') {
      targets.push(...moduleSpecifierTargets(context, file, binding.specifier));
    } else if (binding.kind === 'reexport') {
      for (const target of moduleSpecifierTargets(context, file, binding.specifier)) {
        targets.push(...exportedNamespaceTargets(context, target, binding.imported, visited));
      }
    } else if (binding.kind === 'local') {
      targets.push(
        ...localNamespaceTargets(
          context,
          file,
          binding.local,
          model?.moduleScope.start ?? 0,
          visited,
        ),
      );
    }
  }
  for (const target of unambiguousStarTargets(context, file, exportedName)) {
    targets.push(...exportedNamespaceTargets(context, target, exportedName, visited));
  }
  return [...new Set(targets)];
}

// eslint-disable-next-line func-style -- Local namespace bindings can be imports, destructuring, or expression aliases.
function localNamespaceTargets(
  context: ApiContractSourceContext,
  file: string,
  name: string,
  position: number,
  visited: Set<string>,
): readonly string[] {
  const key = `namespace-local:${file}:${name}:${position}`;
  if (visited.has(key)) {
    return [];
  }
  visited.add(key);
  const model = sourceModel(context, file);
  if (model === undefined) {
    return [];
  }
  const scoped = scopedBindingAt(model, name, position);
  if (scoped?.kind === 'expression') {
    const pathParts = memberPath(scoped.expression);
    return pathParts === undefined
      ? []
      : namespacePathTargets(context, file, pathParts, scoped.expression.start, visited);
  }
  if (scoped?.kind === 'destructured') {
    const pathParts = memberPath(scoped.source);
    return pathParts === undefined
      ? []
      : namespacePathTargets(
          context,
          file,
          [...pathParts, scoped.member],
          scoped.source.start,
          visited,
        );
  }
  if (scoped?.kind === 'namespace-rest') {
    const pathParts = memberPath(scoped.source);
    return pathParts === undefined
      ? []
      : namespacePathTargets(context, file, pathParts, scoped.source.start, visited);
  }
  if (scoped?.kind === 'shadow') {
    return [];
  }
  const binding = model.imports.get(name);
  if (binding === undefined) {
    return [];
  }
  const directTargets = moduleSpecifierTargets(context, file, binding.specifier);
  if (binding.kind === 'namespace') {
    return directTargets;
  }
  return directTargets.flatMap((target) =>
    exportedNamespaceTargets(context, target, binding.imported, visited),
  );
}

// eslint-disable-next-line func-style -- Member paths recurse through arbitrarily nested exported namespaces.
function namespacePathTargets(
  context: ApiContractSourceContext,
  file: string,
  pathParts: readonly string[],
  position: number,
  visited: Set<string>,
): readonly string[] {
  const [root, ...rest] = pathParts;
  if (root === undefined) {
    return [];
  }
  let targets = localNamespaceTargets(context, file, root, position, visited);
  for (const member of rest) {
    targets = targets.flatMap((target) =>
      exportedNamespaceTargets(context, target, member, visited),
    );
  }
  return [...new Set(targets)];
}

// eslint-disable-next-line func-style -- Export and expression resolution are mutually recursive across the source graph.
function exportedExpressionIsForbidden(
  context: ApiContractSourceContext,
  file: string,
  exportedName: string,
  forbidRecord: boolean,
  visited: Set<string>,
): boolean {
  const provider = externalSpecifier(file);
  if (
    provider !== undefined &&
    schemaProviderSpecifiers.has(provider) &&
    isForbiddenMember(exportedName, forbidRecord)
  ) {
    return true;
  }
  const key = `forbidden-export:${file}:${exportedName}:${forbidRecord}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  for (const binding of model?.exports.get(exportedName) ?? []) {
    if (
      binding.kind === 'expression' &&
      expressionIsForbidden(context, file, binding.span, forbidRecord, visited)
    ) {
      return true;
    }
    if (
      binding.kind === 'local' &&
      localIdentifierIsForbidden(
        context,
        file,
        binding.local,
        model?.moduleScope.start ?? 0,
        forbidRecord,
        visited,
      )
    ) {
      return true;
    }
    if (binding.kind === 'reexport') {
      if (
        moduleSpecifierTargets(context, file, binding.specifier).some((target) =>
          exportedExpressionIsForbidden(context, target, binding.imported, forbidRecord, visited),
        )
      ) {
        return true;
      }
    }
  }
  for (const target of unambiguousStarTargets(context, file, exportedName)) {
    if (exportedExpressionIsForbidden(context, target, exportedName, forbidRecord, visited)) {
      return true;
    }
  }
  return false;
}

// eslint-disable-next-line func-style -- Identifier resolution participates in the mutually recursive source graph.
function localIdentifierIsForbidden(
  context: ApiContractSourceContext,
  file: string,
  name: string,
  position: number,
  forbidRecord: boolean,
  visited: Set<string>,
): boolean {
  const key = `forbidden-local:${file}:${name}:${position}:${forbidRecord}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  if (model === undefined) {
    return false;
  }
  const scoped = scopedBindingsAt(model, name, position);
  if (scoped.length > 0) {
    return scoped.some((candidate) => {
      if (candidate.kind === 'expression') {
        return expressionIsForbidden(context, file, candidate.expression, forbidRecord, visited);
      }
      if (candidate.kind === 'function') {
        return expressionIsForbidden(context, file, candidate.body, forbidRecord, visited);
      }
      if (candidate.kind === 'destructured') {
        const pathParts = memberPath(candidate.source);
        return (
          pathParts !== undefined &&
          schemaNamespacePath(context, file, pathParts, candidate.source.start, new Set()) &&
          isForbiddenMember(candidate.member, forbidRecord)
        );
      }
      if (candidate.kind === 'namespace-rest') {
        const pathParts = memberPath(candidate.source);
        return (
          !model.members.some((member) => member.start === position && member.end > position) &&
          pathParts !== undefined &&
          schemaNamespacePath(context, file, pathParts, candidate.source.start, new Set())
        );
      }
      return false;
    });
  }
  const binding = model.imports.get(name);
  if (binding === undefined) {
    return false;
  }
  if (
    binding.kind !== 'namespace' &&
    schemaProviderSpecifiers.has(binding.specifier) &&
    isForbiddenMember(binding.imported, forbidRecord)
  ) {
    return true;
  }
  return (
    binding.kind !== 'namespace' &&
    moduleSpecifierTargets(context, file, binding.specifier).some((target) =>
      exportedExpressionIsForbidden(context, target, binding.imported, forbidRecord, visited),
    )
  );
}

const memberIsForbidden = (
  context: ApiContractSourceContext,
  file: string,
  member: MemberExpression,
  forbidRecord: boolean,
  visited: Set<string>,
): boolean => {
  const pathParts = memberPathAt(context, file, member, member.start);
  if (pathParts === undefined || pathParts.length < 2) {
    return false;
  }
  const schemaMember = pathParts.at(-1);
  if (
    schemaMember !== undefined &&
    isForbiddenMember(schemaMember, forbidRecord) &&
    schemaNamespacePath(context, file, pathParts.slice(0, -1), member.start, new Set())
  ) {
    return true;
  }
  if (schemaMember === undefined) {
    return false;
  }
  return namespacePathTargets(context, file, pathParts.slice(0, -1), member.start, new Set()).some(
    (target) => exportedExpressionIsForbidden(context, target, schemaMember, forbidRecord, visited),
  );
};

// eslint-disable-next-line func-style -- Expression and export resolution are mutually recursive across aliases and modules.
function expressionIsForbidden(
  context: ApiContractSourceContext,
  file: string,
  expression: Span,
  forbidRecord: boolean,
  visited: Set<string>,
): boolean {
  const key = `forbidden-expression:${file}:${expression.start}:${expression.end}:${forbidRecord}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  if (
    model?.members.some(
      (member) =>
        within(member, expression) &&
        memberIsForbidden(context, file, member, forbidRecord, visited),
    ) === true
  ) {
    return true;
  }
  return (
    model?.identifiers.some(
      (identifier) =>
        within(identifier, expression) &&
        localIdentifierIsForbidden(
          context,
          file,
          identifier.name,
          identifier.start,
          forbidRecord,
          visited,
        ),
    ) === true
  );
}

// eslint-disable-next-line func-style -- Local/imported aliases and module re-exports are resolved recursively.
function exportedBindingResolvesSymbol(
  context: ApiContractSourceContext,
  file: string,
  exportedName: string,
  symbols: ReadonlySet<string>,
  visited: Set<string>,
): boolean {
  const provider = externalSpecifier(file);
  if (provider !== undefined) {
    return specifierProvidesSymbol(provider, exportedName, symbols);
  }
  const key = `symbol-export:${file}:${exportedName}:${[...symbols].join(',')}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  for (const binding of model?.exports.get(exportedName) ?? []) {
    if (
      binding.kind === 'local' &&
      localBindingResolvesSymbol(
        context,
        file,
        binding.local,
        model?.moduleScope.start ?? 0,
        symbols,
        visited,
      )
    ) {
      return true;
    }
    if (binding.kind === 'reexport') {
      if (specifierProvidesSymbol(binding.specifier, binding.imported, symbols)) {
        return true;
      }
      if (
        moduleSpecifierTargets(context, file, binding.specifier).some((target) =>
          exportedBindingResolvesSymbol(context, target, binding.imported, symbols, visited),
        )
      ) {
        return true;
      }
    }
    if (
      binding.kind === 'expression' &&
      expressionResolvesSymbol(context, file, binding.span, symbols, visited)
    ) {
      return true;
    }
  }
  for (const target of unambiguousStarTargets(context, file, exportedName)) {
    if (exportedBindingResolvesSymbol(context, target, exportedName, symbols, visited)) {
      return true;
    }
  }
  return false;
}

const specifierProvidesSymbol = (
  specifier: string,
  importedName: string,
  symbols: ReadonlySet<string>,
): boolean => {
  if (!symbols.has(importedName)) {
    return false;
  }
  if (importedName === 'HttpApiEndpoint') {
    return endpointProviderSpecifiers.has(specifier);
  }
  if (problemDetailsFactoryNames.has(importedName)) {
    return specifier === '@app/shared-contracts' || specifier.startsWith('@app/shared-contracts/');
  }
  return false;
};

// eslint-disable-next-line func-style -- Symbol resolution follows declaration and import aliases without executing modules.
function localBindingResolvesSymbol(
  context: ApiContractSourceContext,
  file: string,
  name: string,
  position: number,
  symbols: ReadonlySet<string>,
  visited: Set<string>,
): boolean {
  const key = `symbol-local:${file}:${name}:${position}:${[...symbols].join(',')}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  if (model === undefined) {
    return false;
  }
  const scoped = scopedBindingsAt(model, name, position);
  if (scoped.length > 0) {
    return scoped.some((candidate) => {
      if (candidate.kind === 'expression') {
        return expressionResolvesSymbol(context, file, candidate.expression, symbols, visited);
      }
      if (candidate.kind === 'destructured') {
        const pathParts = memberPath(candidate.source);
        return (
          pathParts !== undefined &&
          pathResolvesSymbol(
            context,
            file,
            [...pathParts, candidate.member],
            candidate.source.start,
            symbols,
            visited,
          )
        );
      }
      if (candidate.kind === 'namespace-rest') {
        const pathParts = memberPath(candidate.source);
        return (
          pathParts !== undefined &&
          pathResolvesSymbol(context, file, pathParts, candidate.source.start, symbols, visited)
        );
      }
      return false;
    });
  }
  const binding = model.imports.get(name);
  if (binding === undefined) {
    return symbols.has(name);
  }
  if (
    binding.kind !== 'namespace' &&
    specifierProvidesSymbol(binding.specifier, binding.imported, symbols)
  ) {
    return true;
  }
  return (
    binding.kind !== 'namespace' &&
    moduleSpecifierTargets(context, file, binding.specifier).some((target) =>
      exportedBindingResolvesSymbol(context, target, binding.imported, symbols, visited),
    )
  );
}

const pathResolvesSymbol = (
  context: ApiContractSourceContext,
  file: string,
  pathParts: readonly string[],
  position: number,
  symbols: ReadonlySet<string>,
  visited: Set<string>,
): boolean => {
  if (pathParts.length === 1) {
    const name = pathParts[0];
    return (
      name !== undefined &&
      localBindingResolvesSymbol(context, file, name, position, symbols, visited)
    );
  }
  const symbol = pathParts.at(-1);
  const root = pathParts[0];
  if (symbol === undefined || root === undefined) {
    return false;
  }
  const model = sourceModel(context, file);
  if (
    model?.memberAssignments.some(
      (assignment) =>
        assignment.at <= position &&
        position >= assignment.scope.start &&
        position <= assignment.scope.end &&
        assignment.path.length === pathParts.length &&
        assignment.path.every((part, index) => part === pathParts[index]) &&
        expressionResolvesSymbol(context, file, assignment.expression, symbols, visited),
    ) === true
  ) {
    return true;
  }
  const scoped = model === undefined ? undefined : scopedBindingAt(model, root, position);
  if (scoped?.kind === 'expression') {
    const propertyValue = objectPathExpression(scoped.expression, pathParts.slice(1));
    if (
      propertyValue !== undefined &&
      expressionResolvesSymbol(context, file, propertyValue, symbols, visited)
    ) {
      return true;
    }
  }
  const directImport = scoped === undefined ? model?.imports.get(root) : undefined;
  if (
    pathParts.length === 2 &&
    directImport?.kind === 'namespace' &&
    specifierProvidesSymbol(directImport.specifier, symbol, symbols)
  ) {
    return true;
  }
  return namespacePathTargets(context, file, pathParts.slice(0, -1), position, new Set()).some(
    (target) => exportedBindingResolvesSymbol(context, target, symbol, symbols, visited),
  );
};

// eslint-disable-next-line func-style -- Symbol expressions can be direct identifiers, namespace members, or exported-expression spans.
function expressionResolvesSymbol(
  context: ApiContractSourceContext,
  file: string,
  expression: Span,
  symbols: ReadonlySet<string>,
  visited: Set<string>,
): boolean {
  const model = sourceModel(context, file);
  const pathParts = model?.members
    .filter((member) => member.start === expression.start && member.end === expression.end)
    .map((member) => memberPathAt(context, file, member, expression.start))
    .find((candidate) => candidate !== undefined);
  if (
    pathParts !== undefined &&
    pathResolvesSymbol(context, file, pathParts, expression.start, symbols, visited)
  ) {
    return true;
  }
  const identifier = model?.identifiers.find(
    (candidate) => candidate.start === expression.start && candidate.end === expression.end,
  );
  return (
    identifier !== undefined &&
    localBindingResolvesSymbol(context, file, identifier.name, identifier.start, symbols, visited)
  );
}

const functionReturnsEndpointFactory = (
  context: ApiContractSourceContext,
  file: string,
  body: Span,
  visited: Set<string>,
): boolean => {
  const model = sourceModel(context, file);
  return (
    model?.returns.some(
      (returned) =>
        returned.scope.start === body.start &&
        returned.scope.end === body.end &&
        expressionResolvesEndpointFactory(context, file, returned.expression, false, visited),
    ) === true
  );
};

const functionExpressionReturnsEndpointFactory = (
  context: ApiContractSourceContext,
  file: string,
  expression: Expression,
  visited: Set<string>,
): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'ArrowFunctionExpression') {
    return unwrapped.body.type === 'BlockStatement'
      ? functionReturnsEndpointFactory(context, file, unwrapped.body, visited)
      : expressionResolvesEndpointFactory(context, file, unwrapped.body, false, visited);
  }
  return (
    unwrapped.type === 'FunctionExpression' &&
    unwrapped.body !== null &&
    functionReturnsEndpointFactory(context, file, unwrapped.body, visited)
  );
};

// eslint-disable-next-line func-style -- Endpoint factory provenance recurses through local/imported aliases and re-exports.
function exportedExpressionResolvesEndpointFactory(
  context: ApiContractSourceContext,
  file: string,
  exportedName: string,
  isBuilder: boolean,
  visited: Set<string>,
): boolean {
  const provider = externalSpecifier(file);
  if (
    provider === 'effect/unstable/httpapi/HttpApiEndpoint' &&
    (isBuilder ? exportedName === 'make' : endpointMethods.has(exportedName))
  ) {
    return true;
  }
  const key = `endpoint-factory-export:${file}:${exportedName}:${isBuilder}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  for (const binding of model?.exports.get(exportedName) ?? []) {
    if (
      binding.kind === 'expression' &&
      expressionResolvesEndpointFactory(context, file, binding.span, isBuilder, visited)
    ) {
      return true;
    }
    if (
      binding.kind === 'local' &&
      localIdentifierResolvesEndpointFactory(
        context,
        file,
        binding.local,
        model?.moduleScope.start ?? 0,
        isBuilder,
        visited,
      )
    ) {
      return true;
    }
    if (
      binding.kind === 'reexport' &&
      moduleSpecifierTargets(context, file, binding.specifier).some((target) =>
        exportedExpressionResolvesEndpointFactory(
          context,
          target,
          binding.imported,
          isBuilder,
          visited,
        ),
      )
    ) {
      return true;
    }
  }
  return unambiguousStarTargets(context, file, exportedName).some((target) =>
    exportedExpressionResolvesEndpointFactory(context, target, exportedName, isBuilder, visited),
  );
}

// eslint-disable-next-line func-style -- Local endpoint factory aliases participate in the recursive module graph.
function localIdentifierResolvesEndpointFactory(
  context: ApiContractSourceContext,
  file: string,
  name: string,
  position: number,
  isBuilder: boolean,
  visited: Set<string>,
): boolean {
  const key = `endpoint-factory-local:${file}:${name}:${position}:${isBuilder}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  if (model === undefined) {
    return false;
  }
  const scoped = scopedBindingsAt(model, name, position);
  if (scoped.length > 0) {
    return scoped.some((candidate) => {
      if (candidate.kind === 'function') {
        return isBuilder && functionReturnsEndpointFactory(context, file, candidate.body, visited);
      }
      if (candidate.kind === 'expression') {
        return isBuilder &&
          functionExpressionReturnsEndpointFactory(context, file, candidate.expression, visited)
          ? true
          : expressionResolvesEndpointFactory(
              context,
              file,
              candidate.expression,
              isBuilder,
              visited,
            );
      }
      if (candidate.kind === 'destructured') {
        const targets = namespacePathTargets(
          context,
          file,
          memberPath(candidate.source) ?? [],
          candidate.source.start,
          new Set(),
        );
        return targets.some((target) =>
          exportedExpressionResolvesEndpointFactory(
            context,
            target,
            candidate.member,
            isBuilder,
            visited,
          ),
        );
      }
      return false;
    });
  }
  const binding = model.imports.get(name);
  return (
    binding !== undefined &&
    binding.kind !== 'namespace' &&
    moduleSpecifierTargets(context, file, binding.specifier).some((target) =>
      exportedExpressionResolvesEndpointFactory(
        context,
        target,
        binding.imported,
        isBuilder,
        visited,
      ),
    )
  );
}

// eslint-disable-next-line func-style -- Endpoint factory values may be built, aliased, imported, or re-exported.
function expressionResolvesEndpointFactory(
  context: ApiContractSourceContext,
  file: string,
  expression: Span,
  isBuilder: boolean,
  visited: Set<string>,
): boolean {
  const key = `endpoint-factory-expression:${file}:${expression.start}:${expression.end}:${isBuilder}`;
  if (visited.has(key)) {
    return false;
  }
  visited.add(key);
  const model = sourceModel(context, file);
  const member = model?.members.find(
    (candidate) => candidate.start === expression.start && candidate.end === expression.end,
  );
  if (member !== undefined) {
    const method = memberNameAt(context, file, member);
    if (
      method !== undefined &&
      (isBuilder ? method === 'make' : endpointMethods.has(method)) &&
      expressionResolvesSymbol(
        context,
        file,
        member.object,
        new Set(['HttpApiEndpoint']),
        new Set(),
      )
    ) {
      return true;
    }
    const pathParts = memberPathAt(context, file, member, member.start);
    const exportedName = pathParts?.at(-1);
    if (pathParts !== undefined && exportedName !== undefined) {
      return namespacePathTargets(
        context,
        file,
        pathParts.slice(0, -1),
        member.start,
        new Set(),
      ).some((target) =>
        exportedExpressionResolvesEndpointFactory(
          context,
          target,
          exportedName,
          isBuilder,
          visited,
        ),
      );
    }
  }
  const identifier = model?.identifiers.find(
    (candidate) => candidate.start === expression.start && candidate.end === expression.end,
  );
  if (
    identifier !== undefined &&
    localIdentifierResolvesEndpointFactory(
      context,
      file,
      identifier.name,
      identifier.start,
      isBuilder,
      visited,
    )
  ) {
    return true;
  }
  const call = model?.calls.find(
    (candidate) => candidate.start === expression.start && candidate.end === expression.end,
  );
  return (
    !isBuilder &&
    call !== undefined &&
    expressionResolvesEndpointFactory(context, file, call.callee, true, visited)
  );
}

const isEndpointCall = (
  context: ApiContractSourceContext,
  file: string,
  call: CallExpression,
): boolean => {
  const callee = unwrapExpression(call.callee);
  if (expressionResolvesEndpointFactory(context, file, callee, false, new Set())) {
    return true;
  }
  if (callee.type === 'Identifier') {
    const model = sourceModel(context, file);
    const scoped =
      model === undefined ? undefined : scopedBindingAt(model, callee.name, callee.start);
    if (scoped?.kind === 'destructured' && endpointMethods.has(scoped.member)) {
      return expressionResolvesSymbol(
        context,
        file,
        scoped.source,
        new Set(['HttpApiEndpoint']),
        new Set(),
      );
    }
    if (scoped?.kind === 'expression') {
      const aliased = unwrapExpression(scoped.expression);
      if (aliased.type === 'MemberExpression') {
        const method = memberNameAt(context, file, aliased);
        return (
          method !== undefined &&
          endpointMethods.has(method) &&
          expressionResolvesSymbol(
            context,
            file,
            aliased.object,
            new Set(['HttpApiEndpoint']),
            new Set(),
          )
        );
      }
    }
    return false;
  }
  if (callee.type !== 'MemberExpression') {
    return false;
  }
  const method = memberNameAt(context, file, callee);
  return (
    method !== undefined &&
    endpointMethods.has(method) &&
    expressionResolvesSymbol(context, file, callee.object, new Set(['HttpApiEndpoint']), new Set())
  );
};

const isProblemDetailsCall = (
  context: ApiContractSourceContext,
  file: string,
  call: CallExpression,
): boolean =>
  expressionResolvesSymbol(context, file, call.callee, problemDetailsFactoryNames, new Set());

const violationMessage =
  'HttpApi contracts must use concrete request, response, error, and Problem Details extension schemas; unconstrained schemas, unknown JSON, and arbitrary Problem Details extension records are forbidden';

export const unconstrainedHttpApiContractSchemaViolation = (
  content: string,
  context?: ApiContractSourceContext,
): string | undefined => {
  const resolvedContext =
    context ??
    ({
      file: 'inline-contract.ts',
      sources: new Map([['inline-contract.ts', content]]),
    } satisfies ApiContractSourceContext);
  const model = sourceModel(resolvedContext, resolvedContext.file);
  for (const call of model?.calls ?? []) {
    if (
      isEndpointCall(resolvedContext, resolvedContext.file, call) &&
      expressionIsForbidden(resolvedContext, resolvedContext.file, call, false, new Set())
    ) {
      return violationMessage;
    }
    if (isProblemDetailsCall(resolvedContext, resolvedContext.file, call)) {
      const extensions = call.arguments.at(2);
      if (
        extensions !== undefined &&
        expressionIsForbidden(resolvedContext, resolvedContext.file, extensions, true, new Set())
      ) {
        return violationMessage;
      }
    }
  }
  return undefined;
};
