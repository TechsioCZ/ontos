import { createRequire } from 'node:module';

import { Effect, FileSystem, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { parseSync, Visitor } from 'oxc-parser';
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
  name: Schema.optional(Schema.String),
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
  'zephyr:dependencies': Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

class KnipModelError extends Schema.TaggedError<KnipModelError>()('KnipModelError', {
  reason: Schema.String,
}) {}

const unprovenResolver = { kind: 'resolver-unproven' } as const;

export const KnipModelEvidenceSchema = Schema.Struct({
  anchor: Schema.optional(Schema.String),
  column: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  kind: Schema.Literals([
    'entry',
    'file',
    'dependency',
    'export',
    'type',
    'alias',
    'resolver',
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
        node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.source.value === '@modern-js/app-tools'
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
      slotStart >= 0 &&
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
    if (binding.type === 'Identifier') variables.set(binding.name, binding);
    else if (binding.type === 'AssignmentPattern') blockBinding(binding.left);
    else if (binding.type === 'RestElement') blockBinding(binding.argument);
    else if (binding.type === 'ObjectPattern') {
      for (const property of binding.properties) {
        blockBinding(property.type === 'Property' ? property.value : property.argument);
      }
    } else if (binding.type === 'ArrayPattern') {
      for (const element of binding.elements) if (element !== null) blockBinding(element);
    }
  };
  const recordDeclaration = (declaration: Node) => {
    if (declaration.type === 'VariableDeclaration') {
      for (const binding of declaration.declarations) {
        if (binding.id.type === 'Identifier' && binding.init !== null) variables.set(binding.id.name, binding.init);
        else blockBinding(binding.id);
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
    if (declaration !== null) recordDeclaration(declaration);
  }
  const recordParameters = (
    node: Extract<Node, { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }>,
  ) => {
    if (node.start <= offset && offset < node.end) {
      for (const parameter of node.params) {
        if (parameter.type === 'AssignmentPattern' && parameter.left.type === 'Identifier') {
          variables.set(parameter.left.name, parameter);
        } else blockBinding(parameter);
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
      if (node.param !== null && node.start <= offset && offset < node.end) blockBinding(node.param);
    },
    FunctionDeclaration: recordParameters,
    FunctionExpression: recordParameters,
  }).visit(facts.program);
  return variables;
};

const nativeSubprocessEvidence = (
  facts: SourceFacts,
  workspace: string,
  appRoot: string,
  path: Path.Path,
): KnipModelEvidence[] => {
  const imports = new Map<string, string>();
  for (const node of facts.program.body) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue;
    const moduleName = node.source.value.replace(/^node:/u, '');
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
      const member = specifier.type === 'ImportSpecifier' ? propertyName(specifier.imported) : '*';
      imports.set(specifier.local.name, `${moduleName}:${member}`);
    }
  }
  const providers = new Set(
    [...imports].flatMap(([name, origin]) =>
      /^(?:child_process|effect\/unstable\/process):/u.test(origin) ? [name] : [],
    ),
  );
  if (providers.size === 0) return [];
  const possibleFactory = (node: Node | undefined, seen = new Set<string>()): boolean => {
    if (node?.type === 'MemberExpression') return possibleFactory(node.object, seen);
    if (node?.type !== 'Identifier' || seen.has(node.name)) return false;
    seen.add(node.name);
    return providers.has(node.name) || possibleFactory(facts.variables.get(node.name), seen);
  };
  const mutable = new Set<string>();
  const calls: Extract<Node, { type: 'CallExpression' }>[] = [];
  const invalidate = (node: Node) => {
    if (node.type === 'Identifier') mutable.add(node.name);
    else if (node.type === 'MemberExpression') invalidate(node.object);
    else new Visitor({ Identifier: (identifier) => mutable.add(identifier.name) }).visit(node);
  };
  new Visitor({
    AssignmentExpression: (node) => invalidate(node.left),
    CallExpression: (node) => calls.push(node),
    UpdateExpression: (node) => invalidate(node.argument),
    VariableDeclaration: (node) => {
      if (node.kind !== 'const') {
        for (const declaration of node.declarations) invalidate(declaration.id);
      }
    },
  }).visit(facts.program);
  const parameters = new Map<Node, { name: string; owner: Node; index: number }>();
  for (const [name, owner] of facts.variables) {
    if (owner.type !== 'ArrowFunctionExpression' || mutable.has(name)) continue;
    owner.params.forEach((parameter, index) => {
      if (parameter.type === 'AssignmentPattern') parameters.set(parameter, { name, owner, index });
    });
  }
  const values = (raw: Node | undefined, variables: ReadonlyMap<string, Node>, seen = new Set<Node>()): Node[] => {
    if (raw === undefined || seen.has(raw)) return [];
    const visited = new Set(seen).add(raw);
    if (raw.type === 'Identifier') {
      return mutable.has(raw.name) ? [] : values(variables.get(raw.name), variables, visited);
    }
    if (raw.type === 'TSAsExpression' || raw.type === 'TSSatisfiesExpression' || raw.type === 'TSNonNullExpression') {
      return values(raw.expression, variables, visited);
    }
    if (raw.type !== 'AssignmentPattern') return [raw];
    const parameter = parameters.get(raw);
    if (parameter === undefined) return [];
    return calls.flatMap((call) => {
      if (call.callee.type !== 'Identifier' || call.callee.name !== parameter.name) return [];
      const scope = scopedVariables(facts, call.start);
      if (scope.get(parameter.name) !== parameter.owner) return [];
      const argument = call.arguments[parameter.index];
      const candidates =
        argument === undefined ? values(raw.right, facts.variables, visited) : values(argument, scope, visited);
      return candidates.filter((candidate) => staticString(candidate, new Map()) !== undefined);
    });
  };
  const ownerRoot = path.resolve(appRoot, workspace === '.' ? '' : workspace);
  const sourceFile = path.resolve(appRoot, facts.file);
  const evidence: KnipModelEvidence[] = [];
  const record = (call: Extract<Node, { type: 'CallExpression' }>) => {
    if (!possibleFactory(call.callee)) return;
    const variables = scopedVariables(facts, call.start);
    const immutableValue = (raw: Node | undefined): Node | undefined => {
      const candidates = values(raw, variables);
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const literalStrings = (raw: Node | undefined): string[] =>
      values(raw, variables).flatMap((value) => {
        const literal = staticString(value, new Map());
        return literal === undefined ? [] : [literal];
      });
    const identity = (raw: Node | undefined, seen = new Set<string>()): string | undefined => {
      if (raw?.type === 'Identifier') {
        if (mutable.has(raw.name) || seen.has(raw.name)) return undefined;
        seen.add(raw.name);
        return variables.has(raw.name)
          ? identity(variables.get(raw.name), seen)
          : (imports.get(raw.name) ??
              (raw.name === 'process' || raw.name === 'URL' ? `global:${raw.name}` : undefined));
      }
      if (raw?.type !== 'MemberExpression' || (raw.computed && raw.property.type !== 'Literal')) return undefined;
      const host = identity(raw.object, seen);
      const member = propertyName(raw.property);
      return host === undefined || member === undefined ? undefined : `${host}.${member}`;
    };
    const factory = identity(call.callee);
    if (
      !['child_process:spawn', 'child_process:*.spawn', 'effect/unstable/process:ChildProcess.make'].includes(
        factory ?? '',
      )
    )
      return;
    if (!['global:process.execPath', 'process:*.execPath'].includes(identity(call.arguments[0]) ?? '')) return;
    const argv = immutableValue(call.arguments[1]);
    if (argv?.type !== 'ArrayExpression') return;
    const resolvePaths = (raw: Node | undefined, cwd: string): string[] =>
      values(raw, variables).flatMap((value) => {
        const literal = staticString(value, new Map());
        if (literal !== undefined) return [path.resolve(cwd, literal)];
        if (value.type === 'MemberExpression' && !value.computed && propertyName(value.property) === 'pathname') {
          const url = value.object;
          if (
            url.type !== 'NewExpression' ||
            identity(url.callee) !== 'global:URL' ||
            !importedUrlBase(url.arguments[1])
          )
            return [];
          return literalStrings(url.arguments[0]).map((target) => path.resolve(path.dirname(sourceFile), target));
        }
        if (
          value.type !== 'CallExpression' ||
          !['path:*.resolve', 'path:resolve', 'path:*.join', 'path:join'].includes(identity(value.callee) ?? '')
        )
          return [];
        const segments = value.arguments.map((argument) => literalStrings(argument));
        if (!segments.every((segment) => segment.length === 1)) return [];
        const parts = segments.flat();
        const operation = identity(value.callee);
        return [
          operation?.endsWith('.join') || operation === 'path:join'
            ? path.resolve(cwd, path.join(...parts))
            : path.resolve(cwd, ...parts),
        ];
      });
    const optionsValue = immutableValue(call.arguments[2]);
    const options = optionsValue?.type === 'ObjectExpression' ? optionsValue : undefined;
    if (call.arguments[2] !== undefined && options === undefined) return;
    if (options?.properties.some((property) => property.type !== 'Property' || property.computed)) return;
    const cwdProperty = options?.properties.findLast(
      (property) => property.type === 'Property' && propertyName(property.key) === 'cwd',
    );
    if (cwdProperty?.type === 'Property' && cwdProperty.kind !== 'init') return;
    const directories = cwdProperty?.type === 'Property' ? resolvePaths(cwdProperty.value, ownerRoot) : [ownerRoot];
    if (directories.length === 0) return;
    for (const argument of argv.elements) {
      const options = literalStrings(argument ?? undefined);
      if (
        options.length === 1 &&
        ['--experimental-strip-types', '--enable-source-maps', '--no-warnings'].includes(options[0])
      )
        continue;
      if (options.some((option) => option.startsWith('-'))) return;
      for (const cwd of directories) {
        for (const target of resolvePaths(argument ?? undefined, cwd)) {
          if (/\.[cm]?[jt]s$/u.test(target))
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
      return;
    }
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
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageSchema))(
    yield* fs.readFileString(path.join(appRoot, manifestFile)),
  );
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
    for (const candidate of resolverEvidence(facts, workspace, appRoot, path)) {
      const proof = yield* proveResolverOwnership(candidate);
      if (proof !== null) {
        evidence.push(proof);
      }
    }
    const directory = path.dirname(path.relative(path.resolve(appRoot, prefix), path.resolve(appRoot, file)));
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
  for (const workspace of directories) {
    const pattern = workspace === '.' ? '.' : `${workspace.split('/')[0]}/*`;
    const inherited = configured[workspace] ?? configured[pattern];
    if (inherited === undefined) {
      continue;
    }
    const result = yield* workspaceModel(appRoot, workspace, inherited, files, directories);
    workspaces[workspace] = result.config;
    evidence.push(...result.evidence);
  }
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
