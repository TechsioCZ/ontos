/// <reference types="node" />
import { createRequire } from 'node:module';
import nodePath from 'node:path';

import { Effect, FileSystem, Path, Schema } from 'effect';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import type { PlatformError } from 'effect/PlatformError';
import { parseSync, Visitor, visitorKeys } from 'oxc-parser';
import type { Function as AstFunction, FunctionBody, Node, ObjectExpression, Program } from 'oxc-parser';

import { buildKnipRuntimeEvidence, workspaceDirectories } from './knip-runtime-model.mts';

const EFFECT_CLI_MODULE = 'effect/cli';
const CATALOG_WORKSPACE = 'verticals/catalog';
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

const COMMAND_MAKE_MEMBER = 'Command.make';
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

const generatedActionContractEvidence = (
  facts: SourceFacts,
  workspace: string,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  outboxSources: ReadonlySet<string>,
): KnipModelEvidence[] => {
  if (!facts.source.startsWith('// @generated by OntOS Codesmith Action v1\n')) {
    return [];
  }
  const owner = /^\/\/ @ontos-action-owner (?<owner>[a-z][a-z0-9.-]+)$/mu.exec(facts.source)?.groups?.owner;
  const slug = /^\/\/ @ontos-action-slug (?<slug>[a-z][a-z0-9-]+)$/mu.exec(facts.source)?.groups?.slug;
  const core =
    workspace === 'packages/core-runtime' && manifest.name === '@app/core-runtime' && owner === 'core.modules';
  const directory = core ? 'src/modules/actions' : 'src/actions';
  if (owner === undefined || slug === undefined || facts.file !== `${prefix}${directory}/${slug}.action.ts`) {
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
      /^\.\/[a-z0-9-]+\.outbox-message\.ts$/u.test(node.source.value) &&
      (!core || outboxSources.has(`${prefix}${directory}/${node.source.value.slice(2)}`));
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
    const actionMetadata = /^\/\/ @ontos-outbox-action (?<owner>[a-z][a-z0-9.-]+)\.(?<action>[a-z][a-z0-9-]+)$/mu.exec(
      facts.source,
    )?.groups;
    const action = actionMetadata?.action;
    const topic = /^\/\/ @ontos-outbox-topic (?<topic>[a-z][a-z0-9.-]+)$/mu.exec(facts.source)?.groups?.topic;
    if (action === undefined || topic === undefined) {
      return [];
    }
    const topicSlug = topic.replaceAll('.', '-');
    const core = workspace === 'packages/core-runtime' && manifest.name === '@app/core-runtime';
    const directory = core ? 'src/modules/actions' : 'src/actions';
    const relativeMessage = `${directory}/${action}-${topicSlug}.outbox-message.ts`;
    const contract = core ? `./src/outbox/${topicSlug}.ts` : `./shared/outbox/${topicSlug}.ts`;
    if (facts.file !== `${prefix}${relativeMessage}` || !declaredContracts.has(contract)) {
      return [];
    }
    if (
      core &&
      (actionMetadata?.owner !== 'core.modules' ||
        !facts.program.body.some(
          (node) =>
            node.type === 'ImportDeclaration' &&
            node.importKind !== 'type' &&
            node.source.value === `../../outbox/${topicSlug}.ts` &&
            ['outboxProducerModuleKey', 'outboxTopic'].every((name) =>
              node.specifiers.some(
                (specifier) => specifier.type === 'ImportSpecifier' && identifierName(specifier.imported) === name,
              ),
            ),
        ))
    ) {
      return [];
    }
    const actionFacts = factsByPath.get(`${prefix}${directory}/${action}.action.ts`);
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
  if (workspace !== CATALOG_WORKSPACE) {
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
  if (workspace !== CATALOG_WORKSPACE) {
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
  if (workspace !== CATALOG_WORKSPACE) {
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

const consumesManifestComponent = (consumer: SourceFacts, name: string): boolean =>
  consumer.program.body.some((node) => {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'VariableDeclaration') {
      return false;
    }
    return node.declaration.declarations.some((item) => {
      const object = objectExpression(item.init ?? undefined, consumer.variables);
      const surface = objectExpression(objectValue(object, 'publicSurface'), consumer.variables);
      const components = staticObjectFields(objectExpression(objectValue(surface, 'components'), consumer.variables));
      return [...(components?.values() ?? [])].some((value) => identifierName(value) === name);
    });
  });

const manifestPageAliasEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const manifestFile = manifest.modernjs?.ontosModule?.manifest;
  if (manifestFile === undefined) {
    return [];
  }
  const consumer = factsByPath.get(path.normalize(path.join(prefix, manifestFile)));
  const federation = factsByPath.get(`${prefix}module-federation.config.ts`);
  if (consumer === undefined || federation === undefined) {
    return [];
  }
  const exposes = staticObjectFields(
    objectExpression(objectValue(exportedObject(federation), 'exposes'), federation.variables),
  );
  const exposed = new Set(
    [...(exposes?.values() ?? [])].flatMap((node) => {
      const target = staticString(node, federation.variables);
      return target === undefined ? [] : [path.normalize(path.join(prefix, target))];
    }),
  );
  return consumer.program.body.flatMap((statement) => {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') {
      return [];
    }
    const file = path.normalize(path.join(path.dirname(consumer.file), statement.source.value));
    const facts = factsByPath.get(file);
    if (facts === undefined || !exposed.has(file)) {
      return [];
    }
    const defaults = facts.program.body.filter((node) => node.type === 'ExportDefaultDeclaration');
    const [declaration] = defaults;
    if (
      defaults.length !== 1 ||
      declaration?.type !== 'ExportDefaultDeclaration' ||
      declaration.declaration.type !== 'Identifier'
    ) {
      return [];
    }
    const named = declaration.declaration.name;
    const matchingExports = exportedBindings(facts).filter((item) => item.kind === 'export' && item.name === named);
    if (matchingExports.length !== 1) {
      return [];
    }
    const binding = statement.specifiers.find(
      (specifier) =>
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        propertyName(specifier.imported) === named,
    );
    if (binding === undefined) {
      return [];
    }
    const consumed = consumesManifestComponent(consumer, binding.local.name);
    if (!consumed) {
      return [];
    }
    return [
      evidenceAt(
        facts,
        workspace,
        'export',
        `${facts.file}#default`,
        declaration.start,
        `Module Federation default component exposed by ${federation.file}`,
      ),
      evidenceAt(
        facts,
        workspace,
        'alias',
        `${facts.file}#default=${named}`,
        declaration.start,
        `Named component imported by ${consumer.file}; identical default component exposed by ${federation.file}`,
      ),
    ];
  });
};

// Knip suppresses duplicates per file. A proven federation alias must never hide
// another exported alias merely because it happens to be declared in that file.
const freshPageExportInitializer = (node: Node | undefined): boolean => {
  if (node === undefined) {
    return false;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') {
    return freshPageExportInitializer(node.expression);
  }
  // Native Knip groups direct identifier aliases, not independently evaluated calls.
  return [
    'ArrowFunctionExpression',
    'FunctionExpression',
    'ClassExpression',
    'ObjectExpression',
    'ArrayExpression',
    'CallExpression',
    'StringLiteral',
    'NumericLiteral',
    'BooleanLiteral',
    'NullLiteral',
    'BigIntLiteral',
    'RegExpLiteral',
    'TemplateLiteral',
  ].includes(node.type);
};

const independentlyDeclaredExport = (facts: SourceFacts, name: string): boolean =>
  facts.program.body.some((statement) => {
    if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') {
      return false;
    }
    const { declaration } = statement;
    if (declaration?.type === 'VariableDeclaration') {
      return declaration.declarations.some(
        (binding) => identifierName(binding.id) === name && freshPageExportInitializer(binding.init ?? undefined),
      );
    }
    return (
      (declaration?.type === 'FunctionDeclaration' ||
        declaration?.type === 'ClassDeclaration' ||
        declaration?.type === 'TSEnumDeclaration') &&
      identifierName(declaration.id ?? undefined) === name
    );
  });

const pageDuplicateSuppressionIsProven = (
  facts: SourceFacts,
  evidence: readonly KnipModelEvidence[],
  factsByPath: ReadonlyMap<string, SourceFacts>,
  path: Path.Path,
): boolean => {
  const proven = new Set(
    evidence.flatMap((fact) => (fact.kind === 'alias' && fact.source === facts.file ? [fact.target] : [])),
  );
  const isProven = (alias: string | undefined, target: string | undefined): boolean =>
    alias !== undefined && target !== undefined && proven.has(`${facts.file}#${alias}=${target}`);
  const forwardedBindings = new Set<string>();
  const independentProducer = (source: string, name: string | undefined): boolean => {
    if (!source.startsWith('.') || name === undefined) {
      return false;
    }
    const target = path.normalize(path.join(path.dirname(facts.file), source));
    const producer = factsByPath.get(target);
    const key = `${target}#${name}`;
    if (
      producer === undefined ||
      producer.file === facts.file ||
      forwardedBindings.has(key) ||
      !independentlyDeclaredExport(producer, name)
    ) {
      return false;
    }
    forwardedBindings.add(key);
    return true;
  };
  const independentImport = (name: string): boolean =>
    facts.program.body.some(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.importKind !== 'type' &&
        node.specifiers.some(
          (specifier) =>
            specifier.type === 'ImportSpecifier' &&
            specifier.importKind !== 'type' &&
            specifier.local.name === name &&
            independentProducer(node.source.value, propertyName(specifier.imported)),
        ),
    );
  const initializerIsProven = (alias: string | undefined, node: Node | undefined): boolean => {
    if (
      node?.type === 'TSAsExpression' ||
      node?.type === 'TSSatisfiesExpression' ||
      node?.type === 'TSNonNullExpression'
    ) {
      return initializerIsProven(alias, node.expression);
    }
    if (node?.type === 'Identifier') {
      return isProven(alias, node.name) || independentImport(node.name);
    }
    return freshPageExportInitializer(node);
  };
  return facts.program.body.every((node) => {
    if (node.type === 'ExportAllDeclaration') {
      return false;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      return isProven('default', identifierName(node.declaration));
    }
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') {
      return true;
    }
    if (node.source !== null) {
      const source = node.source.value;
      return node.specifiers.every(
        (specifier) => specifier.exportKind === 'type' || independentProducer(source, identifierName(specifier.local)),
      );
    }
    if (node.declaration?.type === 'VariableDeclaration') {
      return node.declaration.declarations.every((item) =>
        initializerIsProven(identifierName(item.id), item.init ?? undefined),
      );
    }
    return node.specifiers.every(
      (item) =>
        item.exportKind === 'type' ||
        (identifierName(item.local) === identifierName(item.exported) &&
          initializerIsProven(identifierName(item.local), facts.variables.get(identifierName(item.local) ?? ''))) ||
        isProven(identifierName(item.exported), identifierName(item.local)),
    );
  });
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
      if (node.type === 'FunctionExpression' && node.id !== null) {
        blockBinding(node.id);
      }
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

const immutableModelBinding = (facts: SourceFacts, name: string, scope: Node = facts.program): boolean => {
  let mutable = false;
  const inside = (node: Node) => scope.start <= node.start && node.end <= scope.end;
  new Visitor({
    AssignmentExpression: (node) => {
      if (!inside(node)) {
        return;
      }
      const target = node.left.type === 'MemberExpression' ? node.left.object : node.left;
      if (identifierName(target) === name) {
        mutable = true;
      }
    },
    CallExpression: (node) => {
      if (!inside(node)) {
        return;
      }
      if (
        node.callee.type === 'MemberExpression' &&
        identifierName(node.callee.object) === name &&
        ['push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin'].includes(
          propertyName(node.callee.property) ?? '',
        )
      ) {
        mutable = true;
      }
    },
    UpdateExpression: (node) => {
      if (!inside(node)) {
        return;
      }
      if (identifierName(node.argument) === name) {
        mutable = true;
      }
    },
    VariableDeclaration: (node) => {
      if (!inside(node)) {
        return;
      }
      if (node.kind !== 'const' && node.declarations.some((binding) => identifierName(binding.id) === name)) {
        mutable = true;
      }
    },
  }).visit(facts.program);
  return !mutable;
};

/** An immutable literal list is executable evidence only inside its consuming for-of import. */
const loopImportEvidence = (facts: SourceFacts, workspace: string, path: Path.Path): KnipModelEvidence[] => {
  const evidence: KnipModelEvidence[] = [];
  new Visitor({
    ForOfStatement: (loop) => {
      if (loop.left.type !== 'VariableDeclaration' || loop.left.kind !== 'const') {
        return;
      }
      const binding = loop.left.declarations[0]?.id;
      if (binding?.type !== 'Identifier') {
        return;
      }
      const variables = scopedVariables(facts, loop.start);
      if (loop.right.type === 'Identifier' && !immutableModelBinding(facts, loop.right.name)) {
        return;
      }
      const values = unwrap(loop.right, variables);
      if (values?.type !== 'ArrayExpression') {
        return;
      }
      const targets = values.elements.map((element) => staticString(element ?? undefined, variables));
      if (targets.some((target) => target === undefined || !target.startsWith('.'))) {
        return;
      }
      new Visitor({
        ImportExpression: (node) => {
          if (node.start < loop.body.start || node.end > loop.body.end) {
            return;
          }
          if (node.source.type !== 'Identifier' || node.source.name !== binding.name) {
            return;
          }
          const scope = scopedVariables(facts, node.start);
          if (scope.has(binding.name)) {
            return;
          }
          for (const target of targets) {
            if (target === undefined) {
              continue;
            }
            evidence.push(
              evidenceAt(
                facts,
                workspace,
                'file',
                path.relative(workspace, path.join(path.dirname(facts.file), target)),
                node.start,
                'Immutable for-of list is loaded by this dynamic import',
              ),
            );
          }
        },
      }).visit(facts.program);
    },
  }).visit(facts.program);
  return evidence;
};

// Resolve only immutable source expressions. No application, tool or test module is executed.
const consumerImport = (
  facts: SourceFacts,
  name: string,
  offset: number,
): { name: string; source: string } | undefined => {
  if (scopedVariables(facts, offset).has(name) || !immutableModelBinding(facts, name)) {
    return undefined;
  }
  for (const statement of facts.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.local.name !== name || (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')) {
        continue;
      }
      return {
        name: specifier.type === 'ImportSpecifier' ? (propertyName(specifier.imported) ?? '') : '*',
        source: statement.source.value,
      };
    }
  }
  return undefined;
};

const consumerIdentity = (facts: SourceFacts, node: Node | undefined, offset: number): string | undefined => {
  if (node?.type === 'Identifier') {
    const imported = consumerImport(facts, node.name, offset);
    if (imported !== undefined) {
      return `${imported.source}#${imported.name}`;
    }
    return ['AbortController', 'URL', 'process'].includes(node.name) &&
      !scopedVariables(facts, offset).has(node.name) &&
      immutableModelBinding(facts, node.name)
      ? `global#${node.name}`
      : undefined;
  }
  if (node?.type !== 'MemberExpression' || node.computed) {
    return undefined;
  }
  const host = consumerIdentity(facts, node.object, offset);
  const member = propertyName(node.property);
  return host === undefined || member === undefined ? undefined : `${host}.${member}`;
};

const isConsumerFunction = (
  facts: SourceFacts,
  node: Node | undefined,
  module: string,
  name: string,
  offset: number,
): boolean => {
  const identity = consumerIdentity(facts, node, offset);
  return identity === `${module}#${name}` || identity === `${module}#*.${name}`;
};

const sourceCalls = (facts: SourceFacts): Extract<Node, { type: 'CallExpression' }>[] => {
  const calls: Extract<Node, { type: 'CallExpression' }>[] = [];
  new Visitor({
    CallExpression: (node) => {
      calls.push(node);
    },
  }).visit(facts.program);
  return calls;
};

const calledTestContains = (facts: SourceFacts, offset: number): boolean =>
  facts.program.body.some((statement) => {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : undefined;
    if (call?.type !== 'CallExpression') {
      return false;
    }
    const [, callback] = call.arguments;
    if (
      callback?.type !== 'ArrowFunctionExpression' ||
      !(callback.body.start <= offset && offset < callback.body.end) ||
      !['effect-rstest', '@rstest/core', 'vitest'].some((module) =>
        isConsumerFunction(facts, call.callee, module, 'it', call.start),
      )
    ) {
      return false;
    }
    let nested = false;
    const check = (node: Node) => {
      if (node !== callback && node.start <= offset && offset < node.end) {
        nested = true;
      }
    };
    new Visitor({ ArrowFunctionExpression: check, FunctionDeclaration: check, FunctionExpression: check }).visit(
      facts.program,
    );
    return !nested;
  });

const directExportInitializer = (facts: SourceFacts, name: string): Node | undefined => {
  for (const statement of facts.program.body) {
    if (
      statement.type === 'ExportNamedDeclaration' &&
      statement.exportKind !== 'type' &&
      statement.declaration?.type === 'VariableDeclaration' &&
      statement.declaration.kind === 'const'
    ) {
      const binding = statement.declaration.declarations.find((item) => identifierName(item.id) === name);
      if (binding?.init !== null && binding?.init !== undefined) {
        return binding.init;
      }
    }
  }
  return undefined;
};

type ConsumerEvaluate = (node: Node | undefined) => readonly string[] | undefined;
const finiteArrayValues = (
  node: Extract<Node, { type: 'ArrayExpression' }>,
  evaluate: ConsumerEvaluate,
): readonly string[] | undefined => {
  const result: string[] = [];
  for (const element of node.elements) {
    const items = evaluate(element?.type === 'SpreadElement' ? element.argument : (element ?? undefined));
    if (items === undefined || result.length + items.length > 128) {
      return undefined;
    }
    result.push(...items);
  }
  return result;
};
const finiteTemplateValues = (
  node: Extract<Node, { type: 'TemplateLiteral' }>,
  evaluate: ConsumerEvaluate,
): readonly string[] | undefined => {
  let result = [node.quasis[0]?.value.cooked ?? ''];
  for (const [index, expression] of node.expressions.entries()) {
    const options = evaluate(expression);
    if (options === undefined || options.length * result.length > 128) {
      return undefined;
    }
    result = result.flatMap((prefix) =>
      options.map((value) => prefix + value + (node.quasis[index + 1]?.value.cooked ?? '')),
    );
  }
  return result;
};
const finiteMappedValues = (
  node: Extract<Node, { type: 'CallExpression' }>,
  evaluate: ConsumerEvaluate,
  mappedValue: (
    callback: Extract<Node, { type: 'ArrowFunctionExpression' }>,
    parameter: string,
    input: string,
  ) => readonly string[] | undefined,
): readonly string[] | undefined => {
  if (
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    propertyName(node.callee.property) !== 'map' ||
    node.arguments.length !== 1
  ) {
    return undefined;
  }
  const [callback] = node.arguments;
  if (
    callback?.type !== 'ArrowFunctionExpression' ||
    callback.async ||
    callback.body.type === 'BlockStatement' ||
    callback.params.length !== 1 ||
    callback.params[0]?.type !== 'Identifier'
  ) {
    return undefined;
  }
  const inputs = evaluate(node.callee.object);
  const parameter = callback.params[0].name;
  if (inputs === undefined) {
    return undefined;
  }
  const result: string[] = [];
  for (const input of inputs) {
    const output = mappedValue(callback, parameter, input);
    if (output === undefined || result.length + output.length > 128) {
      return undefined;
    }
    result.push(...output);
  }
  return result;
};
const finiteConsumer = (factsByPath: ReadonlyMap<string, SourceFacts>, appRoot: string, path: Path.Path) => {
  type Environment = ReadonlyMap<string, readonly string[]>;
  type Evaluate = (node: Node | undefined) => readonly string[] | undefined;
  type ImportValue = (facts: SourceFacts, node: Node | undefined) => readonly string[] | undefined;
  const identifierValues = (
    facts: SourceFacts,
    name: string,
    offset: number,
    env: Environment,
    evaluate: Evaluate,
    importedValue: ImportValue,
  ): readonly string[] | undefined => {
    if (env.has(name)) {
      return env.get(name);
    }
    if (!immutableModelBinding(facts, name)) {
      return undefined;
    }
    const local = scopedVariables(facts, offset).get(name);
    if (local !== undefined) {
      return evaluate(local);
    }
    const imported = consumerImport(facts, name, offset);
    const producer =
      imported?.source.startsWith('.') === true
        ? factsByPath.get(path.normalize(path.join(path.dirname(facts.file), imported.source)))
        : undefined;
    return producer === undefined || imported === undefined
      ? undefined
      : importedValue(producer, directExportInitializer(producer, imported.name));
  };

  const urlValues = (
    facts: SourceFacts,
    node: Extract<Node, { type: 'CallExpression' }>,
    evaluate: Evaluate,
  ): readonly string[] | undefined => {
    if (node.arguments.length !== 1) {
      return undefined;
    }
    const [url] = node.arguments;
    if (importedUrlBase(url)) {
      return [path.resolve(appRoot, facts.file)];
    }
    if (
      url?.type !== 'NewExpression' ||
      consumerIdentity(facts, url.callee, url.start) !== 'global#URL' ||
      url.arguments.length !== 2 ||
      !importedUrlBase(url.arguments[1])
    ) {
      return undefined;
    }
    return evaluate(url.arguments[0])?.map((value) => path.resolve(appRoot, path.dirname(facts.file), value));
  };
  const joinedValues = (
    node: Extract<Node, { type: 'CallExpression' }>,
    evaluate: Evaluate,
    resolve: boolean,
  ): readonly string[] | undefined => {
    let combinations: string[][] = [[]];
    for (const argument of node.arguments) {
      const options = evaluate(argument);
      if (options === undefined || options.length * combinations.length > 128) {
        return undefined;
      }
      combinations = combinations.flatMap((parts) => options.map((value) => [...parts, value]));
    }
    return combinations.map((parts) => (resolve ? path.resolve(...parts) : path.join(...parts)));
  };

  const callValues = (
    facts: SourceFacts,
    node: Extract<Node, { type: 'CallExpression' }>,
    evaluate: Evaluate,
    mappedValue: Parameters<typeof finiteMappedValues>[2],
  ): readonly string[] | undefined => {
    const native = (name: string) => isConsumerFunction(facts, node.callee, 'node:path', name, node.start);
    if (isConsumerFunction(facts, node.callee, 'node:url', 'fileURLToPath', node.start)) {
      return urlValues(facts, node, evaluate);
    }
    if (native('dirname') && node.arguments.length === 1) {
      return evaluate(node.arguments[0])?.map((value) => path.dirname(value));
    }
    if (native('join') || native('resolve')) {
      return joinedValues(node, evaluate, native('resolve'));
    }
    return finiteMappedValues(node, evaluate, mappedValue);
  };
  const values = (
    facts: SourceFacts,
    node: Node | undefined,
    offset: number,
    env: Environment = new Map(),
    seen = new Set<Node>(),
  ): readonly string[] | undefined => {
    if (node === undefined || seen.has(node) || seen.size > 40) {
      return undefined;
    }
    const next = new Set(seen).add(node);
    const evaluate: Evaluate = (child) => values(facts, child, offset, env, next);
    if (node.type === 'Literal') {
      return isString(node.value) ? [node.value] : undefined;
    }
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression'
    ) {
      return evaluate(node.expression);
    }
    if (node.type === 'Identifier') {
      return identifierValues(facts, node.name, offset, env, evaluate, (producer, initializer) =>
        values(producer, initializer, 0, new Map(), next),
      );
    }
    if (node.type === 'ArrayExpression') {
      return finiteArrayValues(node, evaluate);
    }
    if (node.type === 'TemplateLiteral') {
      return finiteTemplateValues(node, evaluate);
    }
    if (node.type !== 'CallExpression' || node.optional) {
      return undefined;
    }
    return callValues(facts, node, evaluate, (callback, parameter, input) =>
      values(facts, callback.body, callback.body.start, new Map(env).set(parameter, [input]), next),
    );
  };
  return (facts: SourceFacts, node: Node | undefined, offset: number): readonly string[] | undefined => {
    const env = new Map<string, readonly string[]>();
    let valid = true;
    new Visitor({
      ForOfStatement: (loop) => {
        if (!(loop.body.start <= offset && offset < loop.body.end)) {
          return;
        }
        const binding =
          loop.left.type === 'VariableDeclaration' && loop.left.kind === 'const'
            ? loop.left.declarations[0]?.id
            : undefined;
        const shadow = binding?.type === 'Identifier' ? scopedVariables(facts, offset).get(binding.name) : undefined;
        const inputs = values(facts, loop.right, loop.start, env);
        if (binding?.type !== 'Identifier' || (shadow !== undefined && shadow !== binding) || inputs === undefined) {
          valid = false;
        } else {
          env.set(binding.name, inputs);
        }
      },
    }).visit(facts.program);
    return valid ? values(facts, node, offset, env) : undefined;
  };
};

const exportedModelFunction = (facts: SourceFacts, name: string): AstFunction | undefined => {
  const statement = facts.program.body.find(
    (node) =>
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name === name,
  );
  return statement?.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'FunctionDeclaration'
    ? statement.declaration
    : undefined;
};
const functionConstants = (fn: AstFunction): Map<string, Node> => {
  const result = new Map<string, Node>();
  for (const statement of fn.body?.body ?? []) {
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      for (const binding of statement.declarations) {
        if (binding.id.type === 'Identifier' && binding.init !== null) {
          result.set(binding.id.name, binding.init);
        }
      }
    }
  }
  return result;
};
const nativeOxlintExecutable = (facts: SourceFacts): Node | undefined => {
  const entry = facts.variables.get('oxlintEntryPoint');
  if (
    !immutableModelBinding(facts, 'oxlintEntryPoint') ||
    entry?.type !== 'CallExpression' ||
    !isConsumerFunction(facts, entry.callee, 'node:path', 'join', entry.start) ||
    staticString(entry.arguments[1], new Map()) !== 'bin/oxlint'
  ) {
    return undefined;
  }
  const [directory] = entry.arguments;
  const resolver =
    directory?.type === 'CallExpression' &&
    isConsumerFunction(facts, directory.callee, 'node:path', 'dirname', directory.start)
      ? directory.arguments[0]
      : undefined;
  if (
    resolver?.type !== 'CallExpression' ||
    resolver.callee.type !== 'MemberExpression' ||
    resolver.callee.computed ||
    propertyName(resolver.callee.property) !== 'resolve'
  ) {
    return undefined;
  }
  const requireCall = resolver.callee.object;
  return requireCall.type === 'CallExpression' &&
    isConsumerFunction(facts, requireCall.callee, 'node:module', 'createRequire', requireCall.start) &&
    importedUrlBase(requireCall.arguments[0]) &&
    staticString(resolver.arguments[0], new Map()) === 'oxlint/package.json'
    ? entry
    : undefined;
};
const nativeOxlintArgv = (
  call: Extract<Node, { type: 'CallExpression' }>,
  config: string,
  files: string,
  cwd: string,
): boolean => {
  const [, argv, options] = call.arguments;
  if (argv?.type !== 'ArrayExpression' || argv.elements.length !== 7 || options?.type !== 'ObjectExpression') {
    return false;
  }
  return (
    identifierName(argv.elements[0] ?? undefined) === 'oxlintEntryPoint' &&
    staticString(argv.elements[2] ?? undefined, new Map()) === '-c' &&
    identifierName(argv.elements[3] ?? undefined) === config &&
    argv.elements[6]?.type === 'SpreadElement' &&
    identifierName(argv.elements[6].argument) === files &&
    options.properties.every((property) => property.type === 'Property' && !property.computed) &&
    identifierName(objectValue(options, 'cwd')) === cwd
  );
};
const nativeLintHarness = (facts: SourceFacts): boolean => {
  const fn = exportedModelFunction(facts, 'runOxlint');
  const entry = nativeOxlintExecutable(facts);
  if (fn === undefined || entry === undefined) {
    return false;
  }
  const [config, files, cwd] = fn.params.map(identifierName);
  if (config === undefined || files === undefined || cwd === undefined) {
    return false;
  }
  const initializers = new Set(functionConstants(fn).values());
  return sourceCalls(facts).some(
    (call) =>
      initializers.has(call) &&
      scopedVariables(facts, call.start).get('oxlintEntryPoint') === entry &&
      [config, files, cwd].every((name) => immutableModelBinding(facts, name)) &&
      isConsumerFunction(facts, call.callee, 'node:child_process', 'spawnSync', call.start) &&
      consumerIdentity(facts, call.arguments[0], call.start) === 'global#process.execPath' &&
      nativeOxlintArgv(call, config, files, cwd),
  );
};
const consumerMember = (node: Node | undefined, host: string, member: string): boolean =>
  node?.type === 'MemberExpression' &&
  !node.computed &&
  identifierName(node.object) === host &&
  propertyName(node.property) === member;
const consumerMethod = (
  node: Node | undefined,
  host: string,
  member: string,
  args: readonly (string | undefined)[],
): boolean =>
  node?.type === 'CallExpression' &&
  !node.optional &&
  consumerMember(node.callee, host, member) &&
  node.arguments.length === args.length &&
  node.arguments.every((arg, index) => identifierName(arg) === args[index]);
const factoryExportLookup = (node: Node | undefined, name: string | undefined): boolean => {
  const lookup = node?.type === 'ChainExpression' ? node.expression : node;
  return (
    lookup?.type === 'CallExpression' &&
    lookup.callee.type === 'MemberExpression' &&
    !lookup.callee.computed &&
    propertyName(lookup.callee.property) === 'get' &&
    lookup.arguments.length === 1 &&
    identifierName(lookup.arguments[0]) === name &&
    consumerMember(lookup.callee.object, 'owner', 'exports')
  );
};
const factoryProofReads = (facts: SourceFacts, fn: AstFunction): boolean => {
  const locals = functionConstants(fn);
  const [filename, source, name] = fn.params.map(identifierName);
  const proof = locals.get('proof');
  return (
    proof?.type === 'NewExpression' &&
    identifierName(proof.callee) === 'DataFactoryProof' &&
    proof.arguments.length === 0 &&
    ['proof', 'consumer', 'owner'].every((binding) => immutableModelBinding(facts, binding, fn)) &&
    consumerMethod(locals.get('consumer'), 'proof', 'load', [filename]) &&
    consumerMethod(locals.get('owner'), 'proof', 'imported', ['consumer', source]) &&
    factoryExportLookup(locals.get('exported'), name)
  );
};
const nativeFactoryParser = (facts: SourceFacts): boolean => {
  const fn = exportedModelFunction(facts, 'provesDataFactoryImport');
  const parser = facts.program.body.find(
    (node) => node.type === 'ClassDeclaration' && node.id?.name === 'DataFactoryProof',
  );
  if (
    fn === undefined ||
    parser?.type !== 'ClassDeclaration' ||
    !immutableModelBinding(facts, 'DataFactoryProof') ||
    !factoryProofReads(facts, fn)
  ) {
    return false;
  }
  const load = parser.body.body.find((node) => node.type === 'MethodDefinition' && propertyName(node.key) === 'load');
  const imported = parser.body.body.find(
    (node) => node.type === 'MethodDefinition' && propertyName(node.key) === 'imported',
  );
  if (load?.type !== 'MethodDefinition' || imported?.type !== 'MethodDefinition') {
    return false;
  }
  const calls = sourceCalls(facts);
  const parsesFile = calls.some((call) => {
    const [, read] = call.arguments;
    return (
      load.start <= call.start &&
      call.end <= load.end &&
      isConsumerFunction(facts, call.callee, 'oxc-parser', 'parseSync', call.start) &&
      identifierName(call.arguments[0]) === 'filename' &&
      read?.type === 'CallExpression' &&
      isConsumerFunction(facts, read.callee, 'node:fs', 'readFileSync', read.start) &&
      identifierName(read.arguments[0]) === 'filename'
    );
  });
  const resolvesProducer = calls.some((call) => {
    const [directory] = call.arguments;
    const file = directory?.type === 'CallExpression' ? directory.arguments[0] : undefined;
    return (
      imported.start <= call.start &&
      call.end <= imported.end &&
      isConsumerFunction(facts, call.callee, 'node:path', 'resolve', call.start) &&
      call.arguments.length === 2 &&
      identifierName(call.arguments[1]) === 'source' &&
      directory?.type === 'CallExpression' &&
      isConsumerFunction(facts, directory.callee, 'node:path', 'dirname', directory.start) &&
      consumerMember(file, 'model', 'filename')
    );
  });
  const loadsProducer = calls.some(
    (call) =>
      imported.start <= call.start &&
      call.end <= imported.end &&
      call.callee.type === 'MemberExpression' &&
      !call.callee.computed &&
      call.callee.object.type === 'ThisExpression' &&
      propertyName(call.callee.property) === 'load' &&
      call.arguments.length === 1 &&
      identifierName(call.arguments[0]) === 'filename',
  );
  return parsesFile && resolvesProducer && loadsProducer;
};

interface NativeConsumerContext {
  readonly appRoot: string;
  readonly evaluate: ReturnType<typeof finiteConsumer>;
  readonly factsByPath: ReadonlyMap<string, SourceFacts>;
  readonly path: Path.Path;
  readonly workspace: string;
}
const nativeLintCallEvidence = (
  context: NativeConsumerContext,
  facts: SourceFacts,
  call: ModelCall,
): KnipModelEvidence[] => {
  const { appRoot, evaluate, factsByPath, path, workspace } = context;
  const evidence: KnipModelEvidence[] = [];

  const cwd = evaluate(facts, call.arguments[2], call.start);
  const config = evaluate(facts, call.arguments[0], call.start);
  const files = evaluate(facts, call.arguments[1], call.start);
  if (
    cwd?.length !== 1 ||
    cwd[0] !== path.resolve(appRoot) ||
    config?.length !== 1 ||
    files === undefined ||
    files.length === 0
  ) {
    return [];
  }
  const configFile = path.relative(appRoot, config[0]);
  if (!factsByPath.has(configFile)) {
    return [];
  }
  evidence.push(
    evidenceAt(
      facts,
      workspace,
      'file',
      configFile,
      call.start,
      'Native Oxlint -c argument loads this exact configuration',
    ),
    evidenceAt(
      facts,
      workspace,
      'export',
      `${configFile}#default`,
      call.start,
      'Native Oxlint configuration loader reads only default',
    ),
  );
  for (const file of files) {
    const target = path.relative(appRoot, path.resolve(cwd[0], file));
    if (factsByPath.has(target) && target.includes('/fixtures/')) {
      // These exact CLI input documents are roots, not a directory-wide fixture exemption.
      evidence.push(
        evidenceAt(
          facts,
          workspace,
          'entry',
          target,
          call.start,
          'Native Oxlint argv parses this exact fixture input document',
        ),
      );
    }
  }

  return evidence;
};
const nativeFactoryCallEvidence = (
  context: NativeConsumerContext,
  facts: SourceFacts,
  call: ModelCall,
): KnipModelEvidence[] => {
  const { appRoot, evaluate, factsByPath, path, workspace } = context;
  const evidence: KnipModelEvidence[] = [];

  const consumers = evaluate(facts, call.arguments[0], call.start);
  const sources = evaluate(facts, call.arguments[1], call.start);
  const names = evaluate(facts, call.arguments[2], call.start);
  if (consumers?.length !== 1 || sources === undefined || names?.length !== 1) {
    return [];
  }
  const consumer = path.relative(appRoot, consumers[0]);
  if (!factsByPath.has(consumer) || !consumer.includes('/fixtures/')) {
    return [];
  }
  evidence.push(
    evidenceAt(
      facts,
      workspace,
      'file',
      consumer,
      call.start,
      'Native factory parser reads this exact consumer source',
    ),
  );
  for (const source of sources) {
    const target = path.normalize(path.join(path.dirname(consumer), source));
    const owner = factsByPath.get(target);
    if (!source.startsWith('.') || owner === undefined) {
      continue;
    }
    evidence.push(
      evidenceAt(
        facts,
        workspace,
        'file',
        target,
        call.start,
        'Native factory parser reads this exact relative producer',
      ),
    );
    if (exportedBindings(owner).some((binding) => binding.kind === 'export' && binding.name === names[0])) {
      evidence.push(
        evidenceAt(
          facts,
          workspace,
          'export',
          `${target}#${names[0]}`,
          call.start,
          'Native factory parser looks up this exact exported factory name',
        ),
      );
    }
  }

  return evidence;
};
const nativeLintInput = (
  facts: SourceFacts,
  current: WorkspaceConfig,
  directory: string,
  inputs: ReadonlySet<string>,
  path: Path.Path,
): boolean =>
  inputs.has(path.basename(facts.file, '.test.mts')) &&
  path.dirname(facts.file) === directory &&
  (current.entry ?? []).some((pattern) => nodePath.matchesGlob(facts.file, pattern));
const lintConsumerEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  appRoot: string,
  workspace: string,
  current: WorkspaceConfig,
  path: Path.Path,
): KnipModelEvidence[] => {
  if (workspace !== '.') {
    return [];
  }
  const directory = 'tools/oxlint/effect-native/tests';
  const harnessFile = `${directory}/oxlint.mts`;
  const parserFile = 'tools/oxlint/anti-slop/effect/rules/data-factory-proof.ts';
  const harness = factsByPath.get(harnessFile);
  const parser = factsByPath.get(parserFile);
  const lint = harness !== undefined && nativeLintHarness(harness);
  const parse = parser !== undefined && nativeFactoryParser(parser);
  const evaluate = finiteConsumer(factsByPath, appRoot, path);
  const context = { appRoot, evaluate, factsByPath, path, workspace };
  const evidence: KnipModelEvidence[] = [];
  const inputs = new Set([
    'decoded-unknown-parameter',
    'generic-json-canonicalizer',
    'known-value-widening',
    'native-service-factory-import',
    'owner-data-decoder',
    'schema-value-constructor',
  ]);
  for (const facts of factsByPath.values()) {
    if (!nativeLintInput(facts, current, directory, inputs, path)) {
      continue;
    }
    for (const call of sourceCalls(facts)) {
      if (call.callee.type !== 'Identifier' || !calledTestContains(facts, call.start)) {
        continue;
      }
      const imported = consumerImport(facts, call.callee.name, call.start);
      const producer =
        imported?.source.startsWith('.') === true ? path.normalize(path.join(directory, imported.source)) : undefined;
      if (lint && producer === harnessFile && imported?.name === 'runOxlint') {
        evidence.push(...nativeLintCallEvidence(context, facts, call));
      }
      if (parse && producer === parserFile && imported?.name === 'provesDataFactoryImport') {
        evidence.push(...nativeFactoryCallEvidence(context, facts, call));
      }
    }
  }
  return evidence;
};

/** Reflect only named namespace reads after a proven native Vitest importActual assignment. */
interface VitestConsumerContext extends NativeConsumerContext {
  readonly aliasPaths: ReadonlyMap<string, string>;
  readonly included: readonly string[] | undefined;
}
const vitestAliasPaths = (
  config: SourceFacts,
  options: ObjectExpression,
  evaluate: ReturnType<typeof finiteConsumer>,
): Map<string, string> => {
  const resolve = objectValue(options, 'resolve');
  const aliases = resolve?.type === 'ObjectExpression' ? objectValue(resolve, 'alias') : undefined;
  const aliasPaths = new Map<string, string>();
  if (aliases?.type === 'ObjectExpression') {
    for (const property of aliases.properties) {
      if (property.type !== 'Property' || property.computed) {
        continue;
      }
      const key = propertyName(property.key);
      const values = evaluate(config, property.value, property.start);
      if (key !== undefined && values?.length === 1) {
        aliasPaths.set(key, values[0]);
      }
    }
  }
  return aliasPaths;
};
const vitestIsInvoked = (manifest: typeof PackageSchema.Type): boolean =>
  (manifest.dependencies?.vitest ?? manifest.devDependencies?.vitest) !== undefined &&
  Object.values(manifest.scripts ?? {}).some((command) => /^(?:pnpm exec )?vitest(?: |$)/u.test(command));
const vitestConfiguration = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  workspace: string,
  appRoot: string,
  path: Path.Path,
): VitestConsumerContext | undefined => {
  if (!vitestIsInvoked(manifest)) {
    return undefined;
  }
  const config = factsByPath.get(`${prefix}vitest.config.ts`);
  const exported = config?.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  if (
    config === undefined ||
    exported?.type !== 'ExportDefaultDeclaration' ||
    exported.declaration.type !== 'CallExpression' ||
    !isConsumerFunction(config, exported.declaration.callee, 'vitest/config', 'defineConfig', exported.start)
  ) {
    return undefined;
  }
  const [options] = exported.declaration.arguments;
  if (options?.type !== 'ObjectExpression') {
    return undefined;
  }
  const test = objectValue(options, 'test');
  if (test?.type === 'ObjectExpression' && objectValue(test, 'exclude') !== undefined) {
    return undefined;
  }
  const include = test?.type === 'ObjectExpression' ? objectValue(test, 'include') : undefined;
  const evaluate = finiteConsumer(factsByPath, appRoot, path);
  const included = include === undefined ? undefined : evaluate(config, include, include.start);
  if (include !== undefined && included === undefined) {
    return undefined;
  }
  const aliasPaths = vitestAliasPaths(config, options, evaluate);
  return { aliasPaths, appRoot, evaluate, factsByPath, included, path, workspace };
};
const vitestNamespaceState = (facts: SourceFacts) => {
  const bindings = new Map<string, Node>();
  for (const statement of facts.program.body) {
    if (statement.type !== 'VariableDeclaration') {
      continue;
    }
    for (const binding of statement.declarations) {
      if (binding.id.type === 'Identifier' && binding.init === null) {
        bindings.set(binding.id.name, binding.id);
      }
    }
  }
  const assignments = new Map<string, Extract<Node, { type: 'AssignmentExpression' }>[]>();
  new Visitor({
    AssignmentExpression: (node) => {
      if (node.left.type !== 'Identifier') {
        return;
      }
      const previous = assignments.get(node.left.name) ?? [];
      assignments.set(node.left.name, [...previous, node]);
    },
  }).visit(facts.program);
  return { assignments, bindings };
};
const vitestProducer = (
  context: VitestConsumerContext,
  facts: SourceFacts,
  specifier: string,
): SourceFacts | undefined => {
  const { aliasPaths, appRoot, factsByPath, path } = context;
  let resolved: string | undefined;
  if (specifier.startsWith('.')) {
    resolved = path.resolve(appRoot, path.dirname(facts.file), specifier);
  }
  for (const [alias, directory] of aliasPaths) {
    if (specifier.startsWith(`${alias}/`)) {
      resolved = path.resolve(directory, specifier.slice(alias.length + 1));
    }
  }
  const candidates =
    resolved === undefined
      ? []
      : [resolved, ...['.ts', '.tsx', '.mts', '.js', '/index.ts'].map((extension) => resolved + extension)];
  const producer = candidates
    .map((candidate) => factsByPath.get(path.relative(appRoot, candidate)))
    .find((candidate) => candidate !== undefined);
  return producer;
};
const vitestBindingEvidence = (
  context: VitestConsumerContext,
  facts: SourceFacts,
  name: string,
  binding: Node,
  assignments: ReadonlyMap<string, readonly Extract<Node, { type: 'AssignmentExpression' }>[]>,
): KnipModelEvidence[] => {
  const { workspace } = context;
  const evidence: KnipModelEvidence[] = [];

  const writes = assignments.get(name);
  const [write] = writes ?? [];
  const assignment = writes?.length === 1 ? write : undefined;
  const awaited =
    assignment?.operator === '=' && assignment.right.type === 'AwaitExpression' ? assignment.right.argument : undefined;
  if (
    assignment === undefined ||
    scopedVariables(facts, assignment.start).get(name) !== binding ||
    awaited?.type !== 'CallExpression' ||
    awaited.optional ||
    awaited.arguments.length !== 1 ||
    consumerIdentity(facts, awaited.callee, awaited.start) !== 'vitest#vi.importActual'
  ) {
    return [];
  }
  const hook = sourceCalls(facts).some((call) => {
    const [callback] = call.arguments;
    return (
      isConsumerFunction(facts, call.callee, 'vitest', 'beforeEach', call.start) &&
      callback?.type === 'ArrowFunctionExpression' &&
      callback.async &&
      callback.body.type === 'BlockStatement' &&
      callback.body.body.some(
        (statement) => statement.type === 'ExpressionStatement' && statement.expression === assignment,
      )
    );
  });
  if (!hook) {
    return [];
  }
  const specifier = staticString(awaited.arguments[0], new Map());
  if (specifier === undefined) {
    return [];
  }
  const producer = vitestProducer(context, facts, specifier);
  if (producer === undefined) {
    return [];
  }
  const exports = new Set(exportedBindings(producer).flatMap((item) => (item.kind === 'export' ? [item.name] : [])));
  new Visitor({
    MemberExpression: (node) => {
      const member = propertyName(node.property);
      if (
        identifierName(node.object) !== name ||
        scopedVariables(facts, node.start).get(name) !== binding ||
        node.computed ||
        member === undefined ||
        !exports.has(member)
      ) {
        return;
      }
      evidence.push(
        evidenceAt(
          facts,
          workspace,
          'export',
          `${producer.file}#${member}`,
          node.start,
          'Native Vitest beforeEach importActual namespace reads this exact exported member through its configured alias',
        ),
      );
    },
  }).visit(facts.program);
  return evidence;
};
const vitestActualEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  workspace: string,
  appRoot: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const context = vitestConfiguration(factsByPath, manifest, prefix, workspace, appRoot, path);
  if (context === undefined) {
    return [];
  }
  const evidence: KnipModelEvidence[] = [];
  for (const facts of factsByPath.values()) {
    const localFile = path.relative(prefix || '.', facts.file);
    if (
      context.included === undefined
        ? !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(localFile)
        : !context.included.some((pattern) => nodePath.matchesGlob(localFile, pattern))
    ) {
      continue;
    }
    const { assignments, bindings } = vitestNamespaceState(facts);
    for (const [name, binding] of bindings) {
      evidence.push(...vitestBindingEvidence(context, facts, name, binding, assignments));
    }
  }
  return evidence;
};

type ModelCall = Extract<Node, { type: 'CallExpression' }>;

const nativeModelCall = (facts: SourceFacts, node: Node | undefined, module: string, name: string): boolean =>
  node?.type === 'CallExpression' && !node.optional && isConsumerFunction(facts, node.callee, module, name, node.start);

const statementExpressions = (statement: Node): readonly Node[] => {
  if (statement.type === 'ExpressionStatement') {
    return [statement.expression];
  }
  if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
    return [];
  }
  return statement.declarations.flatMap((binding) => (binding.init === null ? [] : [binding.init]));
};

const nativeLayerArgument = (facts: SourceFacts, node: Node | undefined): boolean => {
  if (
    node?.type !== 'CallExpression' ||
    node.arguments.length !== 1 ||
    !nativeModelCall(facts, node, 'effect', 'Effect.scoped')
  ) {
    return false;
  }
  const [build] = node.arguments;
  if (
    build?.type !== 'CallExpression' ||
    build.arguments.length !== 1 ||
    !nativeModelCall(facts, build, 'effect', 'Layer.build')
  ) {
    return false;
  }
  const [layer] = build.arguments;
  return layer?.type === 'Identifier' && immutableModelBinding(facts, layer.name) && facts.variables.has(layer.name);
};
const nativeEffectProgram = (facts: SourceFacts, node: Node | undefined, depth = 0): boolean => {
  if (node === undefined || depth > 12) {
    return false;
  }
  if (node.type === 'Identifier') {
    return (
      immutableModelBinding(facts, node.name) && nativeEffectProgram(facts, facts.variables.get(node.name), depth + 1)
    );
  }
  if (node.type !== 'CallExpression' || node.optional) {
    return false;
  }
  if (nativeModelCall(facts, node, 'effect', 'Effect.gen')) {
    const [body] = node.arguments;
    return node.arguments.length === 1 && body?.type === 'FunctionExpression' && body.generator;
  }
  if (
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    propertyName(node.callee.property) !== 'pipe'
  ) {
    return false;
  }
  return (
    nativeEffectProgram(facts, node.callee.object, depth + 1) &&
    node.arguments.every((argument) => {
      const callee = argument.type === 'CallExpression' ? argument.callee : argument;
      return consumerIdentity(facts, callee, argument.start)?.startsWith('effect#Effect.') === true;
    })
  );
};
/** A native top-level runMain call declares an executable root, not evidence of prior execution. */
const nativeEffectCliEvidence = (facts: SourceFacts, workspace: string, path: Path.Path): KnipModelEvidence[] => {
  if (!facts.file.split('/').includes('scripts')) {
    return [];
  }
  return facts.program.body.flatMap((statement) => {
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') {
      return [];
    }
    const call = statement.expression;
    if (
      !nativeModelCall(facts, call, '@effect/platform-node', 'NodeRuntime.runMain') ||
      call.arguments.length !== 1 ||
      !(nativeLayerArgument(facts, call.arguments[0]) || nativeEffectProgram(facts, call.arguments[0]))
    ) {
      return [];
    }
    return [
      evidenceAt(
        facts,
        workspace,
        'entry',
        path.relative(workspace === '.' ? '.' : workspace, facts.file),
        call.start,
        'Native top-level NodeRuntime.runMain with a proven Effect program or scoped Layer.build CLI root; not proof of execution',
      ),
    ];
  });
};
const nativeMainStatements = (statement: Node): readonly Node[] => {
  if (
    statement.type !== 'IfStatement' ||
    statement.test.type !== 'MemberExpression' ||
    statement.test.computed ||
    statement.test.object.type !== 'MetaProperty' ||
    statement.test.object.meta.name !== 'import' ||
    statement.test.object.property.name !== 'meta' ||
    propertyName(statement.test.property) !== 'main' ||
    statement.consequent.type !== 'BlockStatement'
  ) {
    return [];
  }
  return statement.consequent.body;
};
const guardedRuntimeCall = (facts: SourceFacts, expression: Node): ModelCall | undefined => {
  const call = expression.type === 'AwaitExpression' ? expression.argument : expression;
  if (call?.type !== 'CallExpression' || call.optional || call.arguments.length !== 1) {
    return undefined;
  }
  const native = consumerIdentity(facts, call.callee, call.start);
  if (
    native === '@effect/platform-node#NodeRuntime.runMain' ||
    (expression.type === 'AwaitExpression' &&
      ['effect#Effect.runPromise', 'effect#Effect.runPromiseExit'].includes(native ?? ''))
  ) {
    return call;
  }
  return undefined;
};
const guardedEffectCliEvidence = (facts: SourceFacts, workspace: string, path: Path.Path): KnipModelEvidence[] => {
  if (!facts.file.split('/').includes('scripts')) {
    return [];
  }
  const evidence: KnipModelEvidence[] = [];
  for (const statement of facts.program.body) {
    for (const operation of nativeMainStatements(statement)) {
      for (const expression of statementExpressions(operation)) {
        const call = guardedRuntimeCall(facts, expression);
        if (call !== undefined) {
          evidence.push(
            evidenceAt(
              facts,
              workspace,
              'entry',
              path.relative(workspace === '.' ? '.' : workspace, facts.file),
              call.start,
              'Native import.meta.main guard invokes the imported Effect CLI runtime; operator entry, not proof of execution',
            ),
          );
        }
      }
    }
  }
  return evidence;
};

const nativeCommandDeclaration = (facts: SourceFacts, node: Node | undefined, depth = 0): boolean => {
  if (node === undefined || depth > 12) {
    return false;
  }
  if (node.type === 'Identifier') {
    return (
      immutableModelBinding(facts, node.name) &&
      nativeCommandDeclaration(facts, facts.variables.get(node.name), depth + 1)
    );
  }
  if (node.type === 'CallExpression' && nativeModelCall(facts, node, EFFECT_CLI_MODULE, COMMAND_MAKE_MEMBER)) {
    return node.arguments.length >= 2 && staticString(node.arguments[0], new Map()) !== undefined;
  }
  if (
    node.type !== 'CallExpression' ||
    node.optional ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    propertyName(node.callee.property) !== 'pipe'
  ) {
    return false;
  }
  return (
    nativeCommandDeclaration(facts, node.callee.object, depth + 1) &&
    node.arguments.every((argument) => nativeModelCall(facts, argument, EFFECT_CLI_MODULE, 'Command.withSubcommands'))
  );
};

const nativeCommandPipeline = (facts: SourceFacts, node: Node | undefined): boolean => {
  if (
    node?.type !== 'CallExpression' ||
    node.optional ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    propertyName(node.callee.property) !== 'pipe'
  ) {
    return false;
  }
  const command = node.callee.object;
  if (
    command.type !== 'CallExpression' ||
    !nativeModelCall(facts, command, EFFECT_CLI_MODULE, 'Command.run') ||
    command.arguments.length !== 2 ||
    !nativeCommandDeclaration(facts, command.arguments[0])
  ) {
    return false;
  }
  return node.arguments.every((argument) => {
    const callee = argument.type === 'CallExpression' ? argument.callee : argument;
    const identity = consumerIdentity(facts, callee, argument.start);
    return identity?.startsWith('effect#Effect.') === true;
  });
};

const nativeAbortSignal = (facts: SourceFacts, options: Node | undefined): boolean => {
  if (options?.type !== 'ObjectExpression' || options.properties.length !== 1) {
    return false;
  }
  const [property] = options.properties;
  if (property?.type !== 'Property' || property.computed || propertyName(property.key) !== 'signal') {
    return false;
  }
  const signal = property.value;
  if (
    signal.type !== 'MemberExpression' ||
    signal.computed ||
    propertyName(signal.property) !== 'signal' ||
    signal.object.type !== 'Identifier' ||
    !immutableModelBinding(facts, signal.object.name)
  ) {
    return false;
  }
  const controller = facts.variables.get(signal.object.name);
  return (
    controller?.type === 'NewExpression' &&
    controller.arguments.length === 0 &&
    consumerIdentity(facts, controller.callee, controller.start) === 'global#AbortController'
  );
};

const nativeCommandRuntime = (facts: SourceFacts, expression: Node): ModelCall | undefined => {
  const call = expression.type === 'AwaitExpression' ? expression.argument : expression;
  if (call?.type !== 'CallExpression') {
    return undefined;
  }
  if (nativeModelCall(facts, call, '@effect/platform-node', 'NodeRuntime.runMain')) {
    return call.arguments.length === 1 && nativeCommandPipeline(facts, call.arguments[0]) ? call : undefined;
  }
  if (expression.type !== 'AwaitExpression' || !nativeModelCall(facts, call, 'effect', 'Effect.runPromiseExit')) {
    return undefined;
  }
  return call.arguments.length === 2 &&
    nativeCommandPipeline(facts, call.arguments[0]) &&
    nativeAbortSignal(facts, call.arguments[1])
    ? call
    : undefined;
};

const nativeCommandCliEvidence = (facts: SourceFacts, workspace: string, path: Path.Path): KnipModelEvidence[] => {
  if (!facts.file.split('/').includes('scripts')) {
    return [];
  }
  const calls: ModelCall[] = [];
  for (const statement of facts.program.body) {
    for (const expression of statementExpressions(statement)) {
      const call = nativeCommandRuntime(facts, expression);
      if (call !== undefined) {
        calls.push(call);
      }
    }
  }
  return calls.map((call) =>
    evidenceAt(
      facts,
      workspace,
      'entry',
      path.relative(workspace === '.' ? '.' : workspace, facts.file),
      call.start,
      'Native top-level Command CLI invokes its imported runtime with a proven command and signal; not proof of execution',
    ),
  );
};

const nativeCliWrapper = (
  facts: SourceFacts,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const [statement] = facts.program.body;
  if (
    !facts.file.split('/').includes('scripts') ||
    facts.program.body.length !== 1 ||
    statement?.type !== 'ImportDeclaration' ||
    statement.importKind === 'type' ||
    statement.specifiers.length !== 0 ||
    !statement.source.value.startsWith('.')
  ) {
    return [];
  }
  const producer = factsByPath.get(path.normalize(path.join(path.dirname(facts.file), statement.source.value)));
  if (producer === undefined || nativeCommandCliEvidence(producer, workspace, path).length === 0) {
    return [];
  }
  const usage = `node ${facts.file}`;
  const comment = facts.source.slice(0, statement.start);
  const offset = comment.indexOf(usage);
  const following = comment[offset + usage.length];
  if (offset === -1 || (following !== undefined && !/\s/u.test(following))) {
    return [];
  }
  return [
    evidenceAt(
      facts,
      workspace,
      'entry',
      path.relative(workspace === '.' ? '.' : workspace, facts.file),
      offset,
      `Documented direct-node wrapper side-effect imports the proven unguarded native Command CLI ${producer.file}; not proof of execution`,
    ),
  ];
};
const nativeCliWrapperEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] =>
  [...factsByPath.values()].flatMap((facts) => nativeCliWrapper(facts, factsByPath, workspace, path));

const sourceEvidence = (
  facts: SourceFacts,
  workspace: string,
  directory: string,
  path: Path.Path,
  appRoot: string,
): KnipModelEvidence[] => {
  const result = [
    ...federationEvidence(facts, workspace),
    ...generatedActionPrincipalEvidence(facts, workspace),
    ...generatedActionGatewayEvidence(facts, workspace),
    ...nativeSubprocessEvidence(facts, workspace, appRoot, path),
    ...loopImportEvidence(facts, workspace, path),
    ...nativeEffectCliEvidence(facts, workspace, path),
    ...guardedEffectCliEvidence(facts, workspace, path),
    ...nativeCommandCliEvidence(facts, workspace, path),
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
      ['tools/oxlint/effect-native/tests/repository-policy.test.mts', 'repository-policy.config.ts'],
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

const returnedEffectFunction = (node: Node | undefined): (AstFunction & { body: FunctionBody }) | undefined => {
  if (node?.type !== 'CallExpression') {
    return undefined;
  }
  const [argument] = node.arguments;
  if (argument?.type !== 'FunctionExpression' || !argument.generator || argument.body === null) {
    return undefined;
  }
  const callee = node.callee.type === 'CallExpression' ? node.callee.callee : node.callee;
  return callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Effect' &&
    ['gen', 'fn'].includes(propertyName(callee.property) ?? '')
    ? { ...argument, body: argument.body }
    : undefined;
};

const modelMember = (node: Node | undefined): string | undefined => {
  if (node?.type === 'Identifier') {
    return node.name;
  }
  if (node?.type !== 'MemberExpression' || node.computed) {
    return undefined;
  }
  const host = modelMember(node.object);
  const member = propertyName(node.property);
  return host === undefined || member === undefined ? undefined : `${host}.${member}`;
};
const importsModelMember = (facts: SourceFacts, source: string, name: string): boolean =>
  facts.program.body.some(
    (statement) =>
      statement.type === 'ImportDeclaration' &&
      statement.importKind !== 'type' &&
      statement.source.value === source &&
      statement.specifiers.some(
        (specifier) =>
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind !== 'type' &&
          propertyName(specifier.imported) === name &&
          specifier.local.name === name,
      ),
  );
const nativePortJoin = (
  sink: Extract<Node, { type: 'CallExpression' }>,
  script: string,
): Extract<Node, { type: 'CallExpression' }> | undefined => {
  if (modelMember(sink.callee) !== 'ChildProcess.make' || modelMember(sink.arguments[0]) !== 'process.execPath') {
    return undefined;
  }
  const [, argv] = sink.arguments;
  const joined = argv?.type === 'ArrayExpression' ? argv.elements[0] : undefined;
  if (
    joined?.type !== 'CallExpression' ||
    joined.callee.type !== 'MemberExpression' ||
    joined.callee.object.type !== 'Identifier' ||
    propertyName(joined.callee.property) !== 'join' ||
    joined.callee.computed ||
    identifierName(joined.arguments[1]) !== script
  ) {
    return undefined;
  }
  return joined;
};
const nativePortRoot = (
  facts: SourceFacts,
  sink: Extract<Node, { type: 'CallExpression' }>,
  joined: Extract<Node, { type: 'CallExpression' }>,
  path: Path.Path,
): boolean => {
  const variables = scopedVariables(facts, sink.start);
  const pathName = joined.callee.type === 'MemberExpression' ? identifierName(joined.callee.object) : undefined;
  if (pathName === undefined) {
    return false;
  }
  const pathBinding = variables.get(pathName);
  if (pathBinding?.type !== 'YieldExpression' || modelMember(pathBinding.argument ?? undefined) !== 'Path.Path') {
    return false;
  }
  const rootName = identifierName(joined.arguments[0]);
  const cwd = staticObjectFields(sink.arguments[2])?.get('cwd');
  if (rootName === undefined || identifierName(cwd) !== rootName) {
    return false;
  }
  const root = variables.get(rootName);
  const fromUrl = root?.type === 'YieldExpression' ? root.argument : undefined;
  const url = fromUrl?.type === 'CallExpression' ? fromUrl.arguments[0] : undefined;
  if (
    fromUrl?.type !== 'CallExpression' ||
    modelMember(fromUrl.callee) !== `${pathName}.fromFileUrl` ||
    !isImportMetaUrl(url)
  ) {
    return false;
  }
  const relativeRoot = staticString(url.arguments[0], variables);
  return relativeRoot !== undefined && path.normalize(path.join(path.dirname(facts.file), relativeRoot)) === '.';
};
const isNativePortSink = (
  facts: SourceFacts,
  sink: Extract<Node, { type: 'CallExpression' }>,
  script: string,
  path: Path.Path,
): boolean => {
  const variables = scopedVariables(facts, sink.start);
  if (['ChildProcess', 'Path', 'Effect', 'process', 'URL'].some((name) => variables.has(name))) {
    return false;
  }
  if (!importsModelMember(facts, 'effect', 'Path') || !importsModelMember(facts, 'effect/process', 'ChildProcess')) {
    return false;
  }
  const joined = nativePortJoin(sink, script);
  return joined !== undefined && nativePortRoot(facts, sink, joined, path);
};

const importedPortTable = (
  facts: SourceFacts,
  name: string,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  path: Path.Path,
): { facts: SourceFacts; node: Node | undefined } | undefined => {
  for (const statement of facts.program.body) {
    if (statement.type === 'ImportDeclaration' && statement.source.value.startsWith('.')) {
      const binding = statement.specifiers.find(
        (specifier) => specifier.type === 'ImportSpecifier' && specifier.local.name === name,
      );
      const imported = factsByPath.get(path.normalize(path.join(path.dirname(facts.file), statement.source.value)));
      if (binding?.type === 'ImportSpecifier' && imported !== undefined) {
        return { facts: imported, node: imported.variables.get(propertyName(binding.imported) ?? '') };
      }
    }
  }
  return undefined;
};

/** Finite literal port tables, including one imported Effect.gen table, feed a proven native runner. */
const ownerPortEvidence = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  if (workspace !== '.') {
    return [];
  }
  const evidence: KnipModelEvidence[] = [];
  const tables = (
    node: Node | undefined,
    facts: SourceFacts,
    variables: ReadonlyMap<string, Node>,
    seen = new Set<Node>(),
  ): { facts: SourceFacts; field: Node; target: string }[] => {
    if (node === undefined || seen.has(node)) {
      return [];
    }
    const visited = new Set(seen).add(node);
    if (node.type === 'Identifier') {
      if (!immutableModelBinding(facts, node.name)) {
        return [];
      }
      const local = variables.get(node.name);
      if (local !== undefined) {
        return tables(local, facts, variables, visited);
      }
      const imported = importedPortTable(facts, node.name, factsByPath, path);
      return imported === undefined ? [] : tables(imported.node, imported.facts, imported.facts.variables, visited);
    }
    if (node.type === 'YieldExpression' && node.delegate) {
      return tables(node.argument ?? undefined, facts, variables, visited);
    }
    if (node.type === 'TSAsExpression') {
      return tables(node.expression, facts, variables, visited);
    }
    const fn = returnedEffectFunction(node);
    if (fn !== undefined) {
      if (!importsModelMember(facts, 'effect', 'Effect') || scopedVariables(facts, node.start).has('Effect')) {
        return [];
      }
      const returns = fn.body.body.filter((statement) => statement.type === 'ReturnStatement');
      if (returns.length !== 1 || returns[0]?.type !== 'ReturnStatement') {
        return [];
      }
      return tables(returns[0].argument ?? undefined, facts, scopedVariables(facts, returns[0].start), visited);
    }
    if (node.type !== 'ArrayExpression') {
      return [];
    }
    return node.elements.flatMap((element) => {
      if (element?.type === 'SpreadElement') {
        return tables(element.argument, facts, variables, visited);
      }
      const field = staticObjectFields(element ?? undefined)?.get('script');
      const target = staticString(field, variables);
      return target !== undefined && /^[\w/-]+\.[cm]?[jt]s$/u.test(target) && field !== undefined
        ? [{ facts, field, target }]
        : [];
    });
  };
  for (const facts of factsByPath.values()) {
    const processImport = facts.program.body.some(
      (statement) =>
        statement.type === 'ImportDeclaration' &&
        statement.source.value === 'effect/process' &&
        statement.specifiers.some(
          (specifier) =>
            specifier.type === 'ImportSpecifier' &&
            propertyName(specifier.imported) === 'ChildProcess' &&
            specifier.local.name === 'ChildProcess',
        ),
    );
    if (!processImport) {
      continue;
    }
    new Visitor({
      ForOfStatement: (loop) => {
        if (loop.left.type !== 'VariableDeclaration' || loop.left.kind !== 'const') {
          return;
        }
        const binding = loop.left.declarations[0]?.id;
        if (binding?.type !== 'Identifier') {
          return;
        }
        const records = tables(loop.right, facts, scopedVariables(facts, loop.start));
        if (records.length === 0) {
          return;
        }
        new Visitor({
          CallExpression: (call) => {
            if (call.start < loop.body.start || call.end > loop.body.end) {
              return;
            }
            if (call.callee.type !== 'Identifier') {
              return;
            }
            const [argument] = call.arguments;
            if (
              argument?.type !== 'MemberExpression' ||
              argument.object.type !== 'Identifier' ||
              argument.object.name !== binding.name ||
              propertyName(argument.property) !== 'script' ||
              argument.computed
            ) {
              return;
            }
            const runner = returnedEffectFunction(scopedVariables(facts, call.start).get(call.callee.name));
            const [script] = runner?.params ?? [];
            if (runner === undefined || script?.type !== 'Identifier') {
              return;
            }
            new Visitor({
              CallExpression: (sink) => {
                if (sink.start < runner.body.start || sink.end > runner.body.end) {
                  return;
                }
                if (!isNativePortSink(facts, sink, script.name, path)) {
                  return;
                }
                for (const record of records) {
                  evidence.push(
                    evidenceAt(
                      record.facts,
                      workspace,
                      'file',
                      record.target,
                      record.field.start,
                      `Literal owner port reaches native Node runner in ${facts.file}; app-root cwd and script argument are proven`,
                    ),
                  );
                }
              },
            }).visit(facts.program);
          },
        }).visit(facts.program);
      },
    }).visit(facts.program);
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

const nativeRstestConfigOptions = (facts: SourceFacts): ObjectExpression | undefined => {
  const exported = facts.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  if (
    exported?.type !== 'ExportDefaultDeclaration' ||
    exported.declaration.type !== 'CallExpression' ||
    !isConsumerFunction(facts, exported.declaration.callee, '@rstest/core', 'defineConfig', exported.start)
  ) {
    return undefined;
  }
  const [options] = exported.declaration.arguments;
  return options?.type === 'ObjectExpression' ? options : undefined;
};
const nativeRstestRoot = (facts: SourceFacts, node: Node | undefined): boolean => {
  if (node === undefined) {
    return true;
  }
  if (
    node.type !== 'MemberExpression' ||
    node.computed ||
    propertyName(node.property) !== 'pathname' ||
    node.object.type !== 'NewExpression'
  ) {
    return false;
  }
  const url = node.object;
  return (
    consumerIdentity(facts, url.callee, url.start) === 'global#URL' &&
    url.arguments.length === 2 &&
    staticString(url.arguments[0], new Map()) === '.' &&
    importedUrlBase(url.arguments[1])
  );
};
const nativeRstestInvocation = (manifest: typeof PackageSchema.Type, project: string | undefined): boolean =>
  Object.values(manifest.scripts ?? {}).some((script) =>
    script.split('&&').some((part) => {
      const words = part.trim().split(/\s+/u);
      return (
        words[0] === 'rstest' &&
        (words.length === 1 || (words.length === 3 && words[1] === '--project' && words[2] === project))
      );
    }),
  );
const nativeRstestIncludes = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  manifest: typeof PackageSchema.Type,
  prefix: string,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const config = factsByPath.get(`${prefix}rstest.config.ts`);
  const options = config === undefined ? undefined : nativeRstestConfigOptions(config);
  if (
    config === undefined ||
    options === undefined ||
    !nativeRstestInvocation(manifest, staticString(objectValue(options, 'name'), new Map())) ||
    !nativeRstestRoot(config, objectValue(options, 'root')) ||
    objectValue(options, 'exclude') !== undefined
  ) {
    return [];
  }
  const include = objectValue(options, 'include');
  if (include?.type !== 'ArrayExpression') {
    return [];
  }
  const patterns = include.elements.flatMap((node) =>
    node?.type === 'Literal' && isString(node.value) ? [node.value] : [],
  );
  if (patterns.length !== include.elements.length) {
    return [];
  }
  return [...factsByPath.values()].flatMap((facts) =>
    patterns.some((pattern) => nodePath.matchesGlob(path.relative(prefix || '.', facts.file), pattern))
      ? [
          evidenceAt(
            config,
            workspace,
            'entry',
            path.relative(prefix || '.', facts.file),
            include.start,
            'Native manifest-invoked Rstest defineConfig include selects this exact test source at its proven workspace root',
          ),
        ]
      : [],
  );
};

const nativeRouteMetaContract = Effect.fn('QualityAudit.nativeRouteMetaContract')(function* nativeRouteMetaContract(
  appRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = 'node_modules/@modern-js/ultramodern-create';
  const producer = `${root}/dist/esm/ultramodern-workspace/routes.js`;
  const consumer = `${root}/templates/workspace-scripts/generate-public-surface-assets.mjs`;
  if (!(yield* fs.exists(path.join(appRoot, producer))) || !(yield* fs.exists(path.join(appRoot, consumer)))) {
    return false;
  }
  const generated = yield* parseSource(producer, yield* fs.readFileString(path.join(appRoot, producer)));
  const loaded = yield* parseSource(consumer, yield* fs.readFileString(path.join(appRoot, consumer)));
  const render = generated.program.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'createRouteMetaModule',
  );
  const returned =
    render?.type === 'FunctionDeclaration'
      ? render.body?.body.find((node) => node.type === 'ReturnStatement')
      : undefined;
  const template = returned?.type === 'ReturnStatement' ? returned.argument : undefined;
  if (
    template?.type !== 'TemplateLiteral' ||
    template.expressions.length !== 1 ||
    template.quasis[0]?.value.cooked !== 'const routeMeta = ' ||
    template.quasis[1]?.value.cooked?.replaceAll(/\s+/gu, ' ').trim() !==
      'as const; export default routeMeta; export { routeMeta };'
  ) {
    return false;
  }
  let fallback = false;
  new Visitor({
    VariableDeclarator: (node) => {
      if (identifierName(node.id) === 'route' && node.init?.type === 'LogicalExpression') {
        fallback =
          loaded.source.slice(node.init.start, node.init.end).replaceAll(/\s+/gu, '') ===
          'module.routeMeta??module.default?.routeMeta??module.default?.default??module.default';
      }
    },
  }).visit(loaded.program);
  return (
    fallback &&
    sourceCalls(loaded).some((call) => isConsumerFunction(loaded, call.callee, 'tsx/esm/api', 'tsImport', call.start))
  );
});
const nativeRouteMetadataAliases = (
  factsByPath: ReadonlyMap<string, SourceFacts>,
  prefix: string,
  workspace: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const consumer = factsByPath.get(`${prefix}src/routes/ultramodern-route-metadata.ts`);
  if (consumer === undefined) {
    return [];
  }
  const array = unwrap(directExportInitializer(consumer, 'ultramodernRouteMetadata'), consumer.variables);
  if (array?.type !== 'ArrayExpression') {
    return [];
  }
  const evidence: KnipModelEvidence[] = [];
  for (const statement of consumer.program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      !statement.source.value.startsWith('.')
    ) {
      continue;
    }
    const file = path.normalize(
      path.join(path.dirname(consumer.file), `${statement.source.value.replace(/\.ts$/u, '')}.ts`),
    );
    const facts = factsByPath.get(file);
    const imported = statement.specifiers.find(
      (specifier) =>
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        propertyName(specifier.imported) === 'routeMeta',
    );
    const consumed =
      imported !== undefined &&
      array.elements.some((node) => identifierName(node ?? undefined) === imported.local.name);
    if (
      consumed &&
      facts !== undefined &&
      file.startsWith(`${prefix}src/routes/`) &&
      file.endsWith('/route.meta.ts') &&
      facts.variables.has('routeMeta') &&
      immutableModelBinding(facts, 'routeMeta') &&
      exportedBindings(facts).some((binding) => binding.kind === 'export' && binding.name === 'routeMeta') &&
      facts.program.body.some(
        (node) => node.type === 'ExportDefaultDeclaration' && identifierName(node.declaration) === 'routeMeta',
      )
    ) {
      evidence.push(
        evidenceAt(
          facts,
          workspace,
          'alias',
          `${file}#routeMeta/default`,
          0,
          'Native route.meta generator and loader define this exact same-binding named/default contract; generated metadata consumes the named binding',
        ),
      );
    }
  }
  return evidence;
};

const workspaceModel = Effect.fn('QualityAudit.knipWorkspaceModel')(function* buildWorkspace(
  appRoot: string,
  workspace: string,
  current: WorkspaceConfig,
  files: readonly string[],
  workspaces: readonly string[],
  routeMetaContract: boolean,
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
        entries.add(fact.target.replaceAll('[', String.raw`\[`).replaceAll(']', String.raw`\]`));
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
  for (const fact of lintConsumerEvidence(factsByPath, appRoot, workspace, current, path)) {
    add(fact);
  }
  for (const fact of nativeCliWrapperEvidence(factsByPath, workspace, path)) {
    add(fact);
  }
  evidence.push(...vitestActualEvidence(factsByPath, manifest, prefix, workspace, appRoot, path));
  for (const fact of nativeRstestIncludes(factsByPath, manifest, prefix, workspace, path)) {
    add(fact);
  }
  const pageAliases = manifestPageAliasEvidence(factsByPath, manifest, prefix, workspace, path);
  const outboxMessages = generatedOutboxMessageEvidence(factsByPath, manifest, prefix, workspace);
  const outboxSources = new Set(outboxMessages.map((fact) => fact.source));
  evidence.push(
    ...[...factsByPath.values()].flatMap((facts) =>
      generatedActionContractEvidence(facts, workspace, manifest, prefix, outboxSources),
    ),
    ...ownerPortEvidence(factsByPath, workspace, path),
    ...declarationSurfaceEvidence(factsByPath, workspace, path),
    ...modernRouteEvidence(factsByPath, manifest, prefix, workspace),
    ...catalogReadBindingEvidence(factsByPath, workspace),
    ...catalogSharedContractEvidence(factsByPath, workspace),
    ...catalogAliasEvidence(factsByPath, manifest, prefix, workspace, path),
    ...pageAliases,
    ...generatedModuleApiEvidence(factsByPath, prefix, workspace),
    ...outboxMessages,
    ...drizzleEvidence(factsByPath, prefix, workspace, path),
  );
  if (routeMetaContract) {
    evidence.push(...nativeRouteMetadataAliases(factsByPath, prefix, workspace, path));
  }
  const aliasFiles = new Set(
    evidence.flatMap((fact) => {
      if (fact.kind !== 'alias') {
        return [];
      }
      const facts = factsByPath.get(fact.source);
      if (
        pageAliases.some((pageAlias) => pageAlias.source === fact.source) &&
        (facts === undefined || !pageDuplicateSuppressionIsProven(facts, evidence, factsByPath, path))
      ) {
        return [];
      }
      return [
        path
          .relative(path.resolve(appRoot, prefix), path.resolve(appRoot, fact.source))
          .replaceAll('\\', '/')
          .replaceAll('[', String.raw`\[`)
          .replaceAll(']', String.raw`\]`),
      ];
    }),
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

const reflectedEvidence = (evidence: readonly KnipModelEvidence[]): KnipModelEvidence[] => {
  const reflectedByTarget = new Map<string, KnipModelEvidence>();
  for (const fact of evidence) {
    if (
      fact.kind === 'export' ||
      fact.kind === 'type' ||
      fact.kind === 'file' ||
      (fact.kind === 'dependency' && fact.workspace === '.' && fact.reason !== 'Module Federation remotes consumer')
    ) {
      reflectedByTarget.set(`${fact.kind}:${fact.kind === 'file' ? fact.workspace : ''}:${fact.target}`, fact);
    }
  }
  return [...reflectedByTarget.values()];
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
  const routeMetaContract = yield* nativeRouteMetaContract(appRoot);
  const allFacts = new Map<string, SourceFacts>();
  for (const workspace of directories) {
    const pattern = workspace === '.' ? '.' : `${workspace.split('/')[0]}/*`;
    const inherited = configured[workspace] ?? configured[pattern];
    if (inherited === undefined) {
      continue;
    }
    const result = yield* workspaceModel(appRoot, workspace, inherited, files, directories, routeMetaContract);
    workspaces[workspace] = result.config;
    evidence.push(...result.evidence);
    for (const [file, facts] of result.factsByPath) {
      allFacts.set(file, facts);
    }
  }
  evidence.push(...apiSchemaAliasEvidence(allFacts, appRoot, path));
  const runtime = yield* buildKnipRuntimeEvidence(appRoot);
  mergeRuntimeEvidence(workspaces, evidence, runtime);
  const reflected = reflectedEvidence(evidence);
  const directConsumers: string[] = [];
  const bindingsByFile = new Map<string, { types: string[]; values: string[] }>();
  for (const [index, fact] of reflected.entries()) {
    if (fact.kind === 'dependency') {
      directConsumers.push(`import {} from ${JSON.stringify(fact.target)};`);
    } else if (fact.kind === 'file') {
      const owner = fact.workspace === '.' ? '' : fact.workspace;
      directConsumers.push(`import {} from ${JSON.stringify(path.resolve(appRoot, owner, fact.target))};`);
    } else {
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
      entry: [...(workspaces['.'].entry ?? []), path.relative(appRoot, consumerPath).replaceAll('\\', '/')],
    };
  }
  return { config: { ...baseConfig, workspaces }, consumerSource, evidence };
});
