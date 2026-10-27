import { Effect, FileSystem, Path, Schema } from 'effect';
import { parse as parseJsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { parseSync, Visitor } from 'oxc-parser';
import type { Node, Program } from 'oxc-parser';
import { parse as parseYaml } from 'yaml';

import type { KnipModelEvidence } from './knip-model.mts';

const EFFECT_TSGO = '@effect/tsgo';
const EFFECT_PLUGIN = '@effect/language-service';
const PACKAGE_MANIFEST = 'package.json';
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const InstalledPackage = Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String }));
const WORKSPACE_CONTRACT = 'topology/reference-topology.json';
const GENERATOR_PACKAGE = '@modern-js/ultramodern-create';
const BUILD_FACADE_EXPORTS = ['ultramodernApiMarker', 'ultramodernDeliveryUnit', 'ultramodernUiMarker'];
const ROUTE_MANIFEST_EXPORTS = [
  'ultramodernLocalisedUrls',
  'ultramodernPublicRoutes',
  'ultramodernRouteConfig',
  'ultramodernRouteMetadata',
  'ultramodernRouteNamespace',
];
const WorkspaceContract = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({
      deliveryUnit: Schema.optionalKey(Schema.Struct({ unitId: Schema.String })),
      id: Schema.String,
      path: Schema.String,
    }),
    verticals: Schema.Array(
      Schema.Struct({
        deliveryUnit: Schema.optionalKey(Schema.Struct({ unitId: Schema.String })),
        path: Schema.String,
      }),
    ),
  }),
);
interface ContractApp {
  readonly deliveryUnit?: { readonly unitId: string };
  readonly path: string;
}
const ReleaseCohort = Schema.fromJsonString(
  Schema.Struct({
    packages: Schema.Array(Schema.Struct({ sourceName: Schema.String })),
  }),
);
const isContainedDirectory = (value: string): boolean =>
  value.length > 0 && !value.includes('..') && !value.startsWith('/');
const declaredNames = (source: string, names: readonly string[]): readonly string[] =>
  names.filter((name) => new RegExp(String.raw`^export\s+const\s+${name}\b`, 'mu').test(source));
const declaredCohort = (manifest: typeof Manifest.Type, cohort: readonly string[]): readonly string[] =>
  cohort.filter((name) => (manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]) !== undefined);
/** Exact `name@version` specifiers pnpm patches, which the declaring manifest must pin. */
const patchedSpecifiers = (workspaceYaml: string): readonly string[] => {
  const section = workspaceYaml.split('\npatchedDependencies:')[1]?.split(/\n(?=\S)/u)[0] ?? '';
  return [...section.matchAll(/^\s+'?(?<specifier>[^'\s:]+)'?:/gmu)].flatMap((match) => match.groups?.specifier ?? []);
};
const pinnedPatchedDependencies = (manifest: typeof Manifest.Type, specifiers: readonly string[]): readonly string[] =>
  specifiers.flatMap((specifier) => {
    const separator = specifier.lastIndexOf('@');
    const name = specifier.slice(0, separator);
    const version = specifier.slice(separator + 1);
    const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
    return declared === version ? [name] : [];
  });
const documentsBuiltInPlugin = (readme: string): boolean =>
  readme.includes('A wrapper around [TypeScript-Go]') &&
  readme.includes('Adding the `@effect/tsgo` dependency to your project.') &&
  readme.includes('Configuring your `tsconfig.json` to use the Effect Language Service plugin.') &&
  readme.includes('"name": "@effect/language-service"');
class InvalidTsconfig extends Schema.TaggedError<InvalidTsconfig>()('InvalidTsconfig', {
  file: Schema.String,
  offset: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}) {}
const Tsconfig = Schema.Struct({
  compilerOptions: Schema.optional(
    Schema.Struct({
      plugins: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
      types: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.optional(Schema.Array(Schema.String)),
  include: Schema.optional(Schema.Array(Schema.String)),
});
const parseTsconfig = Effect.fn('QualityAudit.parseTsconfig')(function* parseTsconfigEffect(
  file: string,
  source: string,
) {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(source, errors, {
    allowTrailingComma: true,
  });
  const [error] = errors;
  if (error !== undefined) {
    return yield* new InvalidTsconfig({ file, offset: error.offset });
  }
  return yield* Schema.decodeUnknownEffect(Tsconfig)(parsed);
});
const at = (
  source: string,
  text: string,
  offset: number,
  workspace: string,
  kind: KnipModelEvidence['kind'],
  target: string,
  reason: string,
): KnipModelEvidence => ({
  column: offset - text.lastIndexOf('\n', offset - 1),
  kind,
  line: text.slice(0, offset).split('\n').length,
  reason,
  source,
  target,
  workspace,
});
const contractFact = (
  contractText: string,
  anchor: string,
  workspace: string,
  kind: KnipModelEvidence['kind'],
  target: string,
  reason: string,
): KnipModelEvidence =>
  at(
    WORKSPACE_CONTRACT,
    contractText,
    Math.max(contractText.indexOf(JSON.stringify(anchor)), 0),
    workspace,
    kind,
    target,
    reason,
  );
const packageName = (specifier: string): string | undefined => {
  if (/^(?:[./#]|[a-z]+:)/u.test(specifier)) {
    return undefined;
  }
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
};
const uncomment = (file: string, source: string | undefined): string | undefined => {
  if (source === undefined) {
    return undefined;
  }
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    return undefined;
  }
  let result = source;
  for (const comment of parsed.comments) {
    result =
      result.slice(0, comment.start) +
      result.slice(comment.start, comment.end).replaceAll(/[^\n]/gu, ' ') +
      result.slice(comment.end);
  }
  return result;
};

const invokedShell = (command: string): string | undefined => {
  const { shell } = /^(?:sh|bash)\s+(?:\.\/)?(?<shell>[\w./-]+\.sh)(?:\s|$)/u.exec(command)?.groups ?? {};
  if (shell === undefined || shell.includes('..')) {
    return undefined;
  }
  return shell;
};
const cssDependencies = (cssFile: string, css: string, layoutFile: string, workspace: string): KnipModelEvidence[] => {
  const result: KnipModelEvidence[] = [];
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replaceAll(/[^\n]/gu, ' '));
  for (const match of withoutComments.matchAll(/@import\s+(?:url\(\s*)?["'](?<specifier>[^"']+)["']/gu)) {
    const { specifier = '' } = match.groups ?? {};
    const target = packageName(specifier);
    if (target === undefined || target.length === 0) {
      continue;
    }
    result.push(
      at(cssFile, css, match.index, workspace, 'dependency', target, `CSS package import reached from ${layoutFile}`),
    );
  }
  return result;
};

const WorkflowRunDefaults = Schema.Struct({
  run: Schema.optionalKey(Schema.Struct({ 'working-directory': Schema.optionalKey(Schema.String) })),
});
const Workflow = Schema.Struct({
  defaults: Schema.optionalKey(WorkflowRunDefaults),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      defaults: Schema.optionalKey(WorkflowRunDefaults),
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            run: Schema.optionalKey(Schema.String),
            'working-directory': Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});
interface ShellLine {
  readonly offset: number;
  readonly text: string;
}
const shellLines = (source: string): readonly ShellLine[] => {
  // Keep offsets while joining native continuations. Function bodies are not invocations.
  const joined = source.replaceAll(/\\\r?\n/gu, (value) => ' '.repeat(value.length));
  const topLevel = joined.replaceAll(/^[\t ]*[\w-]+\(\)[\t ]*\{[\t ]*(?:#[^\n]*)?\n[\s\S]*?^\}/gmu, (value) =>
    value.replaceAll(/[^\n]/gu, ' '),
  );
  let offset = 0;
  let quote: string | undefined;
  let hereDocument: string | undefined;
  return topLevel.split('\n').map((text) => {
    const continuedQuote = quote !== undefined;
    const inHereDocument = hereDocument !== undefined;
    if (inHereDocument) {
      if (text.trim() === hereDocument) {
        hereDocument = undefined;
      }
    } else {
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '\\' && quote !== "'") {
          index += 1;
          continue;
        }
        if (quote === undefined && character === '#' && (index === 0 || /\s/u.test(text[index - 1] ?? ''))) {
          break;
        }
        if (character === quote) {
          quote = undefined;
        } else if (quote === undefined && (character === '"' || character === "'")) {
          quote = character;
        }
      }
      hereDocument = /(?:^|\s)<<-?["']?(?<delimiter>\w+)["']?(?:\s|$)/u.exec(text)?.groups?.delimiter;
    }
    const line = { offset, text: continuedQuote || inHereDocument || quote !== undefined ? '' : text };
    offset += text.length + 1;
    return line;
  });
};
const shellWords = (line: string): readonly string[] => {
  const words: string[] = [];
  for (const match of line.matchAll(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/gu)) {
    const raw = match[0];
    if (raw.startsWith('#')) {
      break;
    }
    words.push(
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw,
    );
  }
  return words;
};
const scriptCommand = (words: readonly string[], withEnvironment: boolean): string | undefined => {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === 'env' || word === 'exec' || word === 'nohup' || /^[A-Z_][A-Z_\d]*=/u.test(word ?? '')) {
      index += 1;
    } else if (withEnvironment && word === '${WITH_ENV[@]}') {
      index += 1;
    } else if (word === 'mise' && words[index + 1] === 'exec' && words[index + 2] === '--') {
      index += 3;
    } else {
      break;
    }
  }
  if (words[index] !== 'node') {
    return undefined;
  }
  index += 1;
  while (words[index]?.startsWith('--') === true) {
    const option = words[index];
    if (
      option === '--experimental-strip-types' ||
      option === '--enable-source-maps' ||
      option === '--no-warnings' ||
      option?.startsWith('--env-file=') === true
    ) {
      index += 1;
    } else {
      return undefined;
    }
  }
  const target = words[index]?.replace(/^\.\//u, '');
  return target !== undefined && /^scripts\/[\w./-]+\.[cm]?[jt]s$/u.test(target) && !target.split('/').includes('..')
    ? target
    : undefined;
};
const forwardsArguments = (source: string, name: string): boolean => {
  if ([...source.matchAll(new RegExp(String.raw`^${name}\(\)`, 'gmu'))].length !== 1) {
    return false;
  }
  const body = new RegExp(String.raw`^${name}\(\)\s*\{[^\n]*\n(?<body>[\s\S]*?)^\}`, 'mu').exec(source)?.groups?.body;
  return (
    body !== undefined &&
    /^\s*local name="\$1"\s*$/mu.test(body) &&
    /^\s*shift\s*$/mu.test(body) &&
    /^\s*(?:if ! |nohup )?"\$@"(?:\s|$)/mu.test(body)
  );
};
const memberIs = (node: Node | undefined | null, object: string, property: string): boolean =>
  node?.type === 'MemberExpression' &&
  !node.computed &&
  node.object.type === 'Identifier' &&
  node.object.name === object &&
  node.property.type === 'Identifier' &&
  node.property.name === property;
const fieldOf = (node: Node | undefined | null, name: string): Node | undefined =>
  node?.type === 'ObjectExpression'
    ? node.properties.flatMap((property) =>
        property.type === 'Property' &&
        ((property.key.type === 'Identifier' && property.key.name === name) ||
          (property.key.type === 'Literal' && property.key.value === name))
          ? [property.value]
          : [],
      )[0]
    : undefined;
const variablesIn = (node: Node): ReadonlyMap<string, Node> => {
  const variables = new Map<string, Node>();
  const duplicates = new Set<string>();
  new Visitor({
    VariableDeclarator: (binding) => {
      if (binding.id.type === 'Identifier' && binding.init !== null) {
        if (variables.has(binding.id.name)) {
          duplicates.add(binding.id.name);
        }
        variables.set(binding.id.name, binding.init);
      }
    },
  }).visit(node);
  for (const duplicate of duplicates) {
    variables.delete(duplicate);
  }
  return variables;
};
const importsName = (program: Program, module: string, name: string): boolean =>
  program.body.some(
    (statement) =>
      statement.type === 'ImportDeclaration' &&
      statement.source.value === module &&
      statement.specifiers.some(
        (specifier) =>
          specifier.type === 'ImportSpecifier' &&
          specifier.imported.type === 'Identifier' &&
          specifier.imported.name === name &&
          specifier.local.name === name,
      ),
  );

/** Follow the exact Core entry through the native identity resolver into esbuild's entryPoints option. */
const coreWorkerTarget = (registry: string, materializer: string): string | undefined => {
  const declared = parseSync('outbox-worker-delivery.mjs', registry);
  const consumer = parseSync('materialize-outbox-worker.mjs', materializer);
  if (
    declared.errors.length > 0 ||
    consumer.errors.length > 0 ||
    !importsName(consumer.program, 'esbuild', 'build') ||
    !importsName(consumer.program, './outbox-worker-delivery.mjs', 'CORE_SYSTEM_OUTBOX_WORKER')
  ) {
    return undefined;
  }
  const descriptor = variablesIn(declared.program).get('CORE_SYSTEM_OUTBOX_WORKER');
  if (descriptor?.type !== 'CallExpression' || !memberIs(descriptor.callee, 'Object', 'freeze')) {
    return undefined;
  }
  const entry = fieldOf(descriptor.arguments[0], 'entry');
  if (entry?.type !== 'Literal' || !Schema.is(Schema.String)(entry.value)) {
    return undefined;
  }
  const variables = variablesIn(consumer.program);
  const resolver = variables.get('resolveOutboxWorkerEffect');
  const materialize = variables.get('materializeOutboxWorkerEffect');
  if (resolver?.type !== 'ArrowFunctionExpression' || materialize?.type !== 'ArrowFunctionExpression') {
    return undefined;
  }
  const resolverVariables = variablesIn(resolver);
  const selected = resolverVariables.get('entryPoint');
  const dedicated = resolverVariables.get('dedicatedCore');
  const materializerVariables = variablesIn(materialize);
  const delivery = materializerVariables.get('delivery');
  if (
    resolverVariables.has('CORE_SYSTEM_OUTBOX_WORKER') ||
    materializerVariables.has('build') ||
    selected?.type !== 'ConditionalExpression' ||
    selected.test.type !== 'Identifier' ||
    selected.test.name !== 'dedicatedCore' ||
    !memberIs(selected.consequent, 'CORE_SYSTEM_OUTBOX_WORKER', 'entry') ||
    dedicated?.type !== 'BinaryExpression' ||
    dedicated.operator !== '===' ||
    dedicated.left.type !== 'Identifier' ||
    dedicated.left.name !== 'appId' ||
    !memberIs(dedicated.right, 'CORE_SYSTEM_OUTBOX_WORKER', 'id') ||
    delivery?.type !== 'YieldExpression' ||
    delivery.argument?.type !== 'CallExpression' ||
    delivery.argument.callee.type !== 'Identifier' ||
    delivery.argument.callee.name !== 'resolveOutboxWorkerEffect'
  ) {
    return undefined;
  }
  let returnsEntry = false;
  let bundled = false;
  new Visitor({
    ReturnStatement: (statement) => {
      const returned = fieldOf(statement.argument, 'entryPoint');
      if (returned?.type === 'Identifier' && returned.name === 'entryPoint') {
        returnsEntry = true;
      }
    },
  }).visit(resolver);
  new Visitor({
    CallExpression: (call) => {
      const entries = fieldOf(call.arguments[0], 'entryPoints');
      if (
        call.callee.type === 'Identifier' &&
        call.callee.name === 'build' &&
        entries?.type === 'ArrayExpression' &&
        entries.elements.length === 1 &&
        memberIs(entries.elements[0], 'delivery', 'entryPoint')
      ) {
        bundled = true;
      }
    },
  }).visit(materialize);
  return returnsEntry &&
    bundled &&
    /^scripts\/[\w./-]+\.[cm]?[jt]s$/u.test(entry.value) &&
    !entry.value.split('/').includes('..')
    ? entry.value
    : undefined;
};

export const workspaceDirectories = Effect.fn('QualityAudit.knipWorkspaces')(function* readModelWorkspaces(
  appRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = ['.'];
  if (yield* fs.exists(path.join(appRoot, 'akros-storefront', PACKAGE_MANIFEST))) {
    workspaces.push('akros-storefront');
  }
  for (const directory of ['apps', 'verticals', 'packages', 'vendor', 'tools']) {
    const location = path.join(appRoot, directory);
    if (!(yield* fs.exists(location))) {
      continue;
    }
    for (const name of yield* fs.readDirectory(location)) {
      if (yield* fs.exists(path.join(location, name, PACKAGE_MANIFEST))) {
        workspaces.push(`${directory}/${name}`);
      }
    }
  }
  return workspaces;
});

/** Model only source-backed runtime contracts; never execute a wrapper or vendor module. */
export const buildKnipRuntimeEvidence = Effect.fn('QualityAudit.buildKnipRuntimeEvidence')(
  function* buildRuntimeEvidence(appRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const evidence: KnipModelEvidence[] = [];
    const read = Effect.fn('QualityAudit.readRuntimeModelFile')(function* readOptional(file: string) {
      return (yield* fs.exists(path.join(appRoot, file)))
        ? yield* fs.readFileString(path.join(appRoot, file))
        : undefined;
    });
    const rootScriptInvokes = Effect.fn('QualityAudit.rootScriptInvokes')(function* rootScriptInvokes(
      manifestText: string | undefined,
      frameworkCommand: string,
    ) {
      if (manifestText === undefined) {
        return false;
      }
      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(manifestText);
      return Object.values(manifest.scripts ?? {}).some((script) =>
        script.split('&&').some((step) => {
          const command = step.trim();
          return command === frameworkCommand || command.startsWith(`${frameworkCommand} `);
        }),
      );
    });
    const shellEvidence = Effect.fn('QualityAudit.shellEvidence')(function* shellEvidence(
      command: string,
      prefix: string,
      workspace: string,
    ) {
      const shell = invokedShell(command);
      if (shell === undefined) {
        return;
      }
      const file = `${prefix}${shell}`;
      const source = yield* read(file);
      if (source === undefined) {
        return;
      }
      // This recognized wrapper explicitly changes from scripts/ to its package root.
      if (!source.includes(`cd "\${script_directory}/.."`) || !source.includes('dirname -- "$0"')) {
        return;
      }
      for (const match of source.matchAll(/^\s*node\s+(?<target>[\w./-]+\.[cm]?[jt]s)(?:\s|$)/gmu)) {
        const { target } = match.groups ?? {};
        if (target !== undefined && !target.includes('..') && (yield* read(`${prefix}${target}`)) !== undefined) {
          evidence.push(
            at(
              file,
              source,
              match.index,
              workspace,
              'file',
              target,
              'Package script invokes shell wrapper; wrapper changes to package root and executes Node source',
            ),
          );
        }
      }
    });
    const testConsumerEvidence = Effect.fn('QualityAudit.testConsumerEvidence')(function* testConsumerEvidence(
      manifestFile: string,
      manifestText: string,
      commands: readonly string[],
      prefix: string,
      workspace: string,
    ) {
      // Rstest's default-config loader consumes default, not every named export.
      const config = `${prefix}rstest.config.ts`;
      if (
        commands.some((command) => /^rstest(?:\s|$)/u.test(command) && !/--config(?:\s|=)/u.test(command)) &&
        (yield* read(config)) !== undefined
      ) {
        evidence.push(
          at(
            manifestFile,
            manifestText,
            0,
            workspace,
            'file',
            'rstest.config.ts',
            'Package script invokes Rstest default configuration discovery',
          ),
          at(
            manifestFile,
            manifestText,
            0,
            workspace,
            'export',
            `${config}#default`,
            'Rstest default-config loader consumes the default export',
          ),
        );
      }
      const tsconfigFile = `${prefix}tsconfig.json`;
      const tsconfigText = yield* read(tsconfigFile);
      if (tsconfigText === undefined) {
        return;
      }
      const tsconfig = yield* parseTsconfig(tsconfigFile, tsconfigText);
      // Only the explicit directory inclusion contract is modeled here. Do not
      // turn all compiler inputs into roots or mark their exports as consumed.
      if (
        tsconfig.include?.includes('src') !== true ||
        tsconfig.exclude !== undefined ||
        tsconfig.files !== undefined ||
        !(yield* fs.exists(path.join(appRoot, prefix, 'src')))
      ) {
        return;
      }
      for (const name of yield* fs.readDirectory(path.join(appRoot, prefix, 'src'))) {
        if (name.endsWith('.type-test.ts')) {
          evidence.push(
            at(
              tsconfigFile,
              tsconfigText,
              0,
              workspace,
              'file',
              `src/${name}`,
              'TypeScript include src compiles this type-test module; exports remain audited',
            ),
          );
        }
      }
    });
    const cssEvidence = Effect.fn('QualityAudit.cssEvidence')(function* cssEvidence(
      extension: string,
      prefix: string,
      workspace: string,
    ) {
      const layoutFile = `${prefix}src/routes/layout.${extension}`;
      const layout = yield* read(layoutFile);
      if (layout === undefined) {
        return;
      }
      const parsed = parseSync(layoutFile, layout);
      if (parsed.errors.length > 0) {
        return;
      }
      for (const statement of parsed.program.body) {
        if (
          statement.type !== 'ImportDeclaration' ||
          !statement.source.value.endsWith('.css') ||
          !statement.source.value.startsWith('./')
        ) {
          continue;
        }
        const cssFile = path.join(prefix, 'src/routes', statement.source.value);
        const css = yield* read(cssFile);
        if (css !== undefined) {
          evidence.push(...cssDependencies(cssFile, css, layoutFile, workspace));
        }
      }
    });
    const federationEvidence = Effect.fn('QualityAudit.federationEvidence')(function* federationEvidence(
      prefix: string,
      workspace: string,
    ) {
      const federationFile = `${prefix}module-federation.config.ts`;
      const federation = uncomment(federationFile, yield* read(federationFile));
      if (
        federation?.includes("from '@modern-js/app-tools-extensions/config'") === true &&
        /resolveEffectTsgoCompiler\s*\(\s*\{\s*from:\s*import\.meta\.url\s*,?\s*\}\s*\)/u.test(federation)
      ) {
        const offset = federation.indexOf('resolveEffectTsgoCompiler');
        evidence.push(
          at(
            federationFile,
            federation,
            offset,
            workspace,
            'dependency',
            EFFECT_TSGO,
            'Framework DTS resolver resolves the Effect TSGo package from this configuration module',
          ),
        );
        const readmeFile = `${prefix}node_modules/@effect/tsgo/README.md`;
        const readme = yield* read(readmeFile);
        if (readme?.includes('tries `typescript`, then `@typescript/native`') === true) {
          evidence.push(
            at(
              federationFile,
              federation,
              offset,
              workspace,
              'dependency',
              '@typescript/native',
              `Effect TSGo native compiler fallback documented in ${readmeFile}`,
            ),
          );
        }
      }
    });
    const zeropsEvidence = Effect.fn('QualityAudit.zeropsEvidence')(function* zeropsEvidence() {
      // Zerops buildCommands run from the repository root and explicitly cd into app.
      for (const file of ['zerops.yaml', 'zerops.yml']) {
        const source = yield* read(file);
        if (source === undefined) {
          continue;
        }
        for (const match of source.matchAll(
          /^\s*-\s+cd app && (?:[A-Z_]+=\S+\s+)*node\s+(?<target>[\w./-]+\.[cm]?[jt]s)(?:\s|$)/gmu,
        )) {
          const { target } = match.groups ?? {};
          if (target !== undefined && !target.includes('..') && (yield* read(target)) !== undefined) {
            evidence.push(
              at(
                file,
                source,
                match.index,
                '.',
                'file',
                target,
                'Zerops build command changes to app and invokes this Node source',
              ),
            );
          }
        }
      }
    });
    const nativeScriptFact = Effect.fn('QualityAudit.nativeScriptFact')(function* nativeScriptFact(
      file: string,
      source: string,
      offset: number,
      target: string | undefined,
      reason: string,
    ) {
      if (target !== undefined && (yield* read(target)) !== undefined) {
        evidence.push(at(file, source, offset, '.', 'file', target, reason));
      }
    });
    const workflowScriptEvidence = Effect.fn('QualityAudit.workflowScriptEvidence')(function* workflowScriptEvidence() {
      const workflowDirectory = '../.github/workflows';
      if (!(yield* fs.exists(path.join(appRoot, workflowDirectory)))) {
        return;
      }
      for (const name of yield* fs.readDirectory(path.join(appRoot, workflowDirectory))) {
        if (!/\.ya?ml$/u.test(name)) {
          continue;
        }
        const file = `${workflowDirectory}/${name}`;
        const source = yield* read(file);
        if (source === undefined) {
          continue;
        }
        const document: unknown = yield* Effect.try(() => parseYaml(source));
        const workflow = yield* Schema.decodeUnknownEffect(Workflow)(document);
        for (const job of Object.values(workflow.jobs)) {
          for (const step of job.steps ?? []) {
            if (step.run === undefined || /^\s*node\s*\(\)/mu.test(step.run)) {
              continue;
            }
            let workingDirectory =
              step['working-directory'] ??
              job.defaults?.run?.['working-directory'] ??
              workflow.defaults?.run?.['working-directory'] ??
              '.';
            for (const line of shellLines(step.run)) {
              const words = shellWords(line.text);
              if (words[0] === 'cd') {
                workingDirectory =
                  words.length === 2 && words[1] !== undefined && /^[\w./-]+$/u.test(words[1])
                    ? path.normalize(path.join(workingDirectory, words[1]))
                    : '';
                continue;
              }
              if (workingDirectory !== 'app' && workingDirectory !== './app') {
                continue;
              }
              yield* nativeScriptFact(
                file,
                source,
                Math.max(source.indexOf(line.text.trim()), 0),
                scriptCommand(words, false),
                'Native GitHub Actions run step executes Node from the app workspace',
              );
            }
          }
        }
      }
    });
    const demoShellScriptEvidence = Effect.fn('QualityAudit.demoShellScriptEvidence')(
      function* demoShellScriptEvidence() {
        const file = 'scripts/demo/up.sh';
        const source = yield* read(file);
        if (source === undefined || /^\s*node\s*\(\)/mu.test(source)) {
          return;
        }
        const lines = shellLines(source);
        if (
          !lines.some(({ text }) => text === 'APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"') ||
          !lines.some(({ text }) => text === 'cd "$APP"')
        ) {
          return;
        }
        const wrappers = new Set(['step', 'start'].filter((name) => forwardsArguments(source, name)));
        const withEnvironment =
          /^WITH_ENV=\(mise exec --\)$/mu.test(source) && [...source.matchAll(/^WITH_ENV(?:\+)?=/gmu)].length === 1;
        for (const line of lines) {
          const words = shellWords(line.text);
          const command = words[0] !== undefined && wrappers.has(words[0]) ? words.slice(2) : words;
          yield* nativeScriptFact(
            file,
            source,
            line.offset,
            scriptCommand(command, withEnvironment),
            'Native demo shell changes to app and forwards the invoked command through its proven wrapper',
          );
        }
      },
    );
    const coreWorkerEvidence = Effect.fn('QualityAudit.coreWorkerEvidence')(function* coreWorkerEvidence() {
      const file = 'scripts/materialize-outbox-worker.mjs';
      const consumer = yield* read(file);
      const registry = yield* read('scripts/outbox-worker-delivery.mjs');
      if (consumer === undefined || registry === undefined) {
        return;
      }
      yield* nativeScriptFact(
        file,
        consumer,
        consumer.indexOf('entryPoints:'),
        coreWorkerTarget(registry, consumer),
        'Native esbuild entryPoints consumes the Core worker selected by its imported delivery identity',
      );
    });
    const tsgoDocumentation = Effect.fn('QualityAudit.tsgoDocumentation')(function* tsgoDocumentation() {
      const readme = yield* read('node_modules/@effect/tsgo/README.md');
      const installedText = yield* read('node_modules/@effect/tsgo/package.json');
      const rootText = yield* read(PACKAGE_MANIFEST);
      if (readme === undefined || installedText === undefined || rootText === undefined) {
        return false;
      }
      const installed = yield* Schema.decodeUnknownEffect(InstalledPackage)(installedText);
      const root = yield* Schema.decodeUnknownEffect(Manifest)(rootText);
      const pinned = root.devDependencies?.[EFFECT_TSGO] ?? root.dependencies?.[EFFECT_TSGO];
      return installed.name === EFFECT_TSGO && pinned === installed.version && documentsBuiltInPlugin(readme);
    });
    const tsgoEvidence = Effect.fn('QualityAudit.tsgoEvidence')(function* tsgoEvidence() {
      const typecheckFile = PACKAGE_MANIFEST;
      const typecheck = yield* read(typecheckFile);
      const vendorTypecheck = yield* read(
        'node_modules/@modern-js/ultramodern-create/templates/workspace-scripts/ultramodern-typecheck.mjs',
      );
      const usesTsgo =
        (yield* rootScriptInvokes(typecheck, 'ultramodern-create ultramodern typecheck')) &&
        vendorTypecheck?.includes('resolveEffectTsgoCompiler({') === true &&
        vendorTypecheck.includes("from: pathToFileURL(join(workspaceRoot, 'package.json'))");
      if (usesTsgo && typecheck !== undefined) {
        evidence.push(
          at(
            typecheckFile,
            typecheck,
            typecheck.indexOf('ultramodern-create ultramodern typecheck'),
            '.',
            'dependency',
            EFFECT_TSGO,
            'Invoked framework typecheck resolves Effect TSGo from workspaceRoot/package.json',
          ),
        );
        const configFile = 'tsconfig.base.json';
        const configText = yield* read(configFile);
        if (configText !== undefined && (yield* tsgoDocumentation())) {
          const config = yield* parseTsconfig(configFile, configText);
          if (
            config.compilerOptions?.plugins?.some((plugin) => plugin.name === EFFECT_PLUGIN) === true &&
            config.compilerOptions.types?.some((name) => packageName(name) === EFFECT_PLUGIN) !== true
          ) {
            const match = /"name"\s*:\s*"@effect\/language-service"/u.exec(configText);
            if (match !== null) {
              evidence.push({
                ...at(
                  configFile,
                  configText,
                  match.index + match[0].indexOf('@effect'),
                  '.',
                  'compiler-option',
                  EFFECT_PLUGIN,
                  'Effect TSGo built-in plugin configuration namespace',
                ),
                anchor: typecheckFile,
                resolved: 'node_modules/@effect/tsgo/README.md',
              });
            }
          }
        }
      }
    });
    const readinessEvidence = Effect.fn('QualityAudit.readinessEvidence')(function* readinessEvidence() {
      const readinessFile = PACKAGE_MANIFEST;
      const readiness = yield* read(readinessFile);
      const vendorFile =
        'node_modules/@modern-js/ultramodern-create/templates/workspace-scripts/ultramodern-performance-readiness.mjs';
      const vendor = yield* read(vendorFile);
      if (
        (yield* rootScriptInvokes(readiness, 'ultramodern-create ultramodern performance-readiness')) &&
        vendor?.includes('pathToFileURL(path.join(root, configPath)).href') === true &&
        vendor.includes('import(moduleUrl)')
      ) {
        const match = /const configPath = '(?<target>[^']+)'/u.exec(vendor);
        if (match === null) {
          return;
        }
        const [, target] = match;
        if (target !== undefined && !target.includes('..') && (yield* read(target)) !== undefined) {
          evidence.push(
            at(
              vendorFile,
              vendor,
              match.index,
              '.',
              'file',
              target,
              `Invoked by ${readinessFile}; installed framework imports this exact configPath`,
            ),
          );
          if (vendor.includes('module.default ?? {}')) {
            evidence.push(
              at(
                vendorFile,
                vendor,
                vendor.indexOf('module.default ?? {}'),
                '.',
                'export',
                `${target}#default`,
                'Installed framework loader reads the imported configuration default export',
              ),
            );
          }
        }
      }
    });
    const lefthookEvidence = Effect.fn('QualityAudit.lefthookEvidence')(function* lefthookEvidence() {
      // Git hooks are repository-wide, so their config lives at the git root above the app workspace.
      const file = '../lefthook.yml';
      const source = yield* read(file);
      if (source === undefined) {
        return;
      }
      for (const match of source.matchAll(/^(?:pre-commit|pre-push):\r?\n(?<body>(?:^[ \t].*(?:\r?\n|$))*)/gmu)) {
        const { body = '' } = match.groups ?? {};
        if (/^\s+(?:commands|jobs):\s*$/mu.test(body) && /^\s+-?\s*run:\s+\S.+$/mu.test(body)) {
          evidence.push(
            at(
              file,
              source,
              match.index,
              '.',
              'dependency',
              'lefthook',
              'Configured optional Lefthook tool; this configuration does not establish hook activation or enforcement',
            ),
          );
        }
      }
    });
    // The installed generator owns the framework cohort a generated workspace
    // must declare. Read the emitted contract as source; never execute it.
    const cohortPackages = Effect.fn('QualityAudit.cohortPackages')(function* cohortPackages() {
      const source = yield* read('node_modules/@modern-js/ultramodern-create/release-cohort.json');
      if (source === undefined) {
        return [];
      }
      const cohort = yield* Schema.decodeUnknownEffect(ReleaseCohort)(source);
      return cohort.packages.map((item) => item.sourceName);
    });
    // The delegated `validate` command rejects a root that drops these, so they
    // are required workspace dependencies even though no repository source imports them.
    const buildFacadeEvidence = Effect.fn('QualityAudit.buildFacadeEvidence')(function* buildFacadeEvidence(
      contractText: string,
      app: ContractApp,
    ) {
      const unitId = app.deliveryUnit?.unitId;
      if (unitId === undefined) {
        return;
      }
      const file = `${app.path}/shared/ultramodern-build.ts`;
      const source = uncomment(file, yield* read(file));
      if (source === undefined) {
        return;
      }
      evidence.push(
        contractFact(
          contractText,
          app.path,
          '.',
          'file',
          file,
          `Workspace contract declares delivery unit ${unitId}; the framework build reads this build-identity facade`,
        ),
      );
      for (const name of declaredNames(source, BUILD_FACADE_EXPORTS)) {
        evidence.push(
          contractFact(
            contractText,
            app.path,
            '.',
            'export',
            `${file}#${name}`,
            `Framework build-identity facade export for the declared delivery unit ${unitId}`,
          ),
        );
      }
    });
    const routeManifestEvidence = Effect.fn('QualityAudit.routeManifestEvidence')(function* routeManifestEvidence(
      contractText: string,
      app: ContractApp,
    ) {
      const file = `${app.path}/src/routes/ultramodern-route-metadata.ts`;
      const source = uncomment(file, yield* read(file));
      if (source === undefined) {
        return;
      }
      for (const name of declaredNames(source, ROUTE_MANIFEST_EXPORTS)) {
        evidence.push(
          contractFact(
            contractText,
            app.path,
            '.',
            'export',
            `${file}#${name}`,
            'Generated route manifest surface owned by the framework route generator',
          ),
        );
      }
    });
    // Under the isolated store an aliased framework package resolves its own
    // cohort siblings from the workspace root, so the root must declare them.
    const rootCohortEvidence = (contractText: string, root: typeof Manifest.Type, cohort: readonly string[]) => {
      for (const name of declaredCohort(root, cohort)) {
        evidence.push(
          contractFact(
            contractText,
            WORKSPACE_CONTRACT,
            '.',
            'dependency',
            name,
            `Installed framework packages resolve the aliased cohort package ${name} from the workspace root`,
          ),
        );
      }
    };
    // A patched dependency only keeps its patched identity while the declaring
    // manifest pins the exact version pnpm patches.
    const patchedRootEvidence = Effect.fn('QualityAudit.patchedRootEvidence')(function* patchedRootEvidence(
      contractText: string,
      root: typeof Manifest.Type,
    ) {
      const workspaceYaml = yield* read('pnpm-workspace.yaml');
      if (workspaceYaml === undefined) {
        return;
      }
      for (const name of pinnedPatchedDependencies(root, patchedSpecifiers(workspaceYaml))) {
        evidence.push(
          contractFact(
            contractText,
            WORKSPACE_CONTRACT,
            '.',
            'dependency',
            name,
            `pnpm-workspace patchedDependencies pins ${name}; the root declaration keeps that patched identity resolvable`,
          ),
        );
      }
    });
    const cohortEvidence = Effect.fn('QualityAudit.cohortEvidence')(function* cohortEvidence(
      contractText: string,
      app: ContractApp,
      cohort: readonly string[],
    ) {
      const manifestText = yield* read(`${app.path}/package.json`);
      if (manifestText === undefined) {
        return;
      }
      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(manifestText);
      for (const name of declaredCohort(manifest, cohort)) {
        evidence.push(
          contractFact(
            contractText,
            app.path,
            app.path,
            'dependency',
            name,
            `Installed ${GENERATOR_PACKAGE} declares this framework cohort dependency for the contracted workspace app`,
          ),
        );
      }
    });
    // The framework command owns workspace validation, so the declared workspace
    // contract — not a repository validator implementation — is the evidence.
    const workspaceContractEvidence = Effect.fn('QualityAudit.workspaceContractEvidence')(
      function* workspaceContractEvidence() {
        const contractText = yield* read(WORKSPACE_CONTRACT);
        if (contractText === undefined) {
          return;
        }
        const contract = yield* Schema.decodeUnknownEffect(WorkspaceContract)(contractText);
        const cohort = yield* cohortPackages();
        const rootManifest = yield* Schema.decodeUnknownEffect(Manifest)(
          yield* fs.readFileString(path.join(appRoot, PACKAGE_MANIFEST)),
        );
        rootCohortEvidence(contractText, rootManifest, cohort);
        yield* patchedRootEvidence(contractText, rootManifest);
        for (const app of [contract.shell, ...contract.verticals]) {
          if (!isContainedDirectory(app.path)) {
            continue;
          }
          yield* buildFacadeEvidence(contractText, app);
          yield* routeManifestEvidence(contractText, app);
          yield* cohortEvidence(contractText, app, cohort);
        }
      },
    );
    const workspaces = yield* workspaceDirectories(appRoot);
    for (const workspace of workspaces) {
      const prefix = workspace === '.' ? '' : `${workspace}/`;
      const manifestFile = `${prefix}package.json`;
      const manifestText = yield* read(manifestFile);
      if (manifestText === undefined) {
        continue;
      }
      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(manifestText);
      const commands = Object.values(manifest.scripts ?? {});
      yield* testConsumerEvidence(manifestFile, manifestText, commands, prefix, workspace);
      for (const command of commands) {
        yield* shellEvidence(command, prefix, workspace);
      }
      for (const extension of ['tsx', 'ts', 'jsx', 'js']) {
        yield* cssEvidence(extension, prefix, workspace);
      }
      yield* federationEvidence(prefix, workspace);
    }
    yield* zeropsEvidence();
    yield* workflowScriptEvidence();
    yield* demoShellScriptEvidence();
    yield* coreWorkerEvidence();
    yield* tsgoEvidence();
    yield* readinessEvidence();
    yield* lefthookEvidence();
    yield* workspaceContractEvidence();
    return evidence;
  },
);
