import { createRequire } from 'node:module';

import { Effect, FileSystem, Path, Schema } from 'effect';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { PlatformError } from 'effect/PlatformError';
import { parseSync, Visitor, visitorKeys } from 'oxc-parser';
import type { Node, ObjectExpression, Program } from 'oxc-parser';

import { buildKnipRuntimeEvidence, workspaceDirectories } from './knip-runtime-model.mts';

const Strings = Schema.Array(Schema.String);
const PluginSchema = Schema.Struct({
  config: Schema.optional(Strings),
  entry: Schema.optional(Strings),
});
const WorkspaceSchema = Schema.Struct({
  drizzle: Schema.optional(PluginSchema),
  entry: Schema.optional(Strings),
  ignoreDependencies: Schema.optional(Strings),
  ignoreIssues: Schema.optional(Schema.Record(Schema.String, Strings)),
  lefthook: Schema.optional(Schema.Boolean),
  node: Schema.optional(Schema.Boolean),
  playwright: Schema.optional(PluginSchema),
  project: Schema.optional(Strings),
  rstest: Schema.optional(PluginSchema),
});
export const KnipConfigSchema = Schema.Struct({
  ...WorkspaceSchema.fields,
  ignore: Schema.optional(Strings),
  workspaces: Schema.optional(Schema.Record(Schema.String, WorkspaceSchema)),
});
const ExportLeaf = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]);
const ExportsSchema = Schema.Union([Schema.String, Schema.Record(Schema.String, ExportLeaf)]);
const DependencyDeclarationSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  name: Schema.optional(Schema.String),
});
const PackageSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optional(ExportsSchema),
  modernjs: Schema.optional(
    Schema.Struct({
      ontosModule: Schema.optional(
        Schema.Struct({
          manifest: Schema.optional(Schema.String),
          registration: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  name: Schema.optional(Schema.String),
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  'zephyr:dependencies': Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

class KnipModelError extends Schema.TaggedError<KnipModelError>()('KnipModelError', {
  reason: Schema.String,
}) {}

const unprovenResolver = { kind: 'resolver-unproven' } as const;
const playwrightPackageName = '@playwright/test';

export const KnipModelEvidenceSchema = Schema.Struct({
  aliasMembers: Schema.optional(
    Schema.Array(Schema.Struct({ col: Schema.Number, line: Schema.Number, name: Schema.String })),
  ),
  anchor: Schema.optional(Schema.String),
  column: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  declarationColumn: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))),
  declarationLine: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))),
  declarationSource: Schema.optional(Schema.String),
  dependencyCategory: Schema.optional(Schema.Literals(['dependencies', 'devDependencies'])),
  kind: Schema.Literals([
    'entry',
    'file',
    'dependency',
    'export',
    'type',
    'alias',
    'resolver',
    'native-resolver',
    'api-schema-alias',
    unprovenResolver.kind,
    'compiler-option',
  ]),
  line: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  owningManifest: Schema.optional(Schema.String),
  producerManifest: Schema.optional(Schema.String),
  producerResolved: Schema.optional(Schema.String),
  reason: Schema.String,
  resolved: Schema.optional(Schema.String),
  source: Schema.String,
  specifier: Schema.optional(Schema.String),
  target: Schema.String,
  workspace: Schema.String,
});
export type KnipModelEvidence = typeof KnipModelEvidenceSchema.Type;

type WorkspaceConfig = typeof WorkspaceSchema.Type;
interface SourceFacts {
  readonly file: string;
  readonly program: Program;
  readonly source: string;
  readonly variables: ReadonlyMap<string, Node>;
}
const isString = Schema.is(Schema.String);
const sourceExtension = /\.(?:[cm]?[jt]sx?|css)$/u;
const skippedDirectories = new Set([
  'node_modules',
  'dist',
  'dist-cloudflare',
  'cloudflare-dist',
  'repos',
  'modern-tanstack',
  'coverage',
  'test-results',
  'playwright-report',
]);
const invalidFixtures = 'tools/oxlint/effect-native/tests/fixtures';

const propertyName = (node: Node): string | undefined => {
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'Literal' && isString(node.value)) {
    return node.value;
  }
  return undefined;
};

const declarations = (program: Program): Map<string, Node> => {
  const result = new Map<string, Node>();
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration') {
      continue;
    }
    for (const binding of declaration.declarations) {
      if (binding.id.type === 'Identifier' && binding.init !== null) {
        result.set(binding.id.name, binding.init);
      }
    }
  }
  return result;
};

const unwrap = (node: Node | undefined, variables: ReadonlyMap<string, Node>, depth = 0): Node | undefined => {
  if (node === undefined || depth > 12) {
    return undefined;
  }
  if (node.type === 'Identifier') {
    return unwrap(variables.get(node.name), variables, depth + 1);
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') {
    return unwrap(node.expression, variables, depth + 1);
  }
  return node;
};

const staticString = (node: Node | undefined, variables: ReadonlyMap<string, Node>): string | undefined => {
  const value = unwrap(node, variables);
  if (value?.type === 'Literal' && isString(value.value)) {
    return value.value;
  }
  if (value?.type === 'TemplateLiteral' && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const objectExpression = (
  node: Node | undefined,
  variables: ReadonlyMap<string, Node>,
): ObjectExpression | undefined => {
  const value = unwrap(node, variables);
  if (value?.type === 'ObjectExpression') {
    return value;
  }
  if (value?.type === 'CallExpression') {
    return objectExpression(value.arguments[0], variables);
  }
  return undefined;
};

const exportedObject = ({ program, variables }: SourceFacts): ObjectExpression | undefined => {
  const exported = program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  return exported?.type === 'ExportDefaultDeclaration' ? objectExpression(exported.declaration, variables) : undefined;
};

const objectValue = (object: ObjectExpression | undefined, name: string): Node | undefined => {
  const property = object?.properties.find(
    (node) => node.type === 'Property' && !node.computed && propertyName(node.key) === name,
  );
  return property?.type === 'Property' ? property.value : undefined;
};

const rstestEnvironmentEvidence = (facts: SourceFacts, workspace: string): KnipModelEvidence[] => {
  if (!/rstest\.config\.[cm]?[jt]s$/u.test(facts.file)) {
    return [];
  }
  const config = exportedObject(facts);
  const projects = unwrap(objectValue(config, 'projects'), facts.variables);
  const configurations = [config];
  if (projects?.type === 'ArrayExpression') {
    for (const element of projects.elements) {
      const project = unwrap(element ?? undefined, facts.variables);
      if (project?.type === 'ObjectExpression') {
        configurations.push(project);
      }
    }
  }
  return configurations.flatMap((object) => {
    const environment = objectValue(object, 'testEnvironment');
    const target = staticString(environment, facts.variables);
    return target === undefined || target === 'node'
      ? []
      : [
          evidenceAt(
            facts,
            workspace,
            'dependency',
            target,
            environment?.start ?? 0,
            'Rstest testEnvironment consumer',
          ),
        ];
  });
};

const exportLeaves = (value: typeof ExportsSchema.Type | undefined): string[] => {
  if (isString(value)) {
    return [value];
  }
  if (value === undefined) {
    return [];
  }
  return Object.values(value).flatMap((entry) => (isString(entry) ? [entry] : Object.values(entry)));
};

const importedUrlBase = (node: Node | undefined): boolean =>
  node?.type === 'MemberExpression' &&
  propertyName(node.property) === 'url' &&
  node.object.type === 'MetaProperty' &&
  node.object.meta.name === 'import';

const parseSource = Effect.fn('QualityAudit.parseKnipModelSource')(function* parseModelSource(
  file: string,
  source: string,
) {
  const result = yield* Effect.try({
    catch: () =>
      new KnipModelError({
        reason: `Unable to parse quality model source ${file}`,
      }),
    try: () => parseSync(file, source),
  });
  if (result.errors.length > 0) {
    return yield* new KnipModelError({
      reason: `Invalid quality model source ${file}: ${result.errors[0]?.message}`,
    });
  }
  return {
    file,
    program: result.program,
    source,
    variables: declarations(result.program),
  };
});

const sourceFiles = Effect.fn('QualityAudit.knipModelSourceFiles')(function* readModelFiles(
  root: string,
  relative: string,
): Effect.fn.Return<string[], PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: string[] = [];
  const names = yield* fs.readDirectory(path.join(root, relative));
  const children = names.flatMap((name) => {
    const child = relative.length > 0 ? `${relative}/${name}` : name;
    return name.startsWith('.') || skippedDirectories.has(name) || child === invalidFixtures ? [] : [child];
  });
  for (const child of children) {
    const stat = yield* fs.stat(path.join(root, child));
    if (stat.type === 'Directory') {
      files.push(...(yield* sourceFiles(root, child)));
    } else if (sourceExtension.test(child)) {
      files.push(child);
    }
  }
  return files;
});

/**
 * `zephyr:dependencies` maps a Module Federation remote alias to a versioned package
 * reference such as `@app/party-registry@workspace:*`; the deployment platform resolves
 * the package by that name, so the manifest entry is a real consumer of the dependency.
 */
const zephyrPackageName = (reference: string): string | undefined => {
  const separator = reference.lastIndexOf('@');
  const name = separator > 0 ? reference.slice(0, separator) : reference;
  return name.length === 0 ? undefined : name;
};

/**
 * A package manifest names consumers no import graph can see: declared export leaves, the Modern
 * module contract, and the Zephyr composition remotes the deployment platform resolves by package
 * name. Each one is evidence that the referenced entry point or dependency is genuinely used.
 */
const manifestEvidence = (
  manifest: typeof PackageSchema.Type,
  manifestFile: string,
  workspace: string,
): readonly KnipModelEvidence[] => {
  const facts: KnipModelEvidence[] = [];
  for (const target of [
    ...exportLeaves(manifest.exports),
    manifest.modernjs?.ontosModule?.manifest,
    manifest.modernjs?.ontosModule?.registration,
  ]) {
    if (target !== undefined) {
      facts.push({
        kind: 'entry',
        line: 1,
        reason: 'Declared package export or Modern module contract',
        source: manifestFile,
        target,
        workspace,
      });
    }
  }
  // The official compiler commands resolve tsrs/package.json from their owning workspace
  // before selecting the Effect-enabled binary; no JavaScript import exposes that consumer.
  const declaresCompiler =
    (manifest.devDependencies?.tsrs ?? manifest.dependencies?.tsrs) !== undefined &&
    (manifest.devDependencies?.['@effect/tsgo'] ?? manifest.dependencies?.['@effect/tsgo']) !== undefined;
  const compilerCommand = Object.values(manifest.scripts ?? {}).some((command) =>
    /^ultramodern-create ultramodern (?:compiler-prepare|typecheck --(?:build|project) [\w./-]+\.json(?: --force)?)$/u.test(
      command,
    ),
  );
  if (declaresCompiler && compilerCommand) {
    facts.push({
      kind: 'dependency',
      line: 1,
      reason: 'UltraModern compiler command resolves the declared tsrs metadata',
      source: manifestFile,
      target: 'tsrs',
      workspace,
    });
  }
  for (const [alias, reference] of Object.entries(manifest['zephyr:dependencies'] ?? {})) {
    const target = zephyrPackageName(reference);
    if (target !== undefined) {
      facts.push({
        kind: 'dependency',
        line: 1,
        reason: `Zephyr composition dependency declared for the ${alias} remote`,
        source: manifestFile,
        target,
        workspace,
      });
    }
  }
  return facts;
};

const evidenceAt = (
  facts: SourceFacts,
  workspace: string,
  kind: KnipModelEvidence['kind'],
  target: string,
  offset: number,
  reason: string,
): KnipModelEvidence => ({
  column: offset - facts.source.lastIndexOf('\n', offset - 1),
  kind,
  line: facts.source.slice(0, offset).split('\n').length,
  reason,
  source: facts.file,
  target,
  workspace,
});

const staticObjectFields = (node: Node | undefined): ReadonlyMap<string, Node> | undefined => {
  if (node?.type !== 'ObjectExpression') {
    return undefined;
  }
  const fields = new Map<string, Node>();
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init' || property.method) {
      return undefined;
    }
    const name = propertyName(property.key);
    if (name === undefined || fields.has(name)) {
      return undefined;
    }
    fields.set(name, property.value);
  }
  return fields;
};

const isSingleLineCommand = (command: string): boolean => !/[\r\n\u2028\u2029]/u.test(command);

interface ExportedBinding {
  readonly kind: 'export' | 'type';
  readonly name: string;
  readonly offset: number;
}

const identifierName = (node: Node | undefined): string | undefined =>
  node?.type === 'Identifier' ? node.name : undefined;

const exportedBindings = ({ program }: SourceFacts): readonly ExportedBinding[] =>
  program.body.flatMap((node) => {
    if (node.type !== 'ExportNamedDeclaration') {
      return [];
    }
    if (node.declaration?.type === 'VariableDeclaration') {
      return node.declaration.declarations.flatMap((declaration) => {
        const name = identifierName(declaration.id ?? undefined);
        return name === undefined ? [] : [{ kind: 'export' as const, name, offset: declaration.start }];
      });
    }
    if (
      node.declaration?.type === 'FunctionDeclaration' ||
      node.declaration?.type === 'ClassDeclaration' ||
      node.declaration?.type === 'TSEnumDeclaration'
    ) {
      const name = identifierName(node.declaration.id);
      return name === undefined ? [] : [{ kind: 'export' as const, name, offset: node.declaration.start }];
    }
    if (node.declaration?.type === 'TSTypeAliasDeclaration' || node.declaration?.type === 'TSInterfaceDeclaration') {
      return [{ kind: 'type' as const, name: node.declaration.id.name, offset: node.declaration.start }];
    }
    return node.specifiers.flatMap((specifier) => {
      const name = identifierName(specifier.exported);
      return name === undefined
        ? []
        : [
            {
              kind:
                node.exportKind === 'type' || specifier.exportKind === 'type' ? ('type' as const) : ('export' as const),
              name,
              offset: specifier.start,
            },
          ];
    });
  });

/** Packages whose `defineConfig` produces a Modern application configuration. */
const MODERN_CONFIG_FACTORY_SOURCES: ReadonlySet<string> = new Set([
  '@modern-js/app-tools',
  '@modern-js/ultramodern-app-tools',
]);

/** Modern's file router consumes splat components and paired client data outside the import graph. */
const modernRouteEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  workspace: string,
): KnipModelEvidence[] => {
  if (
    (manifest.dependencies?.['@modern-js/runtime'] ?? manifest.devDependencies?.['@modern-js/runtime']) === undefined
  ) {
    return [];
  }
  const configured = [...factsByPath.values()].some((facts) => {
    if (!/^modern\.config\.[cm]?[jt]s$/u.test(facts.file.slice(prefix.length))) {
      return false;
    }
    const factories = new Set(
      facts.program.body.flatMap((node) =>
        node.type === 'ImportDeclaration' &&
        node.importKind !== 'type' &&
        MODERN_CONFIG_FACTORY_SOURCES.has(node.source.value)
          ? node.specifiers.flatMap((specifier) =>
              specifier.type === 'ImportSpecifier' && propertyName(specifier.imported) === 'defineConfig'
                ? [specifier.local.name]
                : [],
            )
          : [],
      ),
    );
    const exported = facts.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
    const configuration = unwrap(exported?.declaration, facts.variables);
    return (
      configuration?.type === 'CallExpression' &&
      configuration.callee.type === 'Identifier' &&
      factories.has(configuration.callee.name)
    );
  });
  if (!configured) {
    return [];
  }
  const sourceAt = (base: string): SourceFacts | undefined =>
    ['ts', 'tsx', 'js', 'jsx'].flatMap((extension) => factsByPath.get(`${base}.${extension}`) ?? [])[0];
  return [...factsByPath.values()].flatMap((facts) => {
    const relative = facts.file.slice(prefix.length);
    if (!relative.startsWith('src/routes/')) {
      return [];
    }
    const match = /^(?<base>.*\/)(?<name>\$|(?:page|layout|\$)\.data\.client)\.[jt]sx?$/u.exec(relative);
    const { base, name } = match?.groups ?? {};
    if (base === undefined || name === undefined) {
      return [];
    }
    const [component] = name.split('.');
    if (component === undefined || sourceAt(`${prefix}${base}${component}`) === undefined) {
      return [];
    }
    const data = sourceAt(`${prefix}${base}${component}.data`);
    const loader = sourceAt(`${prefix}${base}${component}.loader`);
    if (name !== '$' && data === undefined && loader === undefined) {
      return [];
    }
    const evidence = [evidenceAt(facts, workspace, 'file', relative, 0, 'Modern native file-system route consumer')];
    const inlineNames = new Set(data === undefined ? [] : exportedBindings(data).map((binding) => binding.name));
    const consumed =
      name === '$' || data === undefined
        ? facts.program.body.flatMap((node) =>
            node.type === 'ExportDefaultDeclaration' ? [{ name: 'default', offset: node.start }] : [],
          )
        : exportedBindings(facts).filter(
            (binding) =>
              binding.kind === 'export' &&
              (binding.name === 'loader' || binding.name === 'action') &&
              inlineNames.has(binding.name),
          );
    for (const binding of consumed) {
      evidence.push(
        evidenceAt(
          facts,
          workspace,
          'export',
          `${facts.file}#${binding.name}`,
          binding.offset,
          'Modern native route renderer or client-data loader consumes this export',
        ),
      );
    }
    return evidence;
  });
};

const generatedActionContractEvidence = (facts: SourceFacts, workspace: string): KnipModelEvidence[] => {
  if (!facts.source.startsWith('// @generated by OntOS Codesmith Action v1\n')) {
    return [];
  }
  const owner = /^\/\/ @ontos-action-owner (?<owner>[a-z][a-z0-9.-]+)$/mu.exec(facts.source)?.groups?.owner;
  const slug = /^\/\/ @ontos-action-slug (?<slug>[a-z][a-z0-9-]+)$/mu.exec(facts.source)?.groups?.slug;
  if (owner === undefined || slug === undefined || !facts.file.endsWith(`/src/actions/${slug}.action.ts`)) {
    return [];
  }
  const slotStart = facts.source.indexOf('// <generated-outbox-message-exports>');
  const slotEnd = facts.source.indexOf('// </generated-outbox-message-exports>');
  return facts.program.body.flatMap((node) => {
    if (node.type !== 'ExportNamedDeclaration' || node.source?.type !== 'Literal' || !isString(node.source.value)) {
      return [];
    }
    const fromSharedContract = /^\.\.\/\.\.\/shared\/actions\/[a-z0-9-]+\.ts$/u.test(node.source.value);
    const fromGeneratedOutboxSlot =
      slotStart !== -1 &&
      slotEnd > slotStart &&
      node.start > slotStart &&
      node.end < slotEnd &&
      /^\.\/[a-z0-9-]+\.outbox-message\.ts$/u.test(node.source.value);
    if (!fromSharedContract && !fromGeneratedOutboxSlot) {
      return [];
    }
    return node.specifiers.flatMap((specifier) => {
      const name = identifierName(specifier.exported);
      return name === undefined
        ? []
        : [
            evidenceAt(
              facts,
              workspace,
              node.exportKind === 'type' || specifier.exportKind === 'type' ? 'type' : 'export',
              `${facts.file}#${name}`,
              specifier.start,
              fromSharedContract
                ? 'Generated Action public payload/result contract re-export'
                : 'Generated Outbox Message public action alias',
            ),
          ];
    });
  });
};

const generatedModuleApiEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  prefix: string,
  workspace: string,
): KnipModelEvidence[] => {
  const sharedApi = factsByPath.get(`${prefix}shared/api.ts`);
  if (sharedApi === undefined) {
    return [];
  }
  return sharedApi.program.body.flatMap((node) => {
    if (
      node.type !== 'ImportDeclaration' ||
      !node.source.value.startsWith('./apis/') ||
      !node.source.value.endsWith('.ts')
    ) {
      return [];
    }
    const apiName = node.specifiers.flatMap((specifier) => {
      if (specifier.type !== 'ImportSpecifier') {
        return [];
      }
      const name = identifierName(specifier.imported);
      return name?.endsWith('Api') === true ? [name.slice(0, -3)] : [];
    })[0];
    const target = factsByPath.get(`${prefix}shared/${node.source.value.slice(2)}`);
    if (
      apiName === undefined ||
      target === undefined ||
      !target.source.startsWith('// @generated by OntOS Codesmith module-api v1\n')
    ) {
      return [];
    }
    const publicContractName = new RegExp(`^${apiName}(?:Request|Response|Endpoint|Group)$`, 'u');
    return exportedBindings(target).flatMap((binding) =>
      publicContractName.test(binding.name)
        ? [
            evidenceAt(
              sharedApi,
              workspace,
              binding.kind,
              `${target.file}#${binding.name}`,
              node.start,
              'Generated module API public contract composed by shared/api.ts',
            ),
          ]
        : [],
    );
  });
};

const pascalCase = (value: string): string =>
  value
    .split(/[-.]/u)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');

const generatedOutboxMessageEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  workspace: string,
): KnipModelEvidence[] => {
  const declaredContracts = new Set(exportLeaves(manifest.exports));
  return [...factsByPath.values()].flatMap((facts) => {
    if (!facts.source.startsWith('// @generated by OntOS Codesmith Outbox Message v2\n')) {
      return [];
    }
    const action = /^\/\/ @ontos-outbox-action [a-z][a-z0-9.-]+\.(?<action>[a-z][a-z0-9-]+)$/mu.exec(facts.source)
      ?.groups?.action;
    const topic = /^\/\/ @ontos-outbox-topic (?<topic>[a-z][a-z0-9.-]+)$/mu.exec(facts.source)?.groups?.topic;
    if (action === undefined || topic === undefined) {
      return [];
    }
    const topicSlug = topic.replaceAll('.', '-');
    const relativeMessage = `src/actions/${action}-${topicSlug}.outbox-message.ts`;
    if (facts.file !== `${prefix}${relativeMessage}` || !declaredContracts.has(`./shared/outbox/${topicSlug}.ts`)) {
      return [];
    }
    const actionFacts = factsByPath.get(`${prefix}src/actions/${action}.action.ts`);
    const creator = `create${pascalCase(action)}${pascalCase(topicSlug)}OutboxMessage`;
    const runtimeImport = actionFacts?.program.body.some(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.source.value === `./${action}-${topicSlug}.outbox-message.ts` &&
        node.specifiers.some(
          (specifier) => specifier.type === 'ImportSpecifier' && identifierName(specifier.imported) === creator,
        ),
    );
    if (runtimeImport !== true) {
      return [];
    }
    const base = `${pascalCase(action)}${pascalCase(topicSlug)}Outbox`;
    const publicNames = new Set([`${base}Payload`, `${base}PayloadSchema`, `${base}ProducerModuleKey`, `${base}Topic`]);
    return exportedBindings(facts).flatMap((binding) =>
      publicNames.has(binding.name)
        ? [
            evidenceAt(
              facts,
              workspace,
              binding.kind,
              `${facts.file}#${binding.name}`,
              binding.offset,
              'Generated Outbox Message alias backed by a declared package contract and runtime action import',
            ),
          ]
        : [],
    );
  });
};

const importedBindingsByFile = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  path: Path.Path,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const imported = new Map<string, Set<string>>();
  for (const consumer of factsByPath.values()) {
    for (const node of consumer.program.body) {
      if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('.')) {
        continue;
      }
      const target = path.normalize(path.join(path.dirname(consumer.file), node.source.value)).replaceAll('\\', '/');
      const names = imported.get(target) ?? new Set<string>();
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const name = identifierName(specifier.imported);
          if (name !== undefined) {
            names.add(name);
          }
        }
      }
      imported.set(target, names);
    }
  }
  return imported;
};

interface LocalDeclaration {
  readonly exportedType: boolean;
  readonly offset: number;
  readonly source: string;
}

const localDeclarations = (facts: SourceFacts): ReadonlyMap<string, LocalDeclaration> => {
  const declarations = new Map<string, LocalDeclaration>();
  for (const statement of facts.program.body) {
    const exported = statement.type === 'ExportNamedDeclaration';
    const node = exported ? statement.declaration : statement;
    if (node?.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        const name = identifierName(declaration.id);
        if (name !== undefined) {
          declarations.set(name, {
            exportedType: false,
            offset: declaration.start,
            source: facts.source.slice(declaration.start, declaration.end),
          });
        }
      }
    } else if (
      node?.type === 'FunctionDeclaration' ||
      node?.type === 'ClassDeclaration' ||
      node?.type === 'TSTypeAliasDeclaration' ||
      node?.type === 'TSInterfaceDeclaration'
    ) {
      const name = identifierName(node.id ?? undefined);
      if (name !== undefined) {
        declarations.set(name, {
          exportedType: exported && (node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration'),
          offset: node.start,
          source: facts.source.slice(node.start, node.end),
        });
      }
    }
  }
  return declarations;
};

const declarationClosure = (
  declarations: ReadonlyMap<string, LocalDeclaration>,
  seeds: Iterable<string>,
): ReadonlySet<string> => {
  const queue = [...seeds];
  const reached = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || reached.has(name)) {
      continue;
    }
    reached.add(name);
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      continue;
    }
    for (const dependency of declarations.keys()) {
      if (dependency !== name && new RegExp(`\\b${dependency}\\b`, 'u').test(declaration.source)) {
        queue.push(dependency);
      }
    }
  }
  return reached;
};

const declarationSurfaceEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const imported = importedBindingsByFile(factsByPath, path);
  const evidence: KnipModelEvidence[] = [];
  for (const facts of factsByPath.values()) {
    const declarations = localDeclarations(facts);
    const exported = new Map(exportedBindings(facts).map((binding) => [binding.name, binding]));
    const seeds = imported.get(facts.file) ?? new Set<string>();
    const reached = declarationClosure(declarations, seeds);
    for (const name of reached) {
      const binding = exported.get(name);
      if (binding !== undefined && !seeds.has(name)) {
        evidence.push(
          evidenceAt(
            facts,
            workspace,
            binding.kind,
            `${facts.file}#${name}`,
            binding.offset,
            'Exported declaration dependency is reachable from an imported public surface',
          ),
        );
      }
    }
  }
  return evidence;
};

const catalogReadBindingEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
): KnipModelEvidence[] => {
  if (workspace !== 'verticals/catalog') {
    return [];
  }
  return [...factsByPath.values()].flatMap((facts) => {
    if (
      !facts.file.startsWith('verticals/catalog/src/api/') ||
      !facts.file.endsWith('.read.ts') ||
      !facts.source.startsWith('// @generated by OntOS Codesmith module-api v1\n')
    ) {
      return [];
    }
    const declarations = localDeclarations(facts);
    const roots = facts.program.body.flatMap((statement) => {
      if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') {
        return [];
      }
      return statement.declaration.declarations.flatMap((declaration) =>
        declaration.init?.type === 'CallExpression' &&
        declaration.init.callee.type === 'Identifier' &&
        declaration.init.callee.name === 'defineRead'
          ? [facts.source.slice(declaration.start, declaration.end)]
          : [],
      );
    });
    if (roots.length === 0) {
      return [];
    }
    const seeds = [...declarations.keys()].filter((name) =>
      roots.some((root) => new RegExp(`\\b${name}\\b`, 'u').test(root)),
    );
    const reached = declarationClosure(declarations, seeds);
    return exportedBindings(facts).flatMap((binding) => {
      const declaration = declarations.get(binding.name);
      const composedReadBinding = reached.has(binding.name);
      const injectedServiceBinding =
        declaration?.source.includes('Context.Service') === true && reached.has(`${binding.name}Port`);
      return composedReadBinding || injectedServiceBinding
        ? [
            evidenceAt(
              facts,
              workspace,
              binding.kind,
              `${facts.file}#${binding.name}`,
              binding.offset,
              composedReadBinding
                ? 'Generated Catalog read binding is composed into its registered defineRead implementation'
                : 'Generated Catalog injection service backs a port composed into its registered defineRead implementation',
            ),
          ]
        : [];
    });
  });
};

const catalogSharedContractEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
): KnipModelEvidence[] => {
  if (workspace !== 'verticals/catalog') {
    return [];
  }
  return [...factsByPath.values()].flatMap((facts) =>
    /^verticals\/catalog\/shared\/(?:actions|apis|domain|outbox|resources)\/.+\.[cm]?[jt]sx?$/u.test(facts.file)
      ? exportedBindings(facts).map((binding) =>
          evidenceAt(
            facts,
            workspace,
            binding.kind,
            `${facts.file}#${binding.name}`,
            binding.offset,
            'Catalog shared contract leaf is externally consumable across the package boundary',
          ),
        )
      : [],
  );
};

const catalogAliasEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  if (workspace !== 'verticals/catalog') {
    return [];
  }
  const publicEntries = new Set(
    exportLeaves(manifest.exports).map((target) =>
      path.normalize(path.join(prefix, target)).replaceAll('\\', '/').replace(`${prefix}/`, prefix),
    ),
  );
  const imported = importedBindingsByFile(factsByPath, path);
  const evidence: KnipModelEvidence[] = [];
  for (const facts of factsByPath.values()) {
    const exported = new Set(exportedBindings(facts).map(({ name }) => name));
    const externalNames = imported.get(facts.file) ?? new Set<string>();
    for (const node of facts.program.body) {
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
        for (const declaration of node.declaration.declarations) {
          const alias = identifierName(declaration.id);
          const target = identifierName(declaration.init ?? undefined);
          if (
            alias !== undefined &&
            target !== undefined &&
            exported.has(target) &&
            ((alias.endsWith('Schema') && target.endsWith('Schema')) || alias === `${target}Schema`) &&
            (publicEntries.has(facts.file) || (externalNames.has(alias) && externalNames.has(target)))
          ) {
            evidence.push(
              evidenceAt(
                facts,
                workspace,
                'alias',
                `${facts.file}#${alias}=${target}`,
                declaration.start,
                publicEntries.has(facts.file)
                  ? 'Catalog semantic schema alias declared by the package public surface'
                  : 'Catalog semantic schema alias with both bindings imported by runtime consumers',
              ),
            );
          }
        }
      }
      if (
        node.type === 'ExportDefaultDeclaration' &&
        facts.source.startsWith('// @generated by OntOS Codesmith public-component v1\n') &&
        node.declaration.type === 'Identifier' &&
        exported.has(node.declaration.name) &&
        publicEntries.has(facts.file)
      ) {
        evidence.push(
          evidenceAt(
            facts,
            workspace,
            'alias',
            `${facts.file}#default=${node.declaration.name}`,
            node.start,
            'Generated package public component exposes the framework default alias',
          ),
        );
      }
    }
  }
  return evidence;
};

const generatedActionGatewayEvidence = (facts: SourceFacts, workspace: string): KnipModelEvidence[] => {
  if (
    !facts.file.endsWith('/src/api/action-gateway.ts') ||
    !facts.source.startsWith('// @generated by OntOS Codesmith MicroVertical Action Boundary v1\n')
  ) {
    return [];
  }
  const requiredExports = new Set(['ACTION_GATEWAY_AUDIENCE', 'makeOperationGateway', 'operationGateway']);
  return facts.program.body.flatMap((node) => {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'VariableDeclaration') {
      return [];
    }
    return node.declaration.declarations.flatMap((declaration) =>
      declaration.id.type === 'Identifier' && requiredExports.has(declaration.id.name)
        ? [
            evidenceAt(
              facts,
              workspace,
              'export',
              `${facts.file}#${declaration.id.name}`,
              declaration.start,
              'Generated action-boundary contract requires this exact exported binding',
            ),
          ]
        : [],
    );
  });
};

const generatedActionPrincipalEvidence = (facts: SourceFacts, workspace: string): KnipModelEvidence[] => {
  if (
    !facts.file.endsWith('/api/auth/action-principal.ts') ||
    !facts.source.startsWith('// @generated by OntOS Codesmith MicroVertical Action Boundary v1\n') ||
    !/^\/\/ @ontos-action-boundary-owner [a-z][a-z0-9.-]+$/mu.test(facts.source) ||
    !/^\/\/ @ontos-action-boundary-audience [a-z][a-z0-9.-]+$/mu.test(facts.source)
  ) {
    return [];
  }
  const requiredExports = new Set([
    'ACTION_PRINCIPAL_BEARER_CHALLENGE',
    'ActionPrincipalConfigurationErrorSchema',
    'ActionPrincipalExpiredErrorSchema',
    'ActionPrincipalInvalidErrorSchema',
    'ActionPrincipalMissingErrorSchema',
    'ActionPrincipalScopeErrorSchema',
    'ActionPrincipalUnavailableErrorSchema',
    'ActionPrincipalConfigurationError',
    'ActionPrincipalError',
    'ActionPrincipalExpiredError',
    'ActionPrincipalInvalidError',
    'ActionPrincipalMissingError',
    'ActionPrincipalScopeError',
    'ActionPrincipalUnavailableError',
    'ACTION_GATEWAY_AUDIENCE',
    'ActionPrincipalVerifier',
    'ActionPrincipalVerifierLive',
    'ActionPrincipalVerificationOptions',
    'verifyActionPrincipal',
    'authenticateOperationPrincipal',
  ]);
  return exportedBindings(facts).flatMap((binding) =>
    requiredExports.has(binding.name)
      ? [
          evidenceAt(
            facts,
            workspace,
            binding.kind,
            `${facts.file}#${binding.name}`,
            binding.offset,
            'Generated action-principal boundary exposes this exact verifier contract binding',
          ),
        ]
      : [],
  );
};

const federationFieldEvidence = (
  facts: SourceFacts,
  workspace: string,
  field: string,
  entries: ObjectExpression | undefined,
): KnipModelEvidence[] => {
  const result: KnipModelEvidence[] = [];
  for (const item of entries?.properties ?? []) {
    if (item.type !== 'Property' || item.computed) {
      continue;
    }
    const name = propertyName(item.key);
    const target = field === 'exposes' ? staticString(item.value, facts.variables) : name;
    if (target !== undefined) {
      result.push(
        evidenceAt(
          facts,
          workspace,
          field === 'exposes' ? 'entry' : 'dependency',
          target,
          item.start,
          `Module Federation ${field} consumer`,
        ),
      );
    }
  }
  return result;
};

const federationEvidence = (facts: SourceFacts, workspace: string): KnipModelEvidence[] => {
  if (!/(?:module-federation|backend-federation)\.config\.[cm]?[jt]s$/u.test(facts.file)) {
    return [];
  }
  const object = exportedObject(facts);
  return ['remotes', 'shared', 'exposes'].flatMap((field) =>
    federationFieldEvidence(facts, workspace, field, objectExpression(objectValue(object, field), facts.variables)),
  );
};

const scopedVariables = (facts: SourceFacts, offset: number): ReadonlyMap<string, Node> => {
  const variables = new Map(facts.variables);
  const blockBinding = (binding: Node) => {
    if (binding.type === 'Identifier') {
      variables.set(binding.name, binding);
    } else if (binding.type === 'AssignmentPattern') {
      blockBinding(binding.left);
    } else if (binding.type === 'RestElement') {
      blockBinding(binding.argument);
    } else if (binding.type === 'ObjectPattern') {
      for (const property of binding.properties) {
        blockBinding(property.type === 'Property' ? property.value : property.argument);
      }
    } else if (binding.type === 'ArrayPattern') {
      for (const element of binding.elements) {
        if (element !== null) blockBinding(element);
      }
    }
  };
  const recordDeclaration = (declaration: Node) => {
    if (declaration.type === 'VariableDeclaration') {
      for (const binding of declaration.declarations) {
        if (binding.id.type === 'Identifier' && binding.init !== null) {
          variables.set(binding.id.name, binding.init);
        } else {
          blockBinding(binding.id);
        }
      }
    } else if (
      (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') &&
      declaration.id !== null
    ) {
      blockBinding(declaration.id);
    }
  };
  for (const statement of facts.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration !== null) {
      recordDeclaration(declaration);
    }
  }
  const recordParameters = (
    node: Extract<Node, { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }>,
  ) => {
    if (node.start <= offset && offset < node.end) {
      for (const parameter of node.params) {
        if (parameter.type === 'AssignmentPattern' && parameter.left.type === 'Identifier') {
          variables.set(parameter.left.name, parameter);
        } else {
          blockBinding(parameter);
        }
      }
    }
  };
  const recordBlock = (node: Extract<Node, { type: 'BlockStatement' }>) => {
    if (node.start <= offset && offset < node.end) {
      for (const statement of node.body) {
        recordDeclaration(statement);
      }
    }
  };
  new Visitor({
    ArrowFunctionExpression: recordParameters,
    BlockStatement: recordBlock,
    CatchClause: (node) => {
      if (node.param !== null && node.start <= offset && offset < node.end) {
        blockBinding(node.param);
      }
    },
    FunctionDeclaration: recordParameters,
    FunctionExpression: recordParameters,
  }).visit(facts.program);
  return variables;
};

const importsPlaywrightDefineConfig = (facts: SourceFacts, name: string): boolean =>
  facts.program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.importKind !== 'type' &&
      node.source.value === playwrightPackageName &&
      node.specifiers.some(
        (binding) =>
          binding.type === 'ImportSpecifier' &&
          binding.importKind !== 'type' &&
          propertyName(binding.imported) === 'defineConfig' &&
          binding.local.name === name,
      ),
  );

const playwrightConfigFields = (facts: SourceFacts): ReadonlyMap<string, Node> | undefined => {
  const exported = facts.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  const call = exported?.type === 'ExportDefaultDeclaration' ? exported.declaration : undefined;
  if (call?.type !== 'CallExpression' || call.optional || call.arguments.length !== 1) {
    return undefined;
  }
  const { callee } = call;
  if (
    callee.type !== 'Identifier' ||
    scopedVariables(facts, call.start).has(callee.name) ||
    !importsPlaywrightDefineConfig(facts, callee.name)
  ) {
    return undefined;
  }
  let modifiedDefineConfig = false;
  new Visitor({
    AssignmentExpression: (node) => {
      if (node.left.type === 'Identifier' && node.left.name === callee.name) {
        modifiedDefineConfig = true;
      }
    },
    UpdateExpression: (node) => {
      if (node.argument.type === 'Identifier' && node.argument.name === callee.name) {
        modifiedDefineConfig = true;
      }
    },
  }).visit(facts.program);
  return modifiedDefineConfig ? undefined : staticObjectFields(call.arguments[0]);
};

const nodeCommandSource = (command: string | undefined): string | undefined => {
  if (command === undefined || !isSingleLineCommand(command)) {
    return undefined;
  }
  const script = /^[ \t]*node(?:[ \t]+--experimental-strip-types)?[ \t]+(?<script>[\w./@-]+\.[cm]?[jt]s)[ \t]*$/u.exec(
    command,
  )?.groups?.script;
  return script?.startsWith('-') === false ? script : undefined;
};

const playwrightNodeSource = (
  facts: SourceFacts,
  server: Node | undefined,
  manifestFile: string,
  workspace: string,
  ownerRoot: string,
  path: Path.Path,
): KnipModelEvidence | undefined => {
  const fields = staticObjectFields(server);
  const commandNode = fields?.get('command');
  const script = nodeCommandSource(staticString(commandNode, new Map()));
  const cwdNode = fields?.get('cwd');
  const cwd = cwdNode === undefined ? '' : staticString(cwdNode, new Map());
  if (script === undefined || cwd === undefined) {
    return undefined;
  }
  const target = path.relative(ownerRoot, path.resolve(ownerRoot, cwd, script)).replaceAll('\\', '/');
  if (target.startsWith('../') || path.isAbsolute(target)) {
    return undefined;
  }
  return {
    ...evidenceAt(
      facts,
      workspace,
      'file',
      target,
      commandNode?.start ?? 0,
      'Native Playwright webServer.command executes this source in its owning workspace',
    ),
    owningManifest: manifestFile,
  };
};

/** Playwright starts webServer commands; Knip's native plugin discovers only tests and setup hooks. */
const playwrightWebServerEvidence = (
  facts: SourceFacts,
  manifest: typeof PackageSchema.Type,
  manifestFile: string,
  workspace: string,
  appRoot: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const ownerRoot = path.resolve(appRoot, path.dirname(manifestFile));
  const configuration = path.relative(ownerRoot, path.resolve(appRoot, facts.file));
  if (
    !/^playwright\.config\.[cm]?[jt]s$/u.test(configuration) ||
    (manifest.dependencies?.[playwrightPackageName] === undefined &&
      manifest.devDependencies?.[playwrightPackageName] === undefined) ||
    !Object.values(manifest.scripts ?? {}).some(
      (command) => isSingleLineCommand(command) && /^playwright[ \t]+test[ \t]*$/u.test(command),
    )
  ) {
    return [];
  }
  const webServer = playwrightConfigFields(facts)?.get('webServer');
  const servers = webServer?.type === 'ArrayExpression' ? webServer.elements : [webServer];
  if (servers.some((server) => server?.type !== 'ObjectExpression')) {
    return [];
  }
  const evidence: KnipModelEvidence[] = [];
  for (const server of servers) {
    const fact = playwrightNodeSource(facts, server ?? undefined, manifestFile, workspace, ownerRoot, path);
    if (fact !== undefined) {
      evidence.push(fact);
    }
  }
  return evidence;
};

// Children come only from the successfully parsed tree and the parser's own child-key table.
const SubprocessNodeMetadata = Schema.Struct({
  end: Schema.Number,
  start: Schema.Number,
  type: Schema.String.check(
    Schema.makeFilter((type) => (Object.hasOwn(visitorKeys, type) ? undefined : 'Unknown parser node')),
  ),
});
const ParsedSubprocessNode = Schema.declare<Node>((value): value is Node => Schema.is(SubprocessNodeMetadata)(value));
const isParsedSubprocessNode = Schema.is(ParsedSubprocessNode);
const isSubprocessNodeRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const nativeSubprocessChildren = (node: Node): Node[] => {
  const record: unknown = node;
  if (!isSubprocessNodeRecord(record)) {
    return [];
  }
  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = record[key];
    const children: readonly unknown[] = Array.isArray(value) ? value : [value];
    return children.filter(isParsedSubprocessNode);
  });
};
const nativeSubprocessParents = (program: Program): Map<Node, Node> => {
  const parents = new Map<Node, Node>();
  const visit = (node: Node) => {
    for (const child of nativeSubprocessChildren(node)) {
      if (parents.has(child)) {
        continue;
      }
      parents.set(child, node);
      visit(child);
    }
  };
  visit(program);
  return parents;
};

const esbuildSubprocessInput = (
  elements: readonly (Node | null)[],
  literalStrings: (node: Node | undefined) => string[],
  immutableValue: (node: Node | undefined) => Node | undefined,
): string | undefined => {
  const prefix = ['exec', '--', 'pnpm', 'exec', 'esbuild'];
  if (
    !prefix.every((expected, index) => {
      const parts = literalStrings(elements[index] ?? undefined);
      return parts.length === 1 && parts[0] === expected;
    })
  ) {
    return undefined;
  }
  const source = literalStrings(elements[5] ?? undefined);
  const [input] = source;
  if (source.length !== 1 || input === undefined || input.startsWith('-')) {
    return undefined;
  }
  const flags = elements.slice(6);
  const allowedFlags = new Set(['--bundle', '--platform=node', '--format=esm', '--packages=external']);
  const isFlag = (raw: Node | null): boolean => {
    const value = immutableValue(raw ?? undefined);
    const literal = staticString(value, new Map());
    return (
      (literal !== undefined && (allowedFlags.has(literal) || literal.startsWith('--outfile='))) ||
      (value?.type === 'TemplateLiteral' && value.quasis[0]?.value.cooked?.startsWith('--outfile=') === true)
    );
  };
  if (
    !flags.some((flag) => staticString(immutableValue(flag ?? undefined), new Map()) === '--bundle') ||
    !flags.every(isFlag)
  ) {
    return undefined;
  }
  return input;
};

const nativeSubprocessBindingOrName = (node: Node, parent: Node): boolean =>
  (parent.type === 'VariableDeclarator' && parent.id === node) ||
  (parent.type === 'MemberExpression' && !parent.computed && parent.property === node) ||
  (parent.type === 'Property' && !parent.computed && parent.key === node && parent.value !== node) ||
  (parent.type === 'TSPropertySignature' && parent.key === node && !parent.computed);
const nativeSubprocessConstUse = (use: Node, parent: Node | undefined, parents: ReadonlyMap<Node, Node>): boolean => {
  if (parent?.type === 'VariableDeclarator' && parent.init === use && parent.id.type === 'Identifier') {
    const declaration = parents.get(parent);
    return (
      declaration?.type === 'VariableDeclaration' &&
      declaration.kind === 'const' &&
      parents.get(declaration)?.type !== 'ExportNamedDeclaration'
    );
  }
  return false;
};
const nativeSubprocessRuntimeReference = (node: Node, parents: ReadonlyMap<Node, Node>): boolean => {
  let child = node;
  let parent = parents.get(child);
  while (parent !== undefined) {
    if (
      parent.type === 'TSAsExpression' ||
      parent.type === 'TSSatisfiesExpression' ||
      parent.type === 'TSNonNullExpression' ||
      parent.type === 'TSInstantiationExpression'
    ) {
      if (parent.expression !== child) {
        return false;
      }
    } else if (
      parent.type === 'TSTypeAnnotation' ||
      parent.type === 'TSTypeAliasDeclaration' ||
      parent.type === 'TSInterfaceDeclaration'
    ) {
      return false;
    }
    child = parent;
    parent = parents.get(parent);
  }
  return true;
};
type SubprocessFamily = 'path' | 'url' | 'child_process' | 'process' | 'effect-process' | 'module' | 'vm';
const subprocessEffectFamily = 'effect-process';
const subprocessObjectAuthority = 'object-access';
const subprocessDirectAuthority = 'direct-value';
type SubprocessSlot =
  | 'default'
  | 'namespace'
  | 'ChildProcess'
  | 'resolve'
  | 'join'
  | 'fileURLToPath'
  | 'pathToFileURL'
  | 'spawn'
  | 'make'
  | 'execPath'
  | 'pid'
  | 'URL'
  | 'createRequire'
  | 'require'
  | 'loader-resolve'
  | 'syncBuiltinESMExports'
  | 'eval'
  | 'Function'
  | 'global-object';
interface SubprocessCapability {
  readonly authority: 'direct-value' | 'object-access';
  readonly family: SubprocessFamily;
  readonly kind: 'object' | 'callable' | 'scalar' | 'constructor' | 'loader' | 'ambient';
  readonly slot: SubprocessSlot;
}
const subprocessModules = new Map<string, SubprocessFamily>([
  ['path', 'path'],
  ['url', 'url'],
  ['child_process', 'child_process'],
  ['process', 'process'],
  ['effect/process', subprocessEffectFamily],
  ['module', 'module'],
  ['vm', 'vm'],
]);
const subprocessModuleFamily = (source: string): SubprocessFamily | undefined => {
  const normalized = source.replace(/^node:/u, '');
  for (const [module, family] of subprocessModules) {
    if (normalized === module || normalized.startsWith(`${module}/`)) {
      return family;
    }
  }
  return undefined;
};
const subprocessOperations = new Map<SubprocessFamily, ReadonlySet<string>>([
  ['path', new Set(['resolve', 'join'])],
  ['url', new Set(['fileURLToPath', 'pathToFileURL'])],
  ['child_process', new Set(['spawn'])],
  [subprocessEffectFamily, new Set(['make'])],
]);
const subprocessExportSlots = new Map<string, SubprocessSlot>([
  ['resolve', 'resolve'],
  ['join', 'join'],
  ['fileURLToPath', 'fileURLToPath'],
  ['pathToFileURL', 'pathToFileURL'],
  ['spawn', 'spawn'],
  ['make', 'make'],
  ['execPath', 'execPath'],
  ['pid', 'pid'],
  ['createRequire', 'createRequire'],
  ['syncBuiltinESMExports', 'syncBuiltinESMExports'],
]);
const subprocessImportCapability = (family: SubprocessFamily, exported: string): SubprocessCapability | undefined => {
  if (exported === 'default' || exported === '*') {
    return {
      authority: subprocessObjectAuthority,
      family,
      kind: 'object',
      slot: exported === '*' ? 'namespace' : 'default',
    };
  }
  if (family === subprocessEffectFamily && exported === 'ChildProcess') {
    return { authority: subprocessObjectAuthority, family, kind: 'object', slot: 'ChildProcess' };
  }
  const slot = subprocessExportSlots.get(exported);
  if (slot === undefined) {
    return undefined;
  }
  if (family === 'module' && (slot === 'createRequire' || slot === 'syncBuiltinESMExports')) {
    return { authority: subprocessDirectAuthority, family, kind: 'loader', slot };
  }
  if (family === 'process' && (slot === 'execPath' || slot === 'pid')) {
    return { authority: subprocessDirectAuthority, family, kind: 'scalar', slot };
  }
  return subprocessOperations.get(family)?.has(slot) === true
    ? { authority: subprocessDirectAuthority, family, kind: 'callable', slot }
    : undefined;
};
const subprocessProjection = (
  host: SubprocessCapability | undefined,
  member: string | undefined,
): SubprocessCapability | undefined => {
  if (host === undefined || member === undefined) {
    return undefined;
  }
  if (host.kind === 'loader' && host.slot === 'require' && member === 'resolve') {
    return { authority: subprocessDirectAuthority, family: 'module', kind: 'loader', slot: 'loader-resolve' };
  }
  if (host.kind !== 'object') {
    return undefined;
  }
  if (member === 'default' && host.slot === 'namespace') {
    return { authority: subprocessObjectAuthority, family: host.family, kind: 'object', slot: 'default' };
  }
  const projected = subprocessImportCapability(host.family, member);
  return projected === undefined ? undefined : { ...projected, authority: subprocessObjectAuthority };
};
const subprocessFactory = (capability: SubprocessCapability | undefined): boolean =>
  capability?.kind === 'callable' &&
  ((capability.family === 'child_process' && capability.slot === 'spawn') ||
    (capability.family === subprocessEffectFamily && capability.slot === 'make'));
const subprocessUnwrap = (node: Node | undefined): Node | undefined => {
  if (
    node?.type === 'TSAsExpression' ||
    node?.type === 'TSSatisfiesExpression' ||
    node?.type === 'TSNonNullExpression'
  ) {
    return subprocessUnwrap(node.expression);
  }
  return node;
};
const subprocessUnwrappedUse = (node: Node, initialParent: Node, parents: ReadonlyMap<Node, Node>) => {
  let use = node;
  let parent: Node | undefined = initialParent;
  while (
    parent?.type === 'TSAsExpression' ||
    parent?.type === 'TSSatisfiesExpression' ||
    parent?.type === 'TSNonNullExpression'
  ) {
    use = parent;
    parent = parents.get(parent);
  }
  return { parent, use };
};
const subprocessDirectCall = (use: Node, parent: Node | undefined): boolean =>
  parent?.type === 'CallExpression' && parent.callee === use && !parent.optional;
const subprocessImportReference = (node: Node, parent: Node, parents: ReadonlyMap<Node, Node>): boolean =>
  node.type === 'Identifier' &&
  nativeSubprocessRuntimeReference(node, parents) &&
  !nativeSubprocessBindingOrName(node, parent) &&
  parent.type !== 'ImportSpecifier' &&
  parent.type !== 'ImportDefaultSpecifier' &&
  parent.type !== 'ImportNamespaceSpecifier' &&
  parent.type !== 'LabeledStatement' &&
  parent.type !== 'BreakStatement' &&
  parent.type !== 'ContinueStatement';
interface SubprocessLexicalRegion {
  readonly node: Node;
  readonly start: number;
  readonly parent: SubprocessLexicalRegion | undefined;
  readonly depth: number;
  readonly bindings: Map<string, Node>;
}
interface SubprocessLexicalIndex {
  readonly regions: readonly SubprocessLexicalRegion[];
  readonly unavailable: boolean;
}
const subprocessLexicalCache = new WeakMap<Program, SubprocessLexicalIndex>();
const subprocessBindingIdentifiers = (raw: Node | undefined): Extract<Node, { type: 'Identifier' }>[] => {
  const node = subprocessUnwrap(raw);
  if (node?.type === 'Identifier') {
    return [node];
  }
  if (node?.type === 'AssignmentPattern') {
    return subprocessBindingIdentifiers(node.left);
  }
  if (node?.type === 'RestElement') {
    return subprocessBindingIdentifiers(node.argument);
  }
  if (node?.type === 'ArrayPattern') {
    return node.elements.flatMap((element) => subprocessBindingIdentifiers(element ?? undefined));
  }
  if (node?.type === 'ObjectPattern') {
    return node.properties.flatMap((property) =>
      subprocessBindingIdentifiers(property.type === 'Property' ? property.value : property.argument),
    );
  }
  return [];
};
// One binder index owns every adapter lookup. Opaque slots are declaration
// identifiers, distinct from absence; resolving one reaches the cycle guard.
// Parameters enclose the body, so body var declarations cannot hide a free
// capability acquired by a parameter initializer. Nearest regions always win.
const subprocessLexicalIndex = (program: Program): SubprocessLexicalIndex => {
  const cached = subprocessLexicalCache.get(program);
  if (cached !== undefined) return cached;
  const regions: SubprocessLexicalRegion[] = [];
  let unavailable = false;
  const region = (node: Node, parent?: SubprocessLexicalRegion, start = node.start): SubprocessLexicalRegion => {
    const result = { bindings: new Map<string, Node>(), depth: (parent?.depth ?? -1) + 1, node, parent, start };
    regions.push(result);
    return result;
  };
  const root = region(program);
  const bind = (raw: Node, owner: SubprocessLexicalRegion, value?: Node) => {
    const identifiers = subprocessBindingIdentifiers(raw);
    if (identifiers.length === 0 && raw.type !== 'ObjectPattern' && raw.type !== 'ArrayPattern') {
      unavailable = true;
    }
    for (const identifier of identifiers) {
      const existing = owner.bindings.get(identifier.name);
      const resolved = raw.type === 'Identifier' ? (value ?? identifier) : identifier;
      owner.bindings.set(identifier.name, existing === undefined ? resolved : identifier);
    }
  };
  const visit = (
    node: Node,
    lexical: SubprocessLexicalRegion,
    varOwner: SubprocessLexicalRegion,
    opaqueDeclaration = false,
  ): void => {
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (node.type === 'FunctionDeclaration' && node.id !== null) bind(node.id, lexical, node);
      if (node.body === null) return;
      let outer = lexical;
      if (node.type === 'FunctionExpression' && node.id !== null) {
        outer = region(node, lexical);
        bind(node.id, outer);
      }
      const parameters = region(node, outer);
      for (const parameter of node.params) {
        if (parameter.type === 'AssignmentPattern' && parameter.left.type === 'Identifier') {
          bind(parameter.left, parameters, parameter);
        } else {
          bind(parameter, parameters);
        }
      }
      for (const parameter of node.params) visit(parameter, parameters, varOwner);
      const body = region(node.body, parameters);
      if (node.body.type === 'BlockStatement') {
        for (const statement of node.body.body) visit(statement, body, body);
      } else {
        visit(node.body, body, body);
      }
      return;
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.type === 'ClassDeclaration' && node.id !== null) bind(node.id, lexical);
      const self = region(node, lexical);
      if (node.id !== null) bind(node.id, self);
      for (const child of nativeSubprocessChildren(node)) {
        if (child !== node.id) visit(child, self, varOwner);
      }
      return;
    }
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock') {
      const block = region(node, lexical);
      for (const child of nativeSubprocessChildren(node)) {
        visit(child, block, node.type === 'StaticBlock' ? block : varOwner);
      }
      return;
    }
    if (node.type === 'CatchClause') {
      const caught = region(node, lexical);
      if (node.param !== null) bind(node.param, caught);
      for (const child of nativeSubprocessChildren(node)) visit(child, caught, varOwner);
      return;
    }
    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const loop = region(node, lexical);
      const header = node.type === 'ForStatement' ? node.init : node.left;
      // Assignment headers write existing bindings; they never create a shadow.
      // This adapter does not interpret these writes, including destructuring.
      if (node.type !== 'ForStatement' && header?.type !== 'VariableDeclaration') unavailable = true;
      for (const child of nativeSubprocessChildren(node)) visit(child, loop, varOwner, child === header);
      return;
    }
    if (node.type === 'SwitchStatement') {
      // The discriminant is evaluated outside the switch lexical environment.
      visit(node.discriminant, lexical, varOwner);
      const switched = region(node, lexical, node.cases[0]?.start ?? node.end);
      for (const item of node.cases) visit(item, switched, varOwner);
      return;
    }
    if (node.type === 'TSModuleDeclaration' || node.type === 'TSEnumDeclaration' || node.type === 'Decorator') {
      // These runtime binders/evaluation environments are outside this index's
      // supported grammar; Unknown must not masquerade as an absent binding.
      unavailable = true;
    }
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      // Protected imports are resolved by the canonical inventory. Other value
      // imports still occupy slots, so a local `process` is never the global.
      if (subprocessModuleFamily(node.source.value) === undefined) {
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type') bind(specifier.local, lexical);
        }
      }
    }
    if (node.type === 'VariableDeclaration') {
      const owner = node.kind === 'var' ? varOwner : lexical;
      for (const declaration of node.declarations) {
        const value = node.kind === 'const' && !opaqueDeclaration ? (declaration.init ?? undefined) : undefined;
        bind(declaration.id, owner, value);
      }
    }
    for (const child of nativeSubprocessChildren(node)) visit(child, lexical, varOwner);
  };
  for (const statement of program.body) visit(statement, root, root);
  const result = { regions, unavailable };
  subprocessLexicalCache.set(program, result);
  return result;
};
const subprocessScope = (facts: SourceFacts, offset: number): ReadonlyMap<string, Node> => {
  const { regions } = subprocessLexicalIndex(facts.program);
  let innermost = regions[0];
  for (const candidate of regions) {
    if (candidate.start <= offset && offset < candidate.node.end && candidate.depth > (innermost?.depth ?? -1)) {
      innermost = candidate;
    }
  }
  const variables = new Map<string, Node>();
  let current: SubprocessLexicalRegion | undefined = innermost;
  while (current !== undefined) {
    for (const [name, value] of current.bindings) {
      if (!variables.has(name)) variables.set(name, value);
    }
    current = current.parent;
  }
  return variables;
};

const subprocessProcessRead = (member: string | undefined, consumer: Node | undefined): boolean =>
  (member === 'execPath' || member === 'pid') &&
  consumer?.type !== 'AssignmentExpression' &&
  consumer?.type !== 'UpdateExpression' &&
  !(consumer?.type === 'UnaryExpression' && consumer.operator === 'delete');
const subprocessObjectUse = (
  node: Node,
  initialParent: Node,
  capability: SubprocessCapability,
  parents: ReadonlyMap<Node, Node>,
): boolean => {
  const { parent, use } = subprocessUnwrappedUse(node, initialParent, parents);
  if (capability.kind === 'constructor') {
    return parent?.type === 'NewExpression' && parent.callee === use;
  }
  if (parent?.type !== 'MemberExpression' || parent.object !== use || parent.computed || parent.optional) {
    return false;
  }
  const member = propertyName(parent.property);
  const consumer = parents.get(parent);
  if (capability.family === 'process') {
    return subprocessProcessRead(member, consumer);
  }
  const operation = subprocessProjection(capability, member);
  return (operation?.kind === 'callable' || operation?.kind === 'loader') && subprocessDirectCall(parent, consumer);
};
// Ambient roots are loader-bearing objects. Close their first reference, not
// an eventual alias/container projection. The single ordinary leaf below is
// observed in the real consumer floor and grants no capability to its result.
const subprocessAmbientUse = (node: Node, parent: Node, parents: ReadonlyMap<Node, Node>): boolean => {
  const { parent: crypto, use } = subprocessUnwrappedUse(node, parent, parents);
  if (
    crypto?.type !== 'MemberExpression' ||
    crypto.object !== use ||
    crypto.computed ||
    crypto.optional ||
    propertyName(crypto.property) !== 'crypto'
  )
    return false;
  const operation = parents.get(crypto);
  if (
    operation?.type !== 'MemberExpression' ||
    operation.object !== crypto ||
    operation.computed ||
    operation.optional ||
    propertyName(operation.property) !== 'randomUUID'
  )
    return false;
  const call = parents.get(operation);
  return call?.type === 'CallExpression' && call.callee === operation && !call.optional && call.arguments.length === 0;
};
const subprocessGlobalCapability = (name: string): SubprocessCapability | undefined => {
  if (['globalThis', 'global', 'window', 'self'].includes(name)) {
    return { authority: subprocessObjectAuthority, family: 'module', kind: 'ambient', slot: 'global-object' };
  }
  if (name === 'process') {
    return { authority: subprocessObjectAuthority, family: 'process', kind: 'object', slot: 'default' };
  }
  if (name === 'URL') {
    return { authority: subprocessObjectAuthority, family: 'url', kind: 'constructor', slot: 'URL' };
  }
  if (name === 'require' || name === 'eval' || name === 'Function') {
    return { authority: subprocessDirectAuthority, family: 'module', kind: 'loader', slot: name };
  }
  if (name === 'module') {
    return { authority: subprocessObjectAuthority, family: 'module', kind: 'object', slot: 'default' };
  }
  return undefined;
};
const subprocessImportInventory = (facts: SourceFacts) => {
  const imports = new Map<string, SubprocessCapability>();
  const invalid = new Set<SubprocessFamily>();
  let unavailable = false;
  for (const statement of facts.program.body) {
    const family =
      statement.type === 'ImportDeclaration' && statement.importKind !== 'type'
        ? subprocessModuleFamily(statement.source.value)
        : undefined;
    if (statement.type === 'ImportDeclaration' && family !== undefined) {
      if (!subprocessModules.has(statement.source.value.replace(/^node:/u, '')) || family === 'vm') {
        invalid.add(family);
        unavailable = true;
      }
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') {
          continue;
        }
        let exported: string | undefined = '*';
        if (specifier.type === 'ImportSpecifier') {
          exported = propertyName(specifier.imported);
        } else if (specifier.type === 'ImportDefaultSpecifier') {
          exported = 'default';
        }
        const capability = exported === undefined ? undefined : subprocessImportCapability(family, exported);
        if (capability === undefined) {
          invalid.add(family);
          unavailable = true;
        } else {
          imports.set(specifier.local.name, capability);
        }
      }
    }
  }
  return { imports, invalid, unavailable };
};
interface SubprocessInvalidations {
  readonly invalid: Set<SubprocessFamily>;
  readonly invalidAliases: Set<Node>;
  readonly invalidNamed: Map<SubprocessFamily, Set<SubprocessSlot>>;
}
const subprocessLoaderReference = (
  capability: SubprocessCapability,
  consumer: Node | undefined,
  use: Node,
  parents: ReadonlyMap<Node, Node>,
): boolean => {
  const resolverUse =
    capability.slot === 'require' &&
    consumer?.type === 'MemberExpression' &&
    !consumer.computed &&
    !consumer.optional &&
    propertyName(consumer.property) === 'resolve' &&
    subprocessDirectCall(consumer, parents.get(consumer));
  return subprocessDirectCall(use, consumer) || resolverUse;
};
const subprocessCloseReference = (
  node: Node,
  parent: Node,
  capability: SubprocessCapability,
  facts: SourceFacts,
  parents: ReadonlyMap<Node, Node>,
  state: SubprocessInvalidations,
): boolean => {
  const { parent: consumer, use } = subprocessUnwrappedUse(node, parent, parents);
  if (capability.kind === 'ambient') {
    return !subprocessAmbientUse(node, parent, parents);
  }
  if (capability.kind === 'object' || capability.kind === 'constructor') {
    if (!subprocessObjectUse(node, parent, capability, parents)) {
      state.invalid.add(capability.family);
      // A process escape can expose getBuiltinModule/mainModule even when the
      // subprocess itself uses mise rather than process.execPath.
      if (capability.family === 'process') return true;
    }
  } else if (capability.kind === 'loader') {
    return !subprocessLoaderReference(capability, consumer, use, parents);
  } else if (
    capability.kind === 'callable' &&
    !subprocessDirectCall(use, consumer) &&
    !nativeSubprocessConstUse(use, consumer, parents) &&
    node.type === 'Identifier'
  ) {
    const binding = subprocessScope(facts, node.start).get(node.name);
    if (binding === undefined) {
      const slots = state.invalidNamed.get(capability.family) ?? new Set<SubprocessSlot>();
      slots.add(capability.slot);
      state.invalidNamed.set(capability.family, slots);
    } else {
      state.invalidAliases.add(binding);
    }
  }
  return false;
};
const subprocessOrdinaryTarget = (node: Node | undefined): boolean => {
  const target = staticString(subprocessUnwrap(node), new Map());
  return target !== undefined && subprocessModuleFamily(target) === undefined;
};
const subprocessFileModuleTarget = (
  raw: Node | undefined,
  facts: SourceFacts,
  identify: (node: Node | undefined) => SubprocessCapability | undefined,
): boolean => {
  const node = subprocessUnwrap(raw);
  if (node?.type !== 'MemberExpression' || node.computed || node.optional || propertyName(node.property) !== 'href') {
    return false;
  }
  const call = subprocessUnwrap(node.object);
  if (
    call?.type !== 'CallExpression' ||
    call.optional ||
    call.arguments.length !== 1 ||
    call.callee.type !== 'Identifier'
  ) {
    return false;
  }
  if (subprocessScope(facts, call.callee.start).has(call.callee.name)) {
    return false;
  }
  const capability = identify(call.callee);
  return capability?.family === 'url' && capability.slot === 'pathToFileURL';
};
const subprocessLoaderCall = (
  node: Extract<Node, { type: 'CallExpression' }>,
  parent: Node,
  parents: ReadonlyMap<Node, Node>,
  rawIdentity: (node: Node | undefined) => SubprocessCapability | undefined,
): boolean => {
  const capability = rawIdentity(node.callee);
  if (capability?.kind !== 'loader') {
    return true;
  }
  if (capability.slot !== 'createRequire') {
    return (
      (capability.slot === 'require' || capability.slot === 'loader-resolve') &&
      !node.optional &&
      node.arguments.length === 1 &&
      subprocessOrdinaryTarget(node.arguments[0])
    );
  }
  const result = rawIdentity(node);
  const resolved =
    parent.type === 'MemberExpression' &&
    parent.object === node &&
    propertyName(parent.property) === 'resolve' &&
    subprocessDirectCall(parent, parents.get(parent));
  return (
    result !== undefined &&
    (nativeSubprocessConstUse(node, parent, parents) || subprocessDirectCall(node, parent) || resolved)
  );
};
const subprocessLoaderNode = (
  node: Node,
  parent: Node,
  facts: SourceFacts,
  parents: ReadonlyMap<Node, Node>,
  rawIdentity: (node: Node | undefined) => SubprocessCapability | undefined,
  identify: (node: Node | undefined) => SubprocessCapability | undefined,
): boolean => {
  if (node.type === 'ImportExpression') {
    return subprocessOrdinaryTarget(node.source) || subprocessFileModuleTarget(node.source, facts, identify);
  }
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
    return (
      node.source === null || node.exportKind === 'type' || subprocessModuleFamily(node.source.value) === undefined
    );
  }
  if (node.type === 'TSImportEqualsDeclaration') {
    return false;
  }
  if (node.type === 'CallExpression') {
    return subprocessLoaderCall(node, parent, parents, rawIdentity);
  }
  return true;
};
const subprocessLoaderBoundary = (
  facts: SourceFacts,
  parents: ReadonlyMap<Node, Node>,
  rawIdentity: (node: Node | undefined) => SubprocessCapability | undefined,
  identify: (node: Node | undefined) => SubprocessCapability | undefined,
  initial: boolean,
): boolean => {
  if (initial) {
    return true;
  }
  for (const [node, parent] of parents) {
    if (
      nativeSubprocessRuntimeReference(node, parents) &&
      !subprocessLoaderNode(node, parent, facts, parents, rawIdentity, identify)
    ) {
      return true;
    }
  }
  return false;
};
const subprocessCapabilityProof = (facts: SourceFacts, mutable: ReadonlySet<string>) => {
  const parents = nativeSubprocessParents(facts.program);
  const inventory = subprocessImportInventory(facts);
  const { imports, invalid } = inventory;
  const invalidAliases = new Set<Node>();
  const invalidNamed = new Map<SubprocessFamily, Set<SubprocessSlot>>();
  let unavailable = inventory.unavailable || subprocessLexicalIndex(facts.program).unavailable;
  const rawIdentity = (raw: Node | undefined, seen = new Set<Node>()): SubprocessCapability | undefined => {
    const node = subprocessUnwrap(raw);
    if (node === undefined || seen.has(node)) {
      return undefined;
    }
    const visited = new Set(seen).add(node);
    if (node.type === 'Identifier') {
      const scope = subprocessScope(facts, node.start);
      if (scope.has(node.name)) {
        return rawIdentity(scope.get(node.name), visited);
      }
      return imports.get(node.name) ?? subprocessGlobalCapability(node.name);
    }
    if (node.type === 'MemberExpression' && !node.computed && !node.optional) {
      return subprocessProjection(rawIdentity(node.object, visited), propertyName(node.property));
    }
    if (node.type === 'CallExpression' && !node.optional) {
      const callee = rawIdentity(node.callee, visited);
      if (callee?.family === 'module' && callee.slot === 'createRequire') {
        return { authority: subprocessDirectAuthority, family: 'module', kind: 'loader', slot: 'require' };
      }
    }
    return undefined;
  };
  // Pass one closes ALL capability references before any values, origins or facts.
  for (const [node, parent] of parents) {
    if (subprocessImportReference(node, parent, parents)) {
      const capability = rawIdentity(node);
      if (capability !== undefined) {
        const escapedLoader = subprocessCloseReference(node, parent, capability, facts, parents, {
          invalid,
          invalidAliases,
          invalidNamed,
        });
        unavailable ||= escapedLoader;
      }
    }
  }
  const identify = (raw: Node | undefined, seen = new Set<Node>()): SubprocessCapability | undefined => {
    const node = subprocessUnwrap(raw);
    if (node === undefined || seen.has(node)) {
      return undefined;
    }
    const visited = new Set(seen).add(node);
    let capability: SubprocessCapability | undefined;
    if (node.type === 'Identifier') {
      if (mutable.has(node.name)) {
        return undefined;
      }
      const scope = subprocessScope(facts, node.start);
      const binding = scope.get(node.name);
      if (binding !== undefined && invalidAliases.has(binding)) {
        return undefined;
      }
      capability = scope.has(node.name)
        ? identify(binding, visited)
        : (imports.get(node.name) ?? subprocessGlobalCapability(node.name));
    } else if (node.type === 'MemberExpression' && !node.computed && !node.optional) {
      capability = subprocessProjection(identify(node.object, visited), propertyName(node.property));
    }
    if (capability === undefined) {
      return undefined;
    }
    const unavailableObject = capability.authority === subprocessObjectAuthority && invalid.has(capability.family);
    const unavailableNamed =
      capability.authority === subprocessDirectAuthority &&
      invalidNamed.get(capability.family)?.has(capability.slot) === true;
    return unavailableObject || unavailableNamed ? undefined : capability;
  };
  unavailable = subprocessLoaderBoundary(
    facts,
    parents,
    rawIdentity,
    identify,
    unavailable || invalid.has('module') || invalid.has('vm'),
  );
  return { identify, unavailable };
};
const subprocessDataOrigin = (raw: Node | undefined, facts: SourceFacts, seen = new Set<Node>()): Node | undefined => {
  const node = subprocessUnwrap(raw);
  if (node === undefined || seen.has(node)) {
    return undefined;
  }
  if (node.type === 'Identifier') {
    return subprocessDataOrigin(subprocessScope(facts, node.start).get(node.name), facts, new Set(seen).add(node));
  }
  return node.type === 'ArrayExpression' || node.type === 'ObjectExpression' ? node : undefined;
};
const subprocessDataInvalidations = (
  facts: SourceFacts,
  identify: (node: Node | undefined) => SubprocessCapability | undefined,
): Set<Node> => {
  const invalid = new Set<Node>();
  const parents = nativeSubprocessParents(facts.program);
  for (const [node, parent] of parents) {
    const relevant = node.type === 'Identifier' || node.type === 'ArrayExpression' || node.type === 'ObjectExpression';
    if (relevant && !nativeSubprocessBindingOrName(node, parent) && nativeSubprocessRuntimeReference(node, parents)) {
      const origin = subprocessDataOrigin(node, facts);
      if (origin === undefined) {
        continue;
      }
      const { parent: consumer, use } = subprocessUnwrappedUse(node, parent, parents);
      const argument =
        consumer?.type === 'CallExpression' &&
        subprocessFactory(identify(consumer.callee)) &&
        (consumer.arguments[1] === use || consumer.arguments[2] === use);
      if (!argument && !nativeSubprocessConstUse(use, consumer, parents)) {
        invalid.add(origin);
      }
    }
  }
  return invalid;
};

const nativeSubprocessEvidence = (
  facts: SourceFacts,
  workspace: string,
  appRoot: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const mutable = new Set<string>();
  const calls: Extract<Node, { type: 'CallExpression' }>[] = [];
  const invalidate = (node: Node) => {
    if (node.type === 'Identifier') {
      mutable.add(node.name);
    } else if (node.type === 'MemberExpression') {
      invalidate(node.object);
    } else {
      new Visitor({ Identifier: (identifier) => mutable.add(identifier.name) }).visit(node);
    }
  };
  new Visitor({
    AssignmentExpression: (node) => invalidate(node.left),
    CallExpression: (node) => calls.push(node),
    UpdateExpression: (node) => invalidate(node.argument),
    VariableDeclaration: (node) => {
      if (node.kind !== 'const') {
        for (const declaration of node.declarations) {
          invalidate(declaration.id);
        }
      }
    },
  }).visit(facts.program);
  const proof = subprocessCapabilityProof(facts, mutable);
  if (proof.unavailable) {
    return [];
  }
  const importedIdentity = proof.identify;
  const possibleFactory = (raw: Node | undefined): boolean => subprocessFactory(importedIdentity(raw));
  const mutableObjects = subprocessDataInvalidations(facts, importedIdentity);
  const parameters = new Map<Node, { index: number; name: string; owner: Node }>();
  for (const [name, owner] of facts.variables) {
    if (owner.type !== 'ArrowFunctionExpression' || mutable.has(name)) {
      continue;
    }
    owner.params.forEach((parameter, index) => {
      if (parameter.type === 'AssignmentPattern') {
        parameters.set(parameter, { index, name, owner });
      }
    });
  }
  const values = (raw: Node | undefined, seen = new Set<Node>()): Node[] => {
    if (raw === undefined || seen.has(raw)) {
      return [];
    }
    const visited = new Set(seen).add(raw);
    if (mutableObjects.has(raw)) {
      return [];
    }
    if (raw.type === 'Identifier') {
      return mutable.has(raw.name) ? [] : values(subprocessScope(facts, raw.start).get(raw.name), visited);
    }
    if (raw.type === 'TSAsExpression' || raw.type === 'TSSatisfiesExpression' || raw.type === 'TSNonNullExpression') {
      return values(raw.expression, visited);
    }
    if (raw.type !== 'AssignmentPattern') {
      return [raw];
    }
    const parameter = parameters.get(raw);
    if (parameter === undefined) {
      return [];
    }
    return calls.flatMap((call) => {
      if (call.callee.type !== 'Identifier' || call.callee.name !== parameter.name) {
        return [];
      }
      const scope = subprocessScope(facts, call.start);
      if (scope.get(parameter.name) !== parameter.owner) {
        return [];
      }
      const argument = call.arguments[parameter.index];
      const candidates = argument === undefined ? values(raw.right, visited) : values(argument, visited);
      return candidates.filter((candidate) => staticString(candidate, new Map()) !== undefined);
    });
  };
  const ownerRoot = path.resolve(appRoot, workspace === '.' ? '' : workspace);
  const sourceFile = path.resolve(appRoot, facts.file);
  const evidence: KnipModelEvidence[] = [];
  const record = (call: Extract<Node, { type: 'CallExpression' }>) => {
    if (!possibleFactory(call.callee)) {
      return;
    }
    const immutableValue = (raw: Node | undefined): Node | undefined => {
      const candidates = values(raw);
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const literalStrings = (raw: Node | undefined): string[] =>
      values(raw).flatMap((value) => {
        const literal = staticString(value, new Map());
        return literal === undefined ? [] : [literal];
      });
    const identity = (raw: Node | undefined) => importedIdentity(raw);
    const factory = identity(call.callee);
    if (!subprocessFactory(factory)) {
      return;
    }
    const executableCapability = identity(call.arguments[0]);
    const nodeExecutable = executableCapability?.family === 'process' && executableCapability.slot === 'execPath';
    const executable = literalStrings(call.arguments[0]);
    const miseExecutable =
      factory?.family === subprocessEffectFamily &&
      factory.slot === 'make' &&
      executable.length === 1 &&
      executable[0] === 'mise';
    if (!nodeExecutable && !miseExecutable) {
      return;
    }
    const argv = immutableValue(call.arguments[1]);
    if (argv?.type !== 'ArrayExpression') {
      return;
    }
    const urlPaths = (raw: Node | undefined): string[] => {
      if (miseExecutable && raw?.type !== 'NewExpression') {
        return [];
      }
      const url = immutableValue(raw);
      if (
        url?.type !== 'NewExpression' ||
        identity(url.callee)?.kind !== 'constructor' ||
        url.arguments.length !== 2 ||
        !importedUrlBase(url.arguments[1])
      ) {
        return [];
      }
      return literalStrings(url.arguments[0]).flatMap((target) =>
        /^(?:\.\.?\/)+/u.test(target) && !/[?#%]/u.test(target) ? [path.resolve(path.dirname(sourceFile), target)] : [],
      );
    };
    const resolvePaths = (raw: Node | undefined, cwd: string, seen = new Set<Node>()): string[] =>
      values(raw).flatMap((value) => {
        if (seen.has(value)) {
          return [];
        }
        const visited = new Set(seen).add(value);
        const literal = staticString(value, new Map());
        if (literal !== undefined) {
          return [path.resolve(cwd, literal)];
        }
        if (value.type === 'MemberExpression' && !value.computed) {
          if (
            propertyName(value.property) === 'dirname' &&
            value.object.type === 'MetaProperty' &&
            value.object.meta.name === 'import' &&
            value.object.property.name === 'meta'
          ) {
            return [path.dirname(sourceFile)];
          }
          if (propertyName(value.property) === 'pathname') {
            return urlPaths(value.object);
          }
        }
        if (value.type !== 'CallExpression') {
          return [];
        }
        const operation = identity(value.callee);
        if (operation?.family === 'url' && operation.slot === 'fileURLToPath') {
          return value.arguments.length === 1 ? urlPaths(value.arguments[0]) : [];
        }
        if (operation?.family !== 'path' || (operation.slot !== 'resolve' && operation.slot !== 'join')) {
          return [];
        }
        const segments = value.arguments.map((argument) => {
          const literals = literalStrings(argument);
          return literals.length > 0 ? literals : resolvePaths(argument, cwd, visited);
        });
        if (!segments.every((segment) => segment.length === 1)) {
          return [];
        }
        const parts = segments.flat();
        return [operation.slot === 'join' ? path.resolve(cwd, path.join(...parts)) : path.resolve(cwd, ...parts)];
      });
    const commandDirectories = (raw: Node | undefined): string[] => {
      const optionsValue = immutableValue(raw);
      const options = optionsValue?.type === 'ObjectExpression' ? optionsValue : undefined;
      if (raw !== undefined && options === undefined) {
        return [];
      }
      if (options?.properties.some((property) => property.type !== 'Property' || property.computed)) {
        return [];
      }
      if (
        (options?.properties.filter((property) => property.type === 'Property' && propertyName(property.key) === 'cwd')
          .length ?? 0) > 1
      ) {
        return [];
      }
      const cwdProperty = options?.properties.find(
        (property) => property.type === 'Property' && propertyName(property.key) === 'cwd',
      );
      if (cwdProperty?.type === 'Property' && cwdProperty.kind !== 'init') {
        return [];
      }
      const directories = cwdProperty?.type === 'Property' ? resolvePaths(cwdProperty.value, ownerRoot) : [ownerRoot];
      return directories;
    };
    const directories = commandDirectories(call.arguments[2]);
    if (directories.length === 0) {
      return;
    }
    if (miseExecutable) {
      const input = esbuildSubprocessInput(argv.elements, literalStrings, immutableValue);
      if (input === undefined || directories.length !== 1) {
        return;
      }
      const target = path.resolve(directories[0] ?? ownerRoot, input);
      if (/\.[cm]?[jt]s$/u.test(target)) {
        evidence.push(
          evidenceAt(
            facts,
            workspace,
            'file',
            path.relative(ownerRoot, target),
            call.start,
            'Native esbuild subprocess bundles this exact input with its declared working directory',
          ),
        );
      }
      return;
    }
    const recordNodeSource = () => {
      for (const argument of argv.elements) {
        const argumentOptions = literalStrings(argument ?? undefined);
        if (
          argumentOptions.length === 1 &&
          ['--experimental-strip-types', '--enable-source-maps', '--no-warnings'].includes(argumentOptions[0])
        ) {
          continue;
        }
        if (argumentOptions.some((option) => option.startsWith('-'))) {
          return;
        }
        for (const cwd of directories) {
          for (const target of resolvePaths(argument ?? undefined, cwd)) {
            if (/\.[cm]?[jt]s$/u.test(target)) {
              evidence.push(
                evidenceAt(
                  facts,
                  workspace,
                  'file',
                  path.relative(ownerRoot, target),
                  call.start,
                  'Native Node subprocess executes this source with its declared working directory',
                ),
              );
            }
          }
        }
        return;
      }
    };
    recordNodeSource();
  };
  new Visitor({ CallExpression: record }).visit(facts.program);
  return evidence;
};

const isJoinedSourceSpecifier = (
  node: Node | undefined,
  directory: string,
  file: string,
  variables: ReadonlyMap<string, Node>,
): boolean =>
  node?.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  propertyName(node.callee.property) === 'join' &&
  node.arguments[0]?.type === 'Identifier' &&
  node.arguments[0].name === directory &&
  staticString(node.arguments[1], variables) === file;

const sourceEvidence = (
  facts: SourceFacts,
  workspace: string,
  directory: string,
  path: Path.Path,
  appRoot: string,
): KnipModelEvidence[] => {
  const result = [
    ...federationEvidence(facts, workspace),
    ...generatedActionContractEvidence(facts, workspace),
    ...generatedActionPrincipalEvidence(facts, workspace),
    ...generatedActionGatewayEvidence(facts, workspace),
    ...nativeSubprocessEvidence(facts, workspace, appRoot, path),
  ];
  const manualCommand = `Usage: node ${facts.file} `;
  if (
    facts.file === 'tools/oxlint/effect-native/tests/run-on-repo.mts' &&
    facts.source.slice(0, facts.source.indexOf('*/')).includes(manualCommand)
  ) {
    result.push(
      evidenceAt(
        facts,
        workspace,
        'entry',
        facts.file,
        facts.source.indexOf(manualCommand),
        'Documented manual diagnostic CLI; operator entry, not proof of CI execution',
      ),
    );
  }
  const recordUrl = (node: Extract<Node, { type: 'NewExpression' }>) => {
    if (node.callee.type !== 'Identifier' || node.callee.name !== 'URL' || !importedUrlBase(node.arguments[1])) {
      return;
    }
    const target = staticString(node.arguments[0], scopedVariables(facts, node.start));
    if (target !== undefined && !target.includes(':')) {
      result.push(
        evidenceAt(
          facts,
          workspace,
          'file',
          path.join(directory, target),
          node.start,
          'Static source URL consumed relative to import.meta.url',
        ),
      );
    }
  };
  const recordLintConfig = (node: Extract<Node, { type: 'CallExpression' }>) => {
    const consumers = new Map([
      ['tools/oxlint/effect-native/report.mts', 'report.config.ts'],
      ['tools/oxlint/effect-native/repository-policy.mts', 'repository-policy.config.ts'],
    ]);
    const config = consumers.get(facts.file);
    const [joined] = node.arguments;
    if (
      config === undefined ||
      node.callee.type !== 'Identifier' ||
      node.callee.name !== 'runOxlint' ||
      joined?.type !== 'CallExpression' ||
      staticString(joined.arguments[1], facts.variables) !== config
    ) {
      return;
    }
    const target = `tools/oxlint/effect-native/${config}`;
    result.push(
      evidenceAt(facts, workspace, 'file', target, node.start, 'Lint subprocess configuration'),
      evidenceAt(
        facts,
        workspace,
        'export',
        `${target}#default`,
        node.start,
        'Oxlint loader consumes the configuration default export',
      ),
    );
  };
  const recordLintPlugin = (node: ObjectExpression) => {
    const specifier = objectValue(node, 'specifier');
    if (
      facts.file !== 'tools/oxlint/effect-native/tests/shared-helpers.test.mts' ||
      staticString(objectValue(node, 'name'), facts.variables) !== 'shared-helpers-probe' ||
      !isJoinedSourceSpecifier(specifier, 'testsDirectory', 'shared-helpers-probe.ts', facts.variables)
    ) {
      return;
    }
    const target = 'tools/oxlint/effect-native/tests/shared-helpers-probe.ts';
    result.push(
      evidenceAt(facts, workspace, 'file', target, node.start, 'Oxlint jsPlugins source specifier'),
      evidenceAt(
        facts,
        workspace,
        'export',
        `${target}#default`,
        node.start,
        'Oxlint jsPlugins loader consumes only the plugin default export',
      ),
    );
  };
  const recordCall = (node: Extract<Node, { type: 'CallExpression' }>) => {
    recordLintConfig(node);
  };
  new Visitor({
    CallExpression: recordCall,
    NewExpression: recordUrl,
    ObjectExpression: recordLintPlugin,
  }).visit(facts.program);
  result.push(...rstestEnvironmentEvidence(facts, workspace));
  if (facts.file === 'scripts/quality-audit.mts') {
    const recordAuditStep = (node: ObjectExpression) => {
      const tool = staticString(objectValue(node, 'tool'), facts.variables);
      if (tool !== undefined && objectValue(node, 'args') !== undefined && objectValue(node, 'name') !== undefined) {
        result.push(evidenceAt(facts, workspace, 'dependency', tool, node.start, 'Quality audit subprocess step'));
      }
    };
    new Visitor({ ObjectExpression: recordAuditStep }).visit(facts.program);
  }
  return result;
};

const drizzleFactories = (facts: SourceFacts): ReadonlySet<string> => {
  const imports = facts.program.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.source.value === 'drizzle-orm/pg-core',
  );
  return new Set(
    imports.flatMap((node) =>
      node.type === 'ImportDeclaration'
        ? node.specifiers.flatMap((specifier) =>
            specifier.type === 'ImportSpecifier' &&
            ['pgSchema', 'pgTable', 'pgEnum', 'pgSequence', 'pgView', 'pgMaterializedView'].includes(
              propertyName(specifier.imported) ?? '',
            )
              ? [specifier.local.name]
              : [],
          )
        : [],
    ),
  );
};

const drizzleTableReceiver = (callee: Extract<Node, { type: 'MemberExpression' }>): Node | undefined => {
  if (propertyName(callee.property) === 'table') {
    return callee.object;
  }
  if (
    propertyName(callee.property) === 'withRLS' &&
    callee.object.type === 'MemberExpression' &&
    propertyName(callee.object.property) === 'table'
  ) {
    return callee.object.object;
  }
  return undefined;
};

const importedDrizzleDeclaration = (
  facts: SourceFacts,
  localName: string,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  path: Path.Path,
): { readonly facts: SourceFacts; readonly node: Node | undefined } | undefined => {
  const statement = facts.program.body.find(
    (candidate) =>
      candidate.type === 'ImportDeclaration' &&
      candidate.source.value.startsWith('.') &&
      candidate.specifiers.some(
        (specifier) => specifier.type === 'ImportSpecifier' && specifier.local.name === localName,
      ),
  );
  if (statement?.type !== 'ImportDeclaration') {
    return undefined;
  }
  const imported = statement.specifiers.find(
    (specifier) => specifier.type === 'ImportSpecifier' && specifier.local.name === localName,
  );
  if (imported?.type !== 'ImportSpecifier') {
    return undefined;
  }
  const targetPath = path.normalize(path.join(path.dirname(facts.file), statement.source.value)).replaceAll('\\', '/');
  const target = factsByPath.get(targetPath);
  const importedName = propertyName(imported.imported);
  return target === undefined || importedName === undefined
    ? undefined
    : { facts: target, node: target.variables.get(importedName) };
};

const isDrizzleDeclaration = (
  node: Node | undefined,
  facts: SourceFacts,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  path: Path.Path,
  depth = 0,
): boolean => {
  const expression = unwrap(node, facts.variables);
  if (expression?.type !== 'CallExpression' || depth > 5) {
    return false;
  }
  if (expression.callee.type === 'Identifier') {
    return drizzleFactories(facts).has(expression.callee.name);
  }
  if (expression.callee.type !== 'MemberExpression') {
    return false;
  }
  const receiver = drizzleTableReceiver(expression.callee);
  if (receiver === undefined) {
    return false;
  }
  const schema =
    receiver.type === 'Identifier' && !facts.variables.has(receiver.name)
      ? receiver
      : unwrap(receiver, facts.variables);
  if (schema?.type === 'CallExpression') {
    return isDrizzleDeclaration(schema, facts, factsByPath, path, depth + 1);
  }
  if (schema?.type !== 'Identifier') {
    return false;
  }
  const imported = importedDrizzleDeclaration(facts, schema.name, factsByPath, path);
  return imported !== undefined && isDrizzleDeclaration(imported.node, imported.facts, factsByPath, path, depth + 1);
};

const reflectedDrizzleExport = (
  facts: SourceFacts,
  node: Node,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
  configSource: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  if (node.type !== 'ExportNamedDeclaration') {
    return [];
  }
  const reason = `Drizzle reflective schema consumer configured by ${configSource}`;
  if (node.declaration?.type === 'VariableDeclaration') {
    return node.declaration.declarations.flatMap((declaration) =>
      declaration.id.type === 'Identifier' &&
      declaration.init !== null &&
      isDrizzleDeclaration(declaration.init, facts, factsByPath, path)
        ? [evidenceAt(facts, workspace, 'export', `${facts.file}#${declaration.id.name}`, declaration.start, reason)]
        : [],
    );
  }
  if (node.source?.type !== 'Literal' || !isString(node.source.value) || !node.source.value.startsWith('.')) {
    return [];
  }
  const targetPath = path.normalize(path.join(path.dirname(facts.file), node.source.value)).replaceAll('\\', '/');
  const target = factsByPath.get(targetPath);
  if (target === undefined) {
    return [];
  }
  return node.specifiers.flatMap((specifier) => {
    const importedName = propertyName(specifier.local);
    const exportedName = propertyName(specifier.exported);
    return specifier.type === 'ExportSpecifier' &&
      node.exportKind !== 'type' &&
      specifier.exportKind !== 'type' &&
      importedName !== undefined &&
      exportedName !== undefined &&
      isDrizzleDeclaration(target.variables.get(importedName), target, factsByPath, path)
      ? [evidenceAt(facts, workspace, 'export', `${facts.file}#${exportedName}`, specifier.start, reason)]
      : [];
  });
};

const reflectedDrizzleExports = (
  facts: SourceFacts,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
  configSource: string,
  path: Path.Path,
): KnipModelEvidence[] =>
  facts.program.body.flatMap((node) => reflectedDrizzleExport(facts, node, factsByPath, workspace, configSource, path));

const resolver = createRequire(import.meta.url);
const packageName = (specifier: string): string =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? specifier);

const isRequireResolve = (node: Node): boolean =>
  node.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  node.callee.object.type === 'Identifier' &&
  node.callee.object.name === 'require' &&
  !node.callee.computed &&
  propertyName(node.callee.property) === 'resolve';

const isPathJoin = (node: Node): boolean =>
  node.type === 'MemberExpression' &&
  !node.computed &&
  node.object.type === 'Identifier' &&
  node.object.name === 'path' &&
  ['join', 'resolve'].includes(propertyName(node.property) ?? '');

const resolverAnchor = (
  node: Extract<Node, { type: 'CallExpression' }>,
  variables: ReadonlyMap<string, Node>,
): Node | undefined => {
  const options = objectExpression(node.arguments[1], variables);
  const anchors = unwrap(objectValue(options, 'paths'), variables);
  return anchors?.type === 'ArrayExpression' && anchors.elements.length === 1
    ? (anchors.elements[0] ?? undefined)
    : undefined;
};

const resolveInstalledDependency = (dependency: string, anchor: string): string | undefined => {
  try {
    return resolver.resolve(dependency, { paths: [anchor] });
  } catch {
    return undefined;
  }
};

const resolveStaticCall = (
  value: Extract<Node, { type: 'CallExpression' }>,
  variables: ReadonlyMap<string, Node>,
  resolvePath: (node: Node | undefined) => string | undefined,
): string | undefined => {
  const target = staticString(value.arguments[0], variables);
  const anchor = resolverAnchor(value, variables);
  if (target === undefined || anchor === undefined) {
    return undefined;
  }
  const resolvedAnchor = resolvePath(anchor);
  return resolvedAnchor === undefined ? undefined : resolveInstalledDependency(target, resolvedAnchor);
};

const isImportMetaUrl = (node: Node | undefined): node is Extract<Node, { type: 'NewExpression' }> =>
  node?.type === 'NewExpression' &&
  node.callee.type === 'Identifier' &&
  node.callee.name === 'URL' &&
  importedUrlBase(node.arguments[1]);

const resolveJoinedPath = (
  value: Extract<Node, { type: 'CallExpression' }>,
  path: Path.Path,
  resolvePath: (node: Node) => string | undefined,
): string | undefined => {
  if (!isPathJoin(value.callee)) {
    return undefined;
  }
  const segments = value.arguments.map((argument) => resolvePath(argument));
  if (segments.some((segment) => segment === undefined)) {
    return undefined;
  }
  return path.resolve(...segments.filter(isString));
};

const staticPath = (
  node: Node | undefined,
  variables: ReadonlyMap<string, Node>,
  file: string,
  path: Path.Path,
  depth = 0,
): string | undefined => {
  if (depth > 12) {
    return undefined;
  }
  const value = unwrap(node, variables);
  const literal = staticString(value, variables);
  if (literal !== undefined) {
    return literal;
  }
  if (isImportMetaUrl(value)) {
    const target = staticString(value.arguments[0], variables);
    return target === undefined ? undefined : path.resolve(path.dirname(file), target);
  }
  if (value?.type !== 'CallExpression') {
    return undefined;
  }
  if (value.callee.type === 'Identifier' && value.callee.name === 'fileURLToPath') {
    return staticPath(value.arguments[0], variables, file, path, depth + 1);
  }
  if (isRequireResolve(value)) {
    return resolveStaticCall(value, variables, (argument) => staticPath(argument, variables, file, path, depth + 1));
  }
  return resolveJoinedPath(value, path, (argument) => staticPath(argument, variables, file, path, depth + 1));
};

const hasNativeRequire = (facts: SourceFacts, variables: ReadonlyMap<string, Node>): boolean => {
  const binding = variables.get('require');
  if (
    binding?.type !== 'CallExpression' ||
    binding.callee.type !== 'Identifier' ||
    binding.callee.name !== 'createRequire'
  ) {
    return false;
  }
  return facts.program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.source.value === 'node:module' &&
      node.specifiers.some(
        (specifier) =>
          specifier.type === 'ImportSpecifier' &&
          propertyName(specifier.imported) === 'createRequire' &&
          specifier.local.name === 'createRequire',
      ),
  );
};

const resolverEvidence = (
  facts: SourceFacts,
  workspace: string,
  appRoot: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const evidence: KnipModelEvidence[] = [];
  const recordResolver = (node: Extract<Node, { type: 'CallExpression' }>) => {
    if (!isRequireResolve(node)) {
      return;
    }
    const variables = scopedVariables(facts, node.start);
    if (!hasNativeRequire(facts, variables)) {
      return;
    }
    const target = staticString(node.arguments[0], variables);
    if (target === undefined || target.startsWith('.') || target.startsWith('node:')) {
      return;
    }
    const anchor = staticPath(resolverAnchor(node, variables), variables, path.join(appRoot, facts.file), path);
    const resolved = staticPath(node, variables, path.join(appRoot, facts.file), path);
    if (anchor === undefined || resolved === undefined) {
      return;
    }
    evidence.push({
      ...evidenceAt(
        facts,
        workspace,
        'resolver',
        packageName(target),
        node.arguments[0]?.start ?? node.start,
        `Explicit require.resolve paths anchor ${anchor}; resolves to ${resolved}`,
      ),
      anchor,
      resolved,
    });
  };
  new Visitor({ CallExpression: recordResolver }).visit(facts.program);
  return evidence;
};

interface NativeResolverOwner {
  readonly appRoot: string;
  readonly manifest: typeof PackageSchema.Type;
  readonly manifestFile: string;
  readonly manifestText: string;
  readonly path: Path.Path;
  readonly workspace: string;
}

const nativeResolverUrlUse = (node: Node, parent: Node, parents: ReadonlyMap<Node, Node>): boolean => {
  if (parent.type === 'NewExpression') {
    return parent.callee === node;
  }
  return (
    parent.type === 'MemberExpression' &&
    parent.object === node &&
    !parent.computed &&
    !parent.optional &&
    propertyName(parent.property) === 'parse' &&
    subprocessDirectCall(parent, parents.get(parent))
  );
};

const nativeResolverUnsafeReference = (
  node: Node,
  parent: Node,
  facts: SourceFacts,
  parents: ReadonlyMap<Node, Node>,
  factories: ReadonlySet<string>,
): boolean => {
  if (node.type === 'ImportDeclaration' && node.source.value.replace(/^node:/u, '') === 'module') {
    return node.specifiers.some(
      (specifier) => specifier.type !== 'ImportSpecifier' || propertyName(specifier.imported) !== 'createRequire',
    );
  }
  if (
    node.type !== 'Identifier' ||
    !nativeSubprocessRuntimeReference(node, parents) ||
    nativeSubprocessBindingOrName(node, parent) ||
    parent.type === 'ImportSpecifier'
  ) {
    return false;
  }
  const scope = subprocessScope(facts, node.start);
  if (scope.has(node.name)) {
    return false;
  }
  if (factories.has(node.name)) {
    return !subprocessDirectCall(node, parent);
  }
  if (['eval', 'Function'].includes(node.name)) {
    return true;
  }
  return node.name === 'URL' && !nativeResolverUrlUse(node, parent, parents);
};

interface NativeResolverBindings {
  readonly factories: ReadonlySet<string>;
  readonly mutable: ReadonlySet<string>;
  readonly parents: ReadonlyMap<Node, Node>;
}

const nativeResolverBindingState = (facts: SourceFacts): NativeResolverBindings | undefined => {
  const factories = new Set(
    facts.program.body.flatMap((statement) =>
      statement.type === 'ImportDeclaration' &&
      statement.importKind !== 'type' &&
      statement.source.value === 'node:module'
        ? statement.specifiers.flatMap((specifier) =>
            specifier.type === 'ImportSpecifier' &&
            specifier.importKind !== 'type' &&
            propertyName(specifier.imported) === 'createRequire'
              ? [specifier.local.name]
              : [],
          )
        : [],
    ),
  );
  if (factories.size === 0) {
    return undefined;
  }
  const parents = nativeSubprocessParents(facts.program);
  const mutable = new Set<string>();
  let unsafe = subprocessLexicalIndex(facts.program).unavailable;
  for (const [node, parent] of parents) {
    if (node.type === 'VariableDeclaration' && node.kind !== 'const') {
      for (const declaration of node.declarations) {
        for (const binding of subprocessBindingIdentifiers(declaration.id)) {
          mutable.add(binding.name);
        }
      }
    }
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const target = node.type === 'AssignmentExpression' ? node.left : node.argument;
      for (const [child] of parents) {
        if (child.type === 'Identifier' && child.start >= target.start && child.end <= target.end) {
          mutable.add(child.name);
        }
      }
      unsafe ||= target.type === 'MemberExpression' && propertyName(target.property) === 'URL';
    }
    unsafe ||= nativeResolverUnsafeReference(node, parent, facts, parents, factories);
  }
  return unsafe ? undefined : { factories, mutable, parents };
};

// Finite annotations constrain table keys; opaque schema/indexed types stay unproven.
const nativeResolverKeys = (
  facts: SourceFacts,
  mutable: ReadonlySet<string>,
  raw: Node | undefined,
  seen = new Set<Node>(),
): string[] => {
  const node = subprocessUnwrap(raw);
  if (node === undefined || seen.has(node)) {
    return [];
  }
  const visited = new Set(seen).add(node);
  if (node.type === 'Identifier') {
    if (mutable.has(node.name)) {
      return [];
    }
    const binding = subprocessScope(facts, node.start).get(node.name);
    return nativeResolverKeys(
      facts,
      mutable,
      binding === node ? node.typeAnnotation?.typeAnnotation : binding,
      visited,
    );
  }
  if (node.type === 'TSUnionType') {
    const values = node.types.map((item) => nativeResolverKeys(facts, mutable, item, visited));
    return values.some((value) => value.length === 0) ? [] : values.flat();
  }
  if (node.type === 'TSLiteralType') {
    return nativeResolverKeys(facts, mutable, node.literal, visited);
  }
  if (node.type === 'TSTypeQuery' && node.exprName.type === 'Identifier') {
    return nativeResolverKeys(facts, mutable, node.exprName, visited);
  }
  if (node.type === 'ConditionalExpression') {
    const values = [node.consequent, node.alternate].map((item) => nativeResolverKeys(facts, mutable, item, visited));
    return values.some((value) => value.length === 0) ? [] : values.flat();
  }
  const literal = staticString(node, new Map());
  return literal === undefined ? [] : [literal];
};

const nativeResolverPropertyKey = (
  facts: SourceFacts,
  mutable: ReadonlySet<string>,
  property: Node,
): string | undefined => {
  if (
    property.type !== 'Property' ||
    property.method ||
    property.kind !== 'init' ||
    property.shorthand ||
    (!property.computed && propertyName(property.key) === '__proto__') ||
    staticString(property.value, new Map()) === undefined
  ) {
    return undefined;
  }
  const keys = property.computed
    ? nativeResolverKeys(facts, mutable, property.key)
    : [propertyName(property.key)].filter((value) => value !== undefined);
  return keys.length === 1 ? keys[0] : undefined;
};

const nativeResolverTableRead = (
  facts: SourceFacts,
  mutable: ReadonlySet<string>,
  reference: Node,
  parent: Node,
  parents: ReadonlyMap<Node, Node>,
  keys: ReadonlySet<string>,
): boolean => {
  const { parent: member, use } = subprocessUnwrappedUse(reference, parent, parents);
  if (member?.type !== 'MemberExpression' || member.object !== use || member.optional) {
    return false;
  }
  const selected = member.computed
    ? nativeResolverKeys(facts, mutable, member.property)
    : [propertyName(member.property)].filter((value) => value !== undefined);
  const parentMember = parents.get(member);
  const consumer =
    parentMember === undefined ? undefined : subprocessUnwrappedUse(member, parentMember, parents).parent;
  const writeContexts = new Set([
    'AssignmentExpression',
    'UpdateExpression',
    'AssignmentPattern',
    'ParenthesizedExpression',
    'ForInStatement',
    'ForOfStatement',
  ]);
  return (
    selected.length > 0 &&
    selected.every((key) => keys.has(key)) &&
    !writeContexts.has(consumer?.type ?? '') &&
    !(consumer?.type === 'UnaryExpression' && consumer.operator === 'delete')
  );
};

const nativeResolverTable = (
  facts: SourceFacts,
  mutable: ReadonlySet<string>,
  raw: Node,
): Extract<Node, { type: 'ObjectExpression' }> | undefined => {
  const node = subprocessUnwrap(raw);
  if (node?.type !== 'Identifier' || mutable.has(node.name)) {
    return undefined;
  }
  const binding = subprocessScope(facts, node.start).get(node.name);
  const table = subprocessUnwrap(binding);
  if (table?.type !== 'ObjectExpression') {
    return undefined;
  }
  const parents = nativeSubprocessParents(facts.program);
  const declaration = binding === undefined ? undefined : parents.get(binding);
  const statement = declaration === undefined ? undefined : parents.get(declaration);
  if (
    declaration?.type !== 'VariableDeclarator' ||
    statement?.type !== 'VariableDeclaration' ||
    statement.kind !== 'const' ||
    parents.get(statement)?.type === 'ExportNamedDeclaration'
  ) {
    return undefined;
  }
  const keys = new Set<string>();
  for (const property of table.properties) {
    const key = nativeResolverPropertyKey(facts, mutable, property);
    if (key === undefined || keys.has(key)) {
      return undefined;
    }
    keys.add(key);
  }
  const closed = [...parents].every(([reference, parent]) => {
    const relevant =
      reference.type === 'Identifier' &&
      subprocessImportReference(reference, parent, parents) &&
      subprocessScope(facts, reference.start).get(reference.name) === binding;
    return !relevant || nativeResolverTableRead(facts, mutable, reference, parent, parents, keys);
  });
  return closed ? table : undefined;
};

const nativeResolverStrings = (
  facts: SourceFacts,
  mutable: ReadonlySet<string>,
  raw: Node | undefined,
  seen = new Set<Node>(),
): string[] => {
  const node = subprocessUnwrap(raw);
  if (node === undefined || seen.has(node)) {
    return [];
  }
  const visited = new Set(seen).add(node);
  if (node.type === 'Identifier') {
    if (mutable.has(node.name)) {
      return [];
    }
    const binding = subprocessScope(facts, node.start).get(node.name);
    return nativeResolverStrings(facts, mutable, binding, visited);
  }
  if (node.type === 'MemberExpression' && !node.optional) {
    const table = nativeResolverTable(facts, mutable, node.object);
    const keys = node.computed
      ? nativeResolverKeys(facts, mutable, node.property, visited)
      : [propertyName(node.property)].filter((value) => value !== undefined);
    if (table === undefined || keys.length === 0) {
      return [];
    }
    const values = keys.map((key) => {
      const property = table.properties.find(
        (item) =>
          item.type === 'Property' &&
          (item.computed ? nativeResolverKeys(facts, mutable, item.key, visited)[0] : propertyName(item.key)) === key,
      );
      return property?.type === 'Property' ? staticString(property.value, new Map()) : undefined;
    });
    return values.some((value) => value === undefined) ? [] : values.filter((value) => value !== undefined);
  }
  if (node.type === 'ConditionalExpression') {
    const consequent = nativeResolverStrings(facts, mutable, node.consequent, visited);
    const alternate = nativeResolverStrings(facts, mutable, node.alternate, visited);
    return consequent.length === 0 || alternate.length === 0 ? [] : [...consequent, ...alternate];
  }
  const literal = staticString(node, new Map());
  return literal === undefined ? [] : [literal];
};

const nativeResolverLoader = (node: Node): Extract<Node, { type: 'CallExpression' }> | undefined => {
  if (
    node.type !== 'CallExpression' ||
    node.optional ||
    node.arguments.length !== 1 ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.callee.optional ||
    propertyName(node.callee.property) !== 'resolve'
  ) {
    return undefined;
  }
  const loader = node.callee.object;
  return loader.type === 'CallExpression' && !loader.optional && loader.arguments.length === 1 ? loader : undefined;
};

const nativeResolverAnchor = (
  facts: SourceFacts,
  loader: Extract<Node, { type: 'CallExpression' }>,
  state: NonNullable<ReturnType<typeof nativeResolverBindingState>>,
  owner: NativeResolverOwner,
): string | undefined => {
  if (loader.callee.type !== 'Identifier') {
    return undefined;
  }
  const factory = loader.callee.name;
  if (
    !state.factories.has(factory) ||
    state.mutable.has(factory) ||
    subprocessScope(facts, loader.start).has(factory)
  ) {
    return undefined;
  }
  const [anchorUrl] = loader.arguments;
  if (
    !isImportMetaUrl(anchorUrl) ||
    anchorUrl.arguments.length !== 2 ||
    subprocessScope(facts, anchorUrl.start).has('URL') ||
    state.mutable.has('URL')
  ) {
    return undefined;
  }
  const targets = nativeResolverStrings(facts, state.mutable, anchorUrl.arguments[0]);
  const [target] = targets;
  if (targets.length !== 1 || target === undefined) {
    return undefined;
  }
  const anchor = owner.path.resolve(owner.path.dirname(owner.path.join(owner.appRoot, facts.file)), target);
  return anchor === owner.path.resolve(owner.appRoot, owner.manifestFile) ? anchor : undefined;
};

const nativeResolverDependency = (
  facts: SourceFacts,
  owner: NativeResolverOwner,
  node: Node,
  anchor: string,
  specifier: string,
): KnipModelEvidence[] => {
  if (/^(?:[./#]|[a-z]+:)/u.test(specifier)) {
    return [];
  }
  const target = packageName(specifier);
  let category: 'dependencies' | 'devDependencies' | undefined;
  if (owner.manifest.dependencies?.[target] !== undefined) {
    category = 'dependencies';
  } else if (owner.manifest.devDependencies?.[target] !== undefined) {
    category = 'devDependencies';
  }
  const tree = parseTree(owner.manifestText);
  const declaration =
    category === undefined || tree === undefined
      ? undefined
      : findNodeAtLocation(tree, [category, target])?.parent?.children?.[0];
  if (category === undefined || declaration === undefined) {
    return [];
  }
  const resolved = resolveInstalledDependency(specifier, owner.path.dirname(anchor));
  if (resolved === undefined) {
    return [];
  }
  const offset = declaration.offset + 1;
  return [
    {
      ...evidenceAt(
        facts,
        owner.workspace,
        'native-resolver',
        target,
        node.start,
        'Native createRequire anchored to the owning manifest resolves this exact declared package subpath',
      ),
      anchor,
      declarationColumn: offset - owner.manifestText.lastIndexOf('\n', offset - 1),
      declarationLine: owner.manifestText.slice(0, offset).split('\n').length,
      declarationSource: owner.manifestFile,
      dependencyCategory: category,
      owningManifest: anchor,
      resolved,
      specifier,
    },
  ];
};

// A native resolver consumes the exact installed subpath, not every declaration
// in its workspace. Retain the original manifest issue in the native report.
const nativeCreateRequireEvidence = (
  facts: SourceFacts,
  workspace: string,
  appRoot: string,
  manifest: typeof PackageSchema.Type,
  manifestFile: string,
  manifestText: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const state = nativeResolverBindingState(facts);
  if (state === undefined) {
    return [];
  }
  const owner = { appRoot, manifest, manifestFile, manifestText, path, workspace };
  const evidence: KnipModelEvidence[] = [];
  for (const [node] of state.parents) {
    const loader = nativeResolverLoader(node);
    const anchor = loader === undefined ? undefined : nativeResolverAnchor(facts, loader, state, owner);
    const [argument] = node.type === 'CallExpression' ? node.arguments : [];
    if (anchor !== undefined && argument !== undefined) {
      for (const specifier of new Set(nativeResolverStrings(facts, state.mutable, argument))) {
        evidence.push(...nativeResolverDependency(facts, owner, argument, anchor, specifier));
      }
    }
  }
  return evidence;
};

const apiAliasHttpModule = 'effect/http-api';
const apiAliasFrameworkFacade = '@modern-js/bff-effect/effect-client';
interface ApiAliasBinding {
  readonly facts: SourceFacts;
  readonly name: string;
  readonly node: Node;
}
const apiAliasSource = (
  facts: SourceFacts,
  specifier: string,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  appRoot: string,
  path: Path.Path,
): SourceFacts | undefined => {
  const resolved = specifier.startsWith('.')
    ? path.resolve(appRoot, path.dirname(facts.file), specifier)
    : resolveInstalledDependency(specifier, path.dirname(path.resolve(appRoot, facts.file)));
  return resolved === undefined ? undefined : factsByPath.get(path.relative(appRoot, resolved).replaceAll('\\', '/'));
};
const apiAliasBinding = (
  facts: SourceFacts,
  name: string,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  appRoot: string,
  path: Path.Path,
  seen = new Set<string>(),
): ApiAliasBinding | undefined => {
  const key = `${facts.file}#${name}`;
  if (seen.has(key)) {
    return undefined;
  }
  const visited = new Set(seen).add(key);
  for (const statement of facts.program.body) {
    if (statement.type !== 'ExportNamedDeclaration') {
      continue;
    }
    const { declaration } = statement;
    if (declaration?.type === 'VariableDeclaration') {
      const binding = declaration.declarations.find((entry) => identifierName(entry.id) === name);
      if (binding?.init !== null && binding?.init !== undefined) {
        return { facts, name, node: binding.init };
      }
    }
    if (declaration?.type === 'TSTypeAliasDeclaration' && declaration.id.name === name) {
      return { facts, name, node: declaration.typeAnnotation };
    }
    if (statement.source !== null) {
      const specifier = statement.specifiers.find((entry) => propertyName(entry.exported) === name);
      const original = specifier === undefined ? undefined : propertyName(specifier.local);
      const target = apiAliasSource(facts, statement.source.value, factsByPath, appRoot, path);
      if (original !== undefined && target !== undefined) {
        return apiAliasBinding(target, original, factsByPath, appRoot, path, visited);
      }
    }
  }
  return undefined;
};
const apiAliasReference = (
  facts: SourceFacts,
  node: Node,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  appRoot: string,
  path: Path.Path,
): ApiAliasBinding | undefined => {
  if (node.type !== 'Identifier') {
    return undefined;
  }
  const local = facts.variables.get(node.name);
  if (local !== undefined && subprocessScope(facts, node.start).get(node.name) === local) {
    return apiAliasBinding(facts, node.name, factsByPath, appRoot, path);
  }
  for (const statement of facts.program.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }
    const imported = statement.specifiers.find(
      (entry) => entry.type === 'ImportSpecifier' && entry.local.name === node.name,
    );
    if (imported?.type === 'ImportSpecifier') {
      const scope = subprocessScope(facts, node.start);
      if (scope.has(node.name) && scope.get(node.name) !== imported.local) {
        return undefined;
      }
      const original = propertyName(imported.imported);
      const target = apiAliasSource(facts, statement.source.value, factsByPath, appRoot, path);
      return original === undefined || target === undefined
        ? undefined
        : apiAliasBinding(target, original, factsByPath, appRoot, path);
    }
  }
  return undefined;
};
const apiAliasImportedObject = (facts: SourceFacts, node: Node, source: string, name: string): boolean =>
  node.type === 'Identifier' &&
  facts.program.body.some(
    (statement) =>
      statement.type === 'ImportDeclaration' &&
      statement.importKind !== 'type' &&
      (statement.source.value === source ||
        (source === apiAliasHttpModule && statement.source.value === apiAliasFrameworkFacade)) &&
      statement.specifiers.some(
        (specifier) =>
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind !== 'type' &&
          propertyName(specifier.imported) === name &&
          specifier.local.name === node.name &&
          subprocessScope(facts, node.start).get(node.name) === specifier.local,
      ),
  );
const apiAliasSchema = (facts: SourceFacts, raw: Node | undefined): boolean => {
  const node = subprocessUnwrap(raw);
  if (
    node?.type !== 'CallExpression' ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.optional
  ) {
    return false;
  }
  if (apiAliasImportedObject(facts, node.callee.object, 'effect', 'Schema')) {
    return ['Struct', 'Union'].includes(propertyName(node.callee.property) ?? '');
  }
  return propertyName(node.callee.property) === 'check' && apiAliasSchema(facts, node.callee.object);
};
const apiAliasFactoryRoot = (facts: SourceFacts, raw: Node, factory: string): boolean => {
  const node = subprocessUnwrap(raw);
  if (
    node?.type !== 'CallExpression' ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.optional
  ) {
    return false;
  }
  if (propertyName(node.callee.property) === 'make') {
    return apiAliasImportedObject(facts, node.callee.object, apiAliasHttpModule, factory);
  }
  const method = propertyName(node.callee.property);
  return (
    (method === 'add' || (factory === 'HttpApiGroup' && method === 'middleware')) &&
    apiAliasFactoryRoot(facts, node.callee.object, factory)
  );
};
const apiAliasRegisteredGroup = (facts: SourceFacts, group: Node): boolean => {
  const constants = new Map<string, Node>();
  for (const statement of facts.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
      continue;
    }
    for (const binding of declaration.declarations) {
      if (binding.id.type === 'Identifier' && binding.init !== null) {
        constants.set(binding.id.name, binding.init);
      }
    }
  }
  const resolvesGroup = (raw: Node, seen = new Set<Node>()): boolean => {
    const node = subprocessUnwrap(raw);
    if (node === undefined || seen.has(node)) {
      return false;
    }
    if (node === group) {
      return true;
    }
    if (node.type !== 'Identifier') {
      return false;
    }
    const target = constants.get(node.name);
    return (
      target !== undefined &&
      subprocessScope(facts, node.start).get(node.name) === target &&
      resolvesGroup(target, new Set(seen).add(node))
    );
  };
  const registersGroup = (raw: Node): boolean => {
    const node = subprocessUnwrap(raw);
    if (
      node?.type !== 'CallExpression' ||
      node.callee.type !== 'MemberExpression' ||
      node.callee.computed ||
      node.optional ||
      propertyName(node.callee.property) !== 'add' ||
      !apiAliasFactoryRoot(facts, node, 'HttpApi')
    ) {
      return false;
    }
    return node.arguments.some((argument) => resolvesGroup(argument)) || registersGroup(node.callee.object);
  };
  return facts.program.body.some(
    (statement) =>
      statement.type === 'ExportNamedDeclaration' &&
      statement.declaration?.type === 'VariableDeclaration' &&
      statement.declaration.kind === 'const' &&
      statement.declaration.declarations.some((binding) => binding.init !== null && registersGroup(binding.init)),
  );
};
const apiAliasDirectEndpoint = (facts: SourceFacts, endpoint: Node, parents: ReadonlyMap<Node, Node>): boolean => {
  const registration = parents.get(endpoint);
  return (
    registration?.type === 'CallExpression' &&
    registration.callee.type === 'MemberExpression' &&
    propertyName(registration.callee.property) === 'add' &&
    registration.arguments.some((argument) => argument === endpoint) &&
    apiAliasFactoryRoot(facts, registration, 'HttpApiGroup')
  );
};
const apiAliasRegistrationStep = (facts: SourceFacts, node: Node, endpoint: Node): boolean =>
  node === endpoint ||
  node.type !== 'CallExpression' ||
  apiAliasFactoryRoot(facts, node, 'HttpApiGroup') ||
  apiAliasFactoryRoot(facts, node, 'HttpApi');

const apiAliasEndpointRegistered = (facts: SourceFacts, endpoint: Node, parents: ReadonlyMap<Node, Node>): boolean => {
  if (!apiAliasDirectEndpoint(facts, endpoint, parents)) {
    return false;
  }
  let node: Node | undefined = endpoint;
  while (node !== undefined) {
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      return false;
    }
    if (!apiAliasRegistrationStep(facts, node, endpoint)) {
      return false;
    }
    if (node.type === 'VariableDeclarator') {
      const declaration = parents.get(node);
      const exported = declaration === undefined ? undefined : parents.get(declaration);
      return (
        declaration?.type === 'VariableDeclaration' &&
        declaration.kind === 'const' &&
        node.init !== null &&
        ((exported?.type === 'ExportNamedDeclaration' && apiAliasFactoryRoot(facts, node.init, 'HttpApi')) ||
          ((exported?.type === 'ExportNamedDeclaration' || exported?.type === 'Program') &&
            apiAliasRegisteredGroup(facts, node.init)))
      );
    }
    node = parents.get(node);
  }
  return false;
};

const apiAliasEndpointReferences = (
  facts: SourceFacts,
  node: Node,
  parents: ReadonlyMap<Node, Node>,
): readonly { readonly node: Node; readonly reason: string }[] => {
  if (
    node.type !== 'CallExpression' ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.optional ||
    !['get', 'post', 'put', 'patch', 'del'].includes(propertyName(node.callee.property) ?? '') ||
    !apiAliasImportedObject(facts, node.callee.object, apiAliasHttpModule, 'HttpApiEndpoint') ||
    !apiAliasEndpointRegistered(facts, node, parents)
  ) {
    return [];
  }
  const options = unwrap(node.arguments[2], facts.variables);
  if (options?.type !== 'ObjectExpression') {
    return [];
  }
  return ['payload', 'success'].flatMap((key) => {
    const schema = objectValue(options, key);
    return schema === undefined
      ? []
      : [
          {
            node: schema,
            reason: `${facts.file}:${facts.source.slice(0, node.start).split('\n').length} endpoint ${key}`,
          },
        ];
  });
};
const apiAliasImportedTypes = (facts: SourceFacts, typeNames: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(
    facts.program.body.flatMap((statement) =>
      statement.type === 'ImportDeclaration'
        ? statement.specifiers.flatMap((specifier) =>
            specifier.type === 'ImportSpecifier' && typeNames.has(propertyName(specifier.imported) ?? '')
              ? [specifier.local.name]
              : [],
          )
        : [],
    ),
  );
const apiAliasSchemaType = (binding: ApiAliasBinding | undefined): string | undefined => {
  const query = binding?.node;
  return query?.type === 'TSTypeQuery' &&
    query.exprName.type === 'TSQualifiedName' &&
    query.exprName.left.type === 'Identifier' &&
    query.exprName.right.name === 'Type'
    ? query.exprName.left.name
    : undefined;
};
const apiAliasCodecReference = (facts: SourceFacts, node: Node): Node | undefined => {
  if (
    node.type !== 'CallExpression' ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.optional ||
    !apiAliasImportedObject(facts, node.callee.object, 'effect', 'Schema') ||
    !['decodeUnknownEffect', 'decodeEffect', 'encodeEffect', 'encodeUnknownEffect'].includes(
      propertyName(node.callee.property) ?? '',
    )
  ) {
    return undefined;
  }
  let [schema] = node.arguments;
  while (
    schema?.type === 'CallExpression' &&
    schema.callee.type === 'MemberExpression' &&
    !schema.callee.computed &&
    apiAliasImportedObject(facts, schema.callee.object, 'effect', 'Schema') &&
    ['toType', 'toCodecJson'].includes(propertyName(schema.callee.property) ?? '')
  ) {
    [schema] = schema.arguments;
  }
  return schema;
};

const apiAliasTypeReference = (node: Node, parent: Node, names: ReadonlySet<string>): boolean =>
  node.type === 'Identifier' &&
  names.has(node.name) &&
  !nativeSubprocessBindingOrName(node, parent) &&
  parent.type !== 'ImportSpecifier';

const apiAliasConsumers = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  appRoot: string,
  path: Path.Path,
): ReadonlyMap<string, string> => {
  const consumed = new Map<string, string>();
  const typeNames = new Set<string>();
  for (const facts of factsByPath.values()) {
    for (const node of facts.program.body) {
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration?.type === 'TSTypeAliasDeclaration' &&
        node.declaration.typeAnnotation.type === 'TSTypeQuery'
      ) {
        typeNames.add(node.declaration.id.name);
      }
    }
  }
  for (const facts of factsByPath.values()) {
    const importedTypes = apiAliasImportedTypes(facts, typeNames);
    const hasEndpoint = facts.program.body.some(
      (statement) =>
        statement.type === 'ImportDeclaration' &&
        [apiAliasHttpModule, apiAliasFrameworkFacade].includes(statement.source.value),
    );
    if (importedTypes.size === 0 && !hasEndpoint && !facts.source.includes('Schema')) {
      continue;
    }
    const parents = nativeSubprocessParents(facts.program);
    for (const [node, parent] of parents) {
      const codec = apiAliasCodecReference(facts, node);
      const references = [...apiAliasEndpointReferences(facts, node, parents)];
      if (codec !== undefined) {
        references.push({
          node: codec,
          reason: `${facts.file}:${facts.source.slice(0, node.start).split('\n').length} native Schema codec consumer`,
        });
      }
      for (const reference of references) {
        const binding = apiAliasReference(facts, reference.node, factsByPath, appRoot, path);
        if (binding !== undefined) {
          consumed.set(`${binding.facts.file}#${binding.name}`, reference.reason);
        }
      }
      if (apiAliasTypeReference(node, parent, importedTypes)) {
        const binding = apiAliasReference(facts, node, factsByPath, appRoot, path);
        const schema = apiAliasSchemaType(binding);
        if (binding !== undefined && schema !== undefined) {
          consumed.set(
            `${binding.facts.file}#${schema}`,
            `${facts.file}:${
              facts.source.slice(0, node.start).split('\n').length
            } consumes exported schema-derived type ${binding.name}`,
          );
        }
      }
    }
  }
  return consumed;
};

const apiSchemaAliasGroup = (
  facts: SourceFacts,
  exported: readonly ExportedBinding[],
  names: readonly string[],
  consumers: ReadonlyMap<string, string>,
): KnipModelEvidence | undefined => {
  const [canonical] = names;
  if (canonical === undefined || !apiAliasSchema(facts, facts.variables.get(canonical))) {
    return undefined;
  }
  const reasons = names.map((name) => consumers.get(`${facts.file}#${name}`));
  if (
    reasons.some((reason) => reason === undefined) ||
    !reasons.some((reason) => reason?.includes(' endpoint ') === true)
  ) {
    return undefined;
  }
  const nameSet = new Set(names);
  const members = exported.flatMap((binding) =>
    nameSet.has(binding.name)
      ? [
          {
            col: binding.offset - facts.source.lastIndexOf('\n', binding.offset - 1),
            line: facts.source.slice(0, binding.offset).split('\n').length,
            name: binding.name,
          },
        ]
      : [],
  );
  return {
    ...evidenceAt(
      facts,
      '.',
      'api-schema-alias',
      `${facts.file}#${names.join('=')}`,
      exported.find((binding) => binding.name === canonical)?.offset ?? 0,
      `Each exact alias has a genuine endpoint, codec, or imported contract type consumer: ${reasons.join('; ')}`,
    ),
    aliasMembers: members,
  };
};

const apiSchemaAliasEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  appRoot: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const consumers = apiAliasConsumers(factsByPath, appRoot, path);
  const evidence: KnipModelEvidence[] = [];
  for (const facts of factsByPath.values()) {
    const exported = exportedBindings(facts).filter((binding) => binding.kind === 'export');
    const groups = new Map<string, string[]>();
    for (const binding of exported) {
      const target = subprocessUnwrap(facts.variables.get(binding.name));
      if (
        target?.type === 'Identifier' &&
        binding.name.endsWith('Schema') &&
        exported.some((item) => item.name === target.name)
      ) {
        groups.set(target.name, [...(groups.get(target.name) ?? [target.name]), binding.name]);
      }
    }
    for (const names of groups.values()) {
      const group = apiSchemaAliasGroup(facts, exported, names, consumers);
      if (group !== undefined) {
        evidence.push(group);
      }
    }
  }
  return evidence;
};

const drizzleEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  prefix: string,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const evidence: KnipModelEvidence[] = [];
  for (const facts of factsByPath.values()) {
    if (!/drizzle(?:\.[^.]+)?\.config\.[cm]?[jt]s$/u.test(facts.file)) {
      continue;
    }
    const schema = staticString(objectValue(exportedObject(facts), 'schema'), facts.variables);
    const target = schema === undefined ? undefined : factsByPath.get(`${prefix}${schema.replace(/^\.\//u, '')}`);
    if (target !== undefined) {
      evidence.push(...reflectedDrizzleExports(target, factsByPath, workspace, facts.file, path));
    }
  }
  return evidence;
};

const nearestPackage = Effect.fn('QualityAudit.nearestPackage')(function* readNearestPackage(anchor: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = anchor;
  if (!(yield* fs.exists(directory))) {
    return null;
  }
  if ((yield* fs.stat(directory)).type !== 'Directory') {
    directory = path.dirname(directory);
  }
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (yield* fs.exists(manifest)) {
      const declared = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DependencyDeclarationSchema))(
        yield* fs.readFileString(manifest),
      );
      if (declared.name !== undefined) {
        return { declared, manifest };
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
});

const classifyProducerTarget = Effect.fn('QualityAudit.classifyProducerTarget')(function* classifyProducer(
  fact: KnipModelEvidence,
  manifest: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const resolved = resolveInstalledDependency(fact.target, manifest);
  if (resolved === undefined || fact.resolved === undefined) {
    return {
      ...fact,
      ...unprovenResolver,
      producerManifest: manifest,
      reason: `${fact.reason}; declaring producer could not resolve the exact target`,
    };
  }
  const [producerResolved, selectedResolved] = yield* Effect.all([fs.realPath(resolved), fs.realPath(fact.resolved)]);
  if (producerResolved !== selectedResolved) {
    return {
      ...fact,
      ...unprovenResolver,
      producerManifest: manifest,
      producerResolved,
      reason: `${fact.reason}; declaring producer ${manifest} resolves a different canonical target ${producerResolved}; selected target ${selectedResolved}`,
      resolved: selectedResolved,
    };
  }
  return { ...fact, owningManifest: manifest };
});

const proveVendorDependency = Effect.fn('QualityAudit.proveVendorDependency')(function* proveVendor(
  fact: KnipModelEvidence,
  owner: {
    readonly declared: typeof DependencyDeclarationSchema.Type;
    readonly manifest: string;
  },
) {
  if (!owner.manifest.includes('/node_modules/')) {
    return null;
  }
  let unproven: KnipModelEvidence | null = null;
  for (const dependency of Object.keys(owner.declared.dependencies ?? {})) {
    const resolved = resolveInstalledDependency(dependency, owner.manifest);
    const producer = resolved === undefined ? null : yield* nearestPackage(resolved);
    if (producer !== null && Object.hasOwn(producer.declared.dependencies ?? {}, fact.target)) {
      const proof = yield* classifyProducerTarget(
        {
          ...fact,
          reason: `${fact.reason}; dependency ownership ${owner.declared.name} -> ${producer.declared.name} -> ${fact.target}`,
        },
        producer.manifest,
      );
      if (proof.kind === 'resolver') {
        return proof;
      }
      unproven = proof;
    }
  }
  return unproven;
});

const proveResolverOwnership = Effect.fn('QualityAudit.proveResolverOwnership')(function* proveResolver(
  fact: KnipModelEvidence,
) {
  if (fact.anchor === undefined) {
    return null;
  }
  const owner = yield* nearestPackage(fact.anchor);
  if (owner === null) {
    return null;
  }
  const dependencies = {
    ...owner.declared.dependencies,
    ...owner.declared.devDependencies,
  };
  if (Object.hasOwn(dependencies, fact.target)) {
    return { ...fact, owningManifest: owner.manifest };
  }
  const producerProof = yield* proveVendorDependency(fact, owner);
  return (
    producerProof ?? {
      ...fact,
      ...unprovenResolver,
      reason: `${fact.reason}; anchor package ${owner.manifest} does not declare ${fact.target}, and no producer selecting the same target was proven`,
    }
  );
});

const workspaceModel = Effect.fn('QualityAudit.knipWorkspaceModel')(function* buildWorkspace(
  appRoot: string,
  workspace: string,
  current: WorkspaceConfig,
  files: readonly string[],
  workspaces: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prefix = workspace === '.' ? '' : `${workspace}/`;
  const manifestFile = `${prefix}package.json`;
  const manifestText = yield* fs.readFileString(path.join(appRoot, manifestFile));
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageSchema))(manifestText);
  const evidence: KnipModelEvidence[] = [];
  const fileSet = new Set(files);
  const entries = new Set(current.entry);
  const dependencies = new Set(current.ignoreDependencies);
  const add = (fact: KnipModelEvidence) => {
    if (fact.kind === 'entry' || fact.kind === 'file') {
      const target = path.relative(appRoot, path.resolve(appRoot, prefix, fact.target)).replaceAll('\\', '/');
      if (!fileSet.has(target)) {
        return;
      }
      if (fact.kind === 'entry') {
        entries.add(fact.target);
      }
    } else if (fact.kind === 'dependency' && workspace !== '.') {
      dependencies.add(fact.target);
    }
    evidence.push(fact);
  };
  for (const fact of manifestEvidence(manifest, manifestFile, workspace)) {
    add(fact);
  }
  const ownedFiles = files.filter(
    (file) =>
      !file.endsWith('.css') &&
      (workspace === '.'
        ? !workspaces.some((owner) => owner !== '.' && file.startsWith(`${owner}/`))
        : file.startsWith(prefix)),
  );
  const factsByPath = new Map<string, SourceFacts>();
  for (const file of ownedFiles) {
    const facts = yield* parseSource(file, yield* fs.readFileString(path.join(appRoot, file)));
    factsByPath.set(file, facts);
    evidence.push(
      ...nativeCreateRequireEvidence(facts, workspace, appRoot, manifest, manifestFile, manifestText, path),
    );
    for (const candidate of resolverEvidence(facts, workspace, appRoot, path)) {
      const proof = yield* proveResolverOwnership(candidate);
      if (proof !== null) {
        evidence.push(proof);
      }
    }
    const directory = path.dirname(path.relative(path.resolve(appRoot, prefix), path.resolve(appRoot, file)));
    for (const fact of playwrightWebServerEvidence(facts, manifest, manifestFile, workspace, appRoot, path)) {
      add(fact);
    }
    for (const fact of sourceEvidence(facts, workspace, directory, path, appRoot)) {
      add(fact);
    }
  }
  evidence.push(
    ...declarationSurfaceEvidence(factsByPath, workspace, path),
    ...modernRouteEvidence(factsByPath, manifest, prefix, workspace),
    ...catalogReadBindingEvidence(factsByPath, workspace),
    ...catalogSharedContractEvidence(factsByPath, workspace),
    ...catalogAliasEvidence(factsByPath, manifest, prefix, workspace, path),
    ...generatedModuleApiEvidence(factsByPath, prefix, workspace),
    ...generatedOutboxMessageEvidence(factsByPath, manifest, prefix, workspace),
    ...drizzleEvidence(factsByPath, prefix, workspace, path),
  );
  const aliasFiles = new Set(
    evidence
      .filter((fact) => fact.kind === 'alias')
      .map((fact) =>
        path.relative(path.resolve(appRoot, prefix), path.resolve(appRoot, fact.source)).replaceAll('\\', '/'),
      ),
  );
  const ignoreIssues = { ...current.ignoreIssues };
  for (const file of aliasFiles) {
    ignoreIssues[file] = [...new Set([...(ignoreIssues[file] ?? []), 'duplicates'])];
  }
  return {
    config: {
      ...current,
      entry: [...entries],
      ignoreDependencies: [...dependencies],
      ignoreIssues,
    },
    evidence,
    factsByPath,
  };
});

const mergeRuntimeEvidence = (
  workspaces: Record<string, WorkspaceConfig>,
  evidence: KnipModelEvidence[],
  runtime: readonly KnipModelEvidence[],
): void => {
  for (const fact of runtime) {
    const current = workspaces[fact.workspace];
    if (current === undefined) {
      continue;
    }
    if (fact.kind === 'dependency' && fact.workspace !== '.') {
      workspaces[fact.workspace] = {
        ...current,
        ignoreDependencies: [...new Set([...(current.ignoreDependencies ?? []), fact.target])],
      };
    } else if (fact.kind === 'entry') {
      workspaces[fact.workspace] = {
        ...current,
        entry: [...new Set([...(current.entry ?? []), fact.target])],
      };
    }
    evidence.push(fact);
  }
};

/** Static adapters never evaluate application or configuration modules. */
export const buildKnipModel = Effect.fn('QualityAudit.buildKnipModel')(function* buildModel(
  appRoot: string,
  baseConfig: typeof KnipConfigSchema.Type,
  consumerPath?: string,
) {
  const path = yield* Path.Path;
  const directories = yield* workspaceDirectories(appRoot);
  const files = yield* sourceFiles(appRoot, '');
  const configured = baseConfig.workspaces ?? { '.': baseConfig };
  const workspaces: Record<string, WorkspaceConfig> = {};
  const evidence: KnipModelEvidence[] = [];
  const allFacts = new Map<string, SourceFacts>();
  for (const workspace of directories) {
    const pattern = workspace === '.' ? '.' : `${workspace.split('/')[0]}/*`;
    const inherited = configured[workspace] ?? configured[pattern];
    if (inherited === undefined) {
      continue;
    }
    const result = yield* workspaceModel(appRoot, workspace, inherited, files, directories);
    workspaces[workspace] = result.config;
    evidence.push(...result.evidence);
    for (const [file, facts] of result.factsByPath) {
      allFacts.set(file, facts);
    }
  }
  evidence.push(...apiSchemaAliasEvidence(allFacts, appRoot, path));
  const runtime = yield* buildKnipRuntimeEvidence(appRoot);
  mergeRuntimeEvidence(workspaces, evidence, runtime);
  const reflected = [
    ...new Map(
      evidence
        .filter(
          (fact) =>
            fact.kind === 'export' ||
            fact.kind === 'type' ||
            fact.kind === 'file' ||
            (fact.kind === 'dependency' &&
              fact.workspace === '.' &&
              fact.reason !== 'Module Federation remotes consumer'),
        )
        .map((fact) => [`${fact.kind}:${fact.target}`, fact]),
    ).values(),
  ];
  const directConsumers: string[] = [];
  const bindingsByFile = new Map<string, { types: string[]; values: string[] }>();
  for (const [index, fact] of reflected.entries()) {
    if (fact.kind === 'dependency') {
      directConsumers.push(`import {} from ${JSON.stringify(fact.target)};`);
      continue;
    }
    if (fact.kind === 'file') {
      const owner = fact.workspace === '.' ? '' : fact.workspace;
      directConsumers.push(`import {} from ${JSON.stringify(path.resolve(appRoot, owner, fact.target))};`);
      continue;
    }
    const [file, name] = fact.target.split('#');
    const resolved = path.resolve(appRoot, file ?? '');
    const bindings = bindingsByFile.get(resolved) ?? { types: [], values: [] };
    if (fact.kind === 'type') {
      bindings.types.push(`${name} as Consumed${index}`);
    } else {
      bindings.values.push(`${name} as consumed${index}`);
    }
    bindingsByFile.set(resolved, bindings);
  }
  const bindingConsumers = [...bindingsByFile].flatMap(([file, bindings], group) => {
    const specifiers = [...bindings.values, ...bindings.types.map((binding) => `type ${binding}`)];
    const statements = [`import { ${specifiers.join(', ')} } from ${JSON.stringify(file)};`];
    if (bindings.values.length > 0) {
      statements.push(
        `void [${bindings.values.map((binding) => binding.slice(binding.lastIndexOf(' as ') + 4)).join(', ')}];`,
      );
    }
    if (bindings.types.length > 0) {
      statements.push(
        `type KnipConsumedGroup${group} = [${bindings.types
          .map((binding) => binding.slice(binding.lastIndexOf(' as ') + 4))
          .join(', ')}];`,
      );
    }
    return statements;
  });
  const consumerSource = [...directConsumers, ...bindingConsumers].join('\n');
  if (consumerPath !== undefined && reflected.length > 0 && workspaces['.'] !== undefined) {
    workspaces['.'] = {
      ...workspaces['.'],
      entry: [...(workspaces['.'].entry ?? []), consumerPath],
    };
  }
  return { config: { ...baseConfig, workspaces }, consumerSource, evidence };
});
