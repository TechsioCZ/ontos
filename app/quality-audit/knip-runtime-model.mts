/// <reference types="node" />
import { createRequire } from 'node:module';

import { Effect, FileSystem, Path, Schema } from 'effect';
import { parse as parseJsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { parseSync, Visitor } from 'oxc-parser';
import type { NewExpression, Node, Program } from 'oxc-parser';
import { parse as parseYaml } from 'yaml';

import type { KnipModelEvidence } from './knip-model.mts';

const STOREFRONT_WORKSPACE = 'akros-storefront';
const EFFECT_TSGO = '@effect/tsgo';
const EFFECT_PLUGIN = '@effect/language-service';
const PACKAGE_MANIFEST = 'package.json';
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    imports: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    workspaces: Schema.optional(Schema.Array(Schema.String)),
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
    shells: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
    verticals: Schema.Array(
      Schema.Struct({
        deliveryUnit: Schema.optionalKey(Schema.Struct({ unitId: Schema.String })),
        path: Schema.String,
      }),
    ),
  }),
);
const runtimeInitializer = (body: readonly Node[], name: string): Node | undefined => {
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration') {
      const binding = statement.declarations.find((item) => item.id.type === 'Identifier' && item.id.name === name);
      if (binding?.init !== null && binding?.init !== undefined) {
        return binding.init;
      }
    }
  }
  return undefined;
};
const runtimeSource = (source: string, node: Node | undefined): string =>
  node === undefined ? '' : source.slice(node.start, node.end).replaceAll(/\s+/gu, '');
const readinessReader = (program: Program, source: string): boolean => {
  const read = runtimeInitializer(program.body, 'readText');
  const exists = runtimeInitializer(program.body, 'exists');
  const fs = program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.source.value === 'node:fs' &&
      node.specifiers.some((item) => item.type === 'ImportDefaultSpecifier' && item.local.name === 'fs'),
  );
  return (
    fs &&
    read?.type === 'ArrowFunctionExpression' &&
    exists?.type === 'ArrowFunctionExpression' &&
    runtimeSource(source, read.body) === "fs.readFileSync(path.join(root,relativePath),'utf-8')" &&
    runtimeSource(source, exists.body) === 'fs.existsSync(path.join(root,relativePath))'
  );
};
const readinessFileArray = (program: Program): boolean => {
  const input = runtimeInitializer(program.body, 'appGeneratedFiles');
  if (
    input?.type !== 'ArrowFunctionExpression' ||
    input.body.type !== 'CallExpression' ||
    input.body.callee.type !== 'MemberExpression' ||
    input.body.callee.computed ||
    input.body.callee.property.type !== 'Identifier' ||
    input.body.callee.property.name !== 'filter' ||
    input.body.callee.object.type !== 'ArrayExpression' ||
    input.body.arguments[0]?.type !== 'Identifier' ||
    input.body.arguments[0].name !== 'exists'
  ) {
    return false;
  }
  return input.body.callee.object.elements.some(
    (item) =>
      item?.type === 'TemplateLiteral' &&
      item.expressions.length === 1 &&
      item.quasis[0]?.value.cooked === '' &&
      item.quasis[1]?.value.cooked === '/src/routes/ultramodern-route-head.tsx',
  );
};
const readinessFileReads = (program: Program, source: string): boolean => {
  const evaluate = runtimeInitializer(program.body, 'evaluateApp');
  const view = runtimeInitializer(program.body, 'readGeneratedContractView');
  if (
    evaluate?.type !== 'ArrowFunctionExpression' ||
    evaluate.body.type !== 'BlockStatement' ||
    view?.type !== 'ArrowFunctionExpression' ||
    view.body.type !== 'BlockStatement'
  ) {
    return false;
  }
  return (
    runtimeSource(source, runtimeInitializer(evaluate.body.body, 'files')) === 'appGeneratedFiles(app)' &&
    runtimeSource(source, runtimeInitializer(evaluate.body.body, 'generatedSource')) ===
      String.raw`files.map(readText).join('\n')` &&
    runtimeSource(source, runtimeInitializer(view.body.body, 'topology')) === 'readJson(topologyPath)' &&
    runtimeSource(source, runtimeInitializer(view.body.body, 'apps')) ===
      '[topology.shell,...topology.verticals,...(topology.shells??[])]'
  );
};
const readinessInvoked = (program: Program, source: string): boolean => {
  const main = runtimeInitializer(program.body, 'main');
  if (main?.type !== 'ArrowFunctionExpression' || !main.async || main.body.type !== 'BlockStatement') {
    return false;
  }
  const reports = runtimeInitializer(main.body.body, 'appReports');
  const invoked = program.body.some(
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'AwaitExpression' &&
      node.expression.argument?.type === 'CallExpression' &&
      node.expression.argument.callee.type === 'Identifier' &&
      node.expression.argument.callee.name === 'main',
  );
  return (
    invoked &&
    runtimeSource(source, runtimeInitializer(main.body.body, 'contract')) === 'readGeneratedContractView()' &&
    reports?.type === 'CallExpression' &&
    reports.callee.type === 'MemberExpression' &&
    reports.callee.object.type === 'Identifier' &&
    reports.callee.object.name === 'apps' &&
    reports.callee.property.type === 'Identifier' &&
    reports.callee.property.name === 'map' &&
    runtimeSource(source, reports).includes('evaluateApp(app,contract,config.failOn)')
  );
};
const readinessCatalog = (program: Program): boolean => {
  let declared = false;
  new Visitor({
    CallExpression: (node) => {
      const [argument] = node.arguments;
      if (
        node.callee.type !== 'Identifier' ||
        node.callee.name !== 'defineToolingCommand' ||
        argument?.type !== 'ObjectExpression'
      ) {
        return;
      }
      const fields = new Map(
        argument.properties.flatMap((item) =>
          item.type === 'Property' && !item.computed && item.key.type === 'Identifier' && item.value.type === 'Literal'
            ? [[item.key.name, item.value.value] as const]
            : [],
        ),
      );
      if (
        fields.get('command') === 'performance-readiness' &&
        fields.get('rootScript') === 'performance:readiness' &&
        fields.get('templatePath') === 'templates/workspace-scripts/ultramodern-performance-readiness.mjs'
      ) {
        declared = true;
      }
    },
  }).visit(program);
  return declared;
};

const tailwindPostcssEnabled = (file: string, source: string | undefined): boolean => {
  const configuration =
    source === undefined
      ? undefined
      : parseSync(file, source).program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  const properties =
    configuration?.type === 'ExportDefaultDeclaration' && configuration.declaration.type === 'ObjectExpression'
      ? configuration.declaration.properties
      : [];
  const plugins = properties.find(
    (node) =>
      node.type === 'Property' && !node.computed && node.key.type === 'Identifier' && node.key.name === 'plugins',
  );
  return (
    plugins?.type === 'Property' &&
    plugins.value.type === 'ObjectExpression' &&
    plugins.value.properties.some(
      (node) =>
        node.type === 'Property' &&
        !node.computed &&
        node.key.type === 'Literal' &&
        node.key.value === '@tailwindcss/postcss',
    )
  );
};

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

interface InvalidWorkflowFailure extends Error {
  readonly _tag: 'InvalidWorkflow';
  readonly file: string;
  readonly reason: string;
}
const InvalidWorkflow = Schema.TaggedError<InvalidWorkflowFailure>()('InvalidWorkflow', {
  file: Schema.String,
  reason: Schema.String,
});
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
const literalNodeCommand = (words: readonly string[], withEnvironment: boolean): string | undefined => {
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
  while (words[index]?.startsWith('--')) {
    const option = words[index];
    if (
      option === '--experimental-strip-types' ||
      option === '--enable-source-maps' ||
      option === '--no-warnings' ||
      option?.startsWith('--env-file=')
    ) {
      index += 1;
    } else {
      return undefined;
    }
  }
  const target = words[index]?.replace(/^\.\//u, '');
  return target !== undefined &&
    /^(?:[\w.-]+\/)*[\w.-]+\.[cm]?[jt]s$/u.test(target) &&
    !target.split('/').includes('..')
    ? target
    : undefined;
};
const scriptCommand = (words: readonly string[], withEnvironment: boolean): string | undefined => {
  const target = literalNodeCommand(words, withEnvironment);
  return target?.startsWith('scripts/') === true ? target : undefined;
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

const isImportMetaUrl = (node: Node | undefined): boolean =>
  node?.type === 'MemberExpression' &&
  !node.computed &&
  node.property.type === 'Identifier' &&
  node.property.name === 'url' &&
  node.object.type === 'MetaProperty' &&
  node.object.meta.name === 'import';

const nativePackageUrls = (file: string, source: string): readonly NewExpression[] => {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    return [];
  }
  let identifiers = 0;
  const urls: NewExpression[] = [];
  new Visitor({
    Identifier(node) {
      if (node.name === 'URL') {
        identifiers += 1;
      }
    },
    NewExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'URL') {
        urls.push(node);
      }
    },
  }).visit(parsed.program);
  // Any other URL identifier may declare, shadow or mutate the global constructor.
  return identifiers === urls.length ? urls : [];
};

export const workspaceDirectories = Effect.fn('QualityAudit.knipWorkspaces')(function* readModelWorkspaces(
  appRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = new Set(['.']);
  const manifest = yield* Schema.decodeUnknownEffect(Manifest)(
    yield* fs.readFileString(path.join(appRoot, PACKAGE_MANIFEST)),
  );
  for (const pattern of manifest.workspaces ?? []) {
    const manifests = yield* fs.glob(`${pattern}/${PACKAGE_MANIFEST}`, {
      exclude: ['**/node_modules/**'],
      root: appRoot,
    });
    for (const file of manifests) {
      workspaces.add(path.dirname(file));
    }
  }
  if (yield* fs.exists(path.join(appRoot, STOREFRONT_WORKSPACE, PACKAGE_MANIFEST))) {
    workspaces.add(STOREFRONT_WORKSPACE);
  }
  for (const directory of ['apps', 'verticals', 'packages', 'vendor', 'tools']) {
    const location = path.join(appRoot, directory);
    if (!(yield* fs.exists(location))) {
      continue;
    }
    for (const name of yield* fs.readDirectory(location)) {
      if (yield* fs.exists(path.join(location, name, PACKAGE_MANIFEST))) {
        workspaces.add(`${directory}/${name}`);
      }
    }
  }
  return [...workspaces];
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
    const modernServerEvidence = Effect.fn('QualityAudit.modernServerEvidence')(function* modernServerEvidence(
      manifest: typeof Manifest.Type,
      prefix: string,
      workspace: string,
    ) {
      if (
        (manifest.dependencies?.['@modern-js/app-tools'] ?? manifest.devDependencies?.['@modern-js/app-tools']) ===
          undefined ||
        !Object.values(manifest.scripts ?? {}).some((command) => /^modern (?:dev|build|serve)(?:\s|$)/u.test(command))
      ) {
        return;
      }
      const documentation = `${prefix}node_modules/@modern-js/app-tools/docs/configure/app/usage.md`;
      const contract = yield* read(documentation);
      if (contract?.includes('`server/modern.server.(ts|js|mjs)`') !== true) {
        return;
      }
      const candidates: string[] = [];
      for (const extension of ['ts', 'js', 'mjs']) {
        const file = `server/modern.server.${extension}`;
        if (yield* fs.exists(path.join(appRoot, prefix, file))) {
          candidates.push(file);
        }
      }
      const [file] = candidates;
      if (file === undefined || candidates.length !== 1) {
        return;
      }
      const source = yield* fs.readFileString(path.join(appRoot, prefix, file));
      const parsed = parseSync(file, source);
      if (
        parsed.errors.length > 0 ||
        !parsed.program.body.some((statement) => statement.type === 'ExportDefaultDeclaration')
      ) {
        return;
      }
      evidence.push(
        at(
          documentation,
          contract,
          contract.indexOf('`server/modern.server.'),
          workspace,
          'file',
          file,
          'Invoked Modern server loads its documented server runtime configuration',
        ),
        at(
          documentation,
          contract,
          contract.indexOf('`server/modern.server.'),
          workspace,
          'export',
          `${prefix}${file}#default`,
          'Modern server runtime configuration consumes its default export, not neighboring named exports',
        ),
      );
    });
    const workerdSourceEvidence = Effect.fn('QualityAudit.workerdSourceEvidence')(function* workerdSourceEvidence(
      condition: Schema.Json,
      prefix: string,
      workspace: string,
    ) {
      const workerdCondition = Schema.Struct({ workerd: Schema.String });
      if (!Schema.is(workerdCondition)(condition) || !/^\.\/[\w./-]+\.[cm]?[jt]sx?$/u.test(condition.workerd)) {
        return;
      }
      const relative = path.normalize(condition.workerd);
      if (relative.startsWith('..')) {
        return;
      }
      const file = `${prefix}${relative}`;
      const source = yield* read(file);
      if (source === undefined) {
        return;
      }
      const parsed = parseSync(file, source);
      if (parsed.errors.length > 0) {
        return;
      }
      for (const statement of parsed.program.body) {
        if (statement.type === 'ImportDeclaration' && statement.source.value === 'cloudflare:workers') {
          evidence.push({
            ...at(
              file,
              source,
              statement.source.start,
              workspace,
              'resolver',
              'cloudflare',
              'Conditional workerd source in an invoked Cloudflare build resolves the native cloudflare:workers module, not an npm package',
            ),
            anchor: `${prefix}${PACKAGE_MANIFEST}`,
            resolved: statement.source.value,
          });
        }
      }
    });
    const workerdBuiltinEvidence = Effect.fn('QualityAudit.workerdBuiltinEvidence')(function* workerdBuiltinEvidence(
      manifest: typeof Manifest.Type,
      prefix: string,
      workspace: string,
    ) {
      const buildsWorker = Object.values(manifest.scripts ?? {}).some(
        (command) =>
          /^modern build(?:\s|$)/u.test(command) && /(?:^|\s)--deploy-target(?:=|\s+)cloudflare(?:\s|$)/u.test(command),
      );
      if (!buildsWorker) {
        return;
      }
      for (const condition of Object.values(manifest.imports ?? {})) {
        yield* workerdSourceEvidence(condition, prefix, workspace);
      }
    });
    const packageUrlEvidence = Effect.fn('QualityAudit.packageUrlEvidence')(function* packageUrlEvidence(
      file: string,
      source: string,
      node: NewExpression,
      workspaces: ReadonlySet<string>,
    ) {
      const [argument, base] = node.arguments;
      if (
        argument?.type !== 'Literal' ||
        !Schema.is(Schema.String)(argument.value) ||
        !argument.value.startsWith('.') ||
        !isImportMetaUrl(base)
      ) {
        return;
      }
      const location = path.normalize(path.join(path.dirname(file), argument.value));
      const match = /^(?:(?<owner>.+)\/)?node_modules\/(?<alias>@[^/]+\/[^/]+|[^/]+)\/?$/u.exec(location);
      const owner = match?.groups?.owner ?? '.';
      const alias = match?.groups?.alias;
      if (alias === undefined || !workspaces.has(owner)) {
        return;
      }
      const owningManifest = owner === '.' ? PACKAGE_MANIFEST : `${owner}/${PACKAGE_MANIFEST}`;
      const ownerText = yield* read(owningManifest);
      const installedText = yield* read(`${location}/${PACKAGE_MANIFEST}`);
      if (ownerText === undefined || installedText === undefined) {
        return;
      }
      const declared = yield* Schema.decodeUnknownEffect(Manifest)(ownerText);
      const installed = yield* Schema.decodeUnknownEffect(InstalledPackage)(installedText);
      if ((declared.dependencies?.[alias] ?? declared.devDependencies?.[alias]) === undefined) {
        return;
      }
      evidence.push({
        ...at(
          file,
          source,
          argument.start,
          '.',
          'resolver',
          installed.name,
          `Native package URL selects declared alias ${alias} from ${owningManifest}; installed package name is ${installed.name}`,
        ),
        anchor: path.join(appRoot, owningManifest),
        owningManifest: path.join(appRoot, owningManifest),
        resolved: yield* fs.realPath(path.join(appRoot, location)),
      });
    });
    const testPackageUrlEvidence = Effect.fn('QualityAudit.testPackageUrlEvidence')(function* testPackageUrlEvidence(
      commands: readonly string[],
      workspaces: readonly string[],
    ) {
      if (!commands.some((command) => /^rstest(?:\s|$)/u.test(command))) {
        return;
      }
      const owners = new Set(workspaces);
      for (const file of yield* fs.glob('scripts/tests/**/*.test.mts', { root: appRoot })) {
        const source = yield* fs.readFileString(path.join(appRoot, file));
        for (const node of nativePackageUrls(file, source)) {
          yield* packageUrlEvidence(file, source, node, owners);
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
    const layoutCssInputs = Effect.fn('QualityAudit.layoutCssInputs')(function* layoutCssInputs(file: string) {
      const source = yield* read(file);
      if (source === undefined) {
        return [];
      }
      const parsed = parseSync(file, source);
      if (parsed.errors.length > 0) {
        return [];
      }
      return parsed.program.body.flatMap((node) =>
        node.type === 'ImportDeclaration' &&
        node.importKind !== 'type' &&
        node.source.value.startsWith('.') &&
        node.source.value.endsWith('.css')
          ? [path.resolve(appRoot, path.dirname(file), node.source.value)]
          : [],
      );
    });
    const cssImportInput = Effect.fn('QualityAudit.cssImportInput')(function* cssImportInput(
      file: string,
      specifier: string,
      declared: boolean,
    ) {
      if (specifier.startsWith('.')) {
        return path.resolve(path.dirname(file), specifier);
      }
      if (!declared) {
        return null;
      }
      const resolved = yield* Effect.try(() => createRequire(file).resolve(specifier)).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      return resolved?.endsWith('.css') === true ? resolved : null;
    });
    const nextCssDocument = Effect.fn('QualityAudit.nextCssDocument')(function* nextCssDocument(
      file: string,
      layoutFile: string,
      workspace: string,
      declarations: Readonly<Record<string, string>>,
      tailwind: boolean,
    ) {
      const cssFile = path.relative(appRoot, file);
      const source = yield* read(cssFile);
      if (source === undefined) {
        return [];
      }
      const css = source.replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replaceAll(/[^\n]/gu, ' '));
      const inputs: string[] = [];
      for (const match of css.matchAll(
        /^\s*@(?<directive>import|plugin)\s+(?:url\(\s*)?["'](?<specifier>[^"']+)["']/gmu,
      )) {
        const { directive, specifier = '' } = match.groups ?? {};
        if (directive === 'plugin' && !tailwind) {
          continue;
        }
        const dependency = packageName(specifier);
        const declared = dependency !== undefined && declarations[dependency] !== undefined;
        if (declared) {
          evidence.push(
            at(
              cssFile,
              source,
              match.index,
              workspace,
              'dependency',
              dependency,
              `Native Next layout CSS ${directive} reached through ${layoutFile}`,
            ),
          );
        }
        if (directive === 'import') {
          const target = yield* cssImportInput(file, specifier, declared);
          if (target !== null) {
            inputs.push(target);
          }
        }
      }
      return inputs;
    });
    const nextCssGraph = Effect.fn('QualityAudit.nextCssGraph')(function* nextCssGraph(
      layoutFile: string,
      workspace: string,
      declarations: Readonly<Record<string, string>>,
      tailwind: boolean,
    ) {
      const queue = yield* layoutCssInputs(layoutFile);
      const visited = new Set<string>();
      while (queue.length > 0 && visited.size < 128) {
        const file = queue.shift();
        if (file !== undefined && !visited.has(file)) {
          visited.add(file);
          queue.push(...(yield* nextCssDocument(file, layoutFile, workspace, declarations, tailwind)));
        }
      }
    });
    const nextCssEvidence = Effect.fn('QualityAudit.nextCssEvidence')(function* nextCssEvidence(
      prefix: string,
      workspace: string,
      manifest: typeof Manifest.Type,
    ) {
      if (
        (manifest.dependencies?.next ?? manifest.devDependencies?.next) === undefined ||
        !Object.values(manifest.scripts ?? {}).some((command) => /^next (?:build|dev|start)(?: |$)/u.test(command))
      ) {
        return;
      }
      const file = `${prefix}postcss.config.mjs`;
      const tailwind = tailwindPostcssEnabled(file, yield* read(file));
      const declarations = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const extension of ['tsx', 'ts', 'jsx', 'js']) {
        yield* nextCssGraph(`${prefix}src/app/layout.${extension}`, workspace, declarations, tailwind);
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
    // presetUltramodernWorkspace uploads a UI unit to Zephyr by resolving zephyr-rspack-plugin with
    // createRequire(from) at the unit's own config, so the unit's declaration is the consumed one.
    const workspacePresetEvidence = Effect.fn('QualityAudit.workspacePresetEvidence')(function* workspacePresetEvidence(
      prefix: string,
      workspace: string,
      manifest: typeof Manifest.Type,
    ) {
      const zephyr = 'zephyr-rspack-plugin';
      if (manifest.dependencies?.[zephyr] === undefined && manifest.devDependencies?.[zephyr] === undefined) {
        return;
      }
      const configFile = `${prefix}modern.config.ts`;
      const config = uncomment(configFile, yield* read(configFile));
      const preset = yield* read(
        `${prefix}node_modules/@modern-js/ultramodern-app-tools/dist/esm-node/native-composition/workspace-preset.mjs`,
      );
      if (
        config?.includes("from '@modern-js/ultramodern-app-tools'") === true &&
        /presetUltramodernWorkspace\(\s*\{[\s\S]*\{[^{}]*\bappId\b[^{}]*\bfrom:\s*import\.meta\.url\b[^{}]*\}\s*,?\s*\)/u.test(
          config,
        ) &&
        preset?.includes('const require = createRequire(from);') === true &&
        preset.includes(`require('${zephyr}')`)
      ) {
        evidence.push(
          at(
            configFile,
            config,
            config.indexOf('presetUltramodernWorkspace('),
            workspace,
            'dependency',
            zephyr,
            'presetUltramodernWorkspace resolves the Zephyr upload plugin from this configuration module',
          ),
        );
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
    const workflowNodeTarget = Effect.fn('QualityAudit.workflowNodeTarget')(function* workflowNodeTarget(
      words: readonly string[],
    ) {
      const target = literalNodeCommand(words, false);
      if (target === undefined || !(yield* fs.exists(path.join(appRoot, target)))) {
        return null;
      }
      const root = yield* fs.realPath(appRoot);
      const resolved = yield* fs.realPath(path.join(appRoot, target));
      const relative = path.relative(root, resolved);
      return relative.length > 0 && !relative.split(path.sep).includes('..') && !path.isAbsolute(relative)
        ? target
        : null;
    });
    const workflowRunEvidence = Effect.fn('QualityAudit.workflowRunEvidence')(function* workflowRunEvidence(
      file: string,
      source: string,
      run: string,
      directory: string,
    ) {
      let workingDirectory = directory;
      for (const line of shellLines(run)) {
        const words = shellWords(line.text);
        if (words[0] === 'cd') {
          workingDirectory =
            words.length === 2 && words[1] !== undefined && /^[\w./-]+$/u.test(words[1])
              ? path.normalize(path.join(workingDirectory, words[1]))
              : '';
        } else if (workingDirectory === 'app' || workingDirectory === './app') {
          yield* nativeScriptFact(
            file,
            source,
            Math.max(source.indexOf(line.text.trim()), 0),
            (yield* workflowNodeTarget(words)) ?? undefined,
            'Native GitHub Actions run step executes Node from the app workspace',
          );
        }
      }
    });
    const workflowFileEvidence = Effect.fn('QualityAudit.workflowFileEvidence')(function* workflowFileEvidence(
      file: string,
    ) {
      const source = yield* read(file);
      if (source === undefined) {
        return;
      }
      const workflow = yield* Effect.try({
        catch: (issue) => new InvalidWorkflow({ file, reason: `Invalid workflow ${file}: ${String(issue)}` }),
        try: () => Schema.decodeUnknownEffect(Workflow)(parseYaml(source)),
      }).pipe(Effect.flatten);
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (step.run !== undefined && !/^\s*(?:function\s+)?(?:node|mise|env|exec|nohup)\s*\(\)/mu.test(step.run)) {
            yield* workflowRunEvidence(
              file,
              source,
              step.run,
              step['working-directory'] ??
                job.defaults?.run?.['working-directory'] ??
                workflow.defaults?.run?.['working-directory'] ??
                '.',
            );
          }
        }
      }
    });
    const workflowScriptEvidence = Effect.fn('QualityAudit.workflowScriptEvidence')(function* workflowScriptEvidence() {
      const directory = '../.github/workflows';
      if (!(yield* fs.exists(path.join(appRoot, directory)))) {
        return;
      }
      for (const name of yield* fs.readDirectory(path.join(appRoot, directory))) {
        if (/\.ya?ml$/u.test(name)) {
          yield* workflowFileEvidence(`${directory}/${name}`);
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
    const storefrontDemoEvidence = Effect.fn('QualityAudit.storefrontDemoEvidence')(function* storefrontDemoEvidence() {
      const workspace = STOREFRONT_WORKSPACE;
      const file = `${workspace}/scripts/demo-restart.sh`;
      const source = yield* read(file);
      if (source === undefined || /^\s*(?:function\s+)?(?:node|mise|nohup)\s*\(\)/mu.test(source)) {
        return;
      }
      const lines = shellLines(source);
      const appDeclaration = `APP="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"`;
      if (
        lines.filter(({ text }) => text === appDeclaration).length !== 1 ||
        lines.filter(({ text }) => /^APP(?:\+)?=/u.test(text)).length !== 1
      ) {
        return;
      }
      let inWorkspace = false;
      for (const line of lines) {
        const words = shellWords(line.text);
        if (words[0] === 'cd') {
          inWorkspace = words.length === 2 && words[1] === '$APP';
        }
        const target = scriptCommand(words, false);
        if (
          inWorkspace &&
          words[0] !== 'cd' &&
          target !== undefined &&
          (yield* read(`${workspace}/${target}`)) !== undefined
        ) {
          evidence.push(
            at(
              file,
              source,
              line.offset,
              workspace,
              'file',
              target,
              'Native storefront demo launcher changes to its workspace and invokes this exact Node source',
            ),
          );
        }
      }
    });
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
    const readinessSourceEvidence = Effect.fn('QualityAudit.readinessSourceEvidence')(
      function* readinessSourceEvidence() {
        if (
          !(yield* rootScriptInvokes(
            yield* read(PACKAGE_MANIFEST),
            'ultramodern-create ultramodern performance-readiness',
          ))
        ) {
          return;
        }
        const vendorFile =
          'node_modules/@modern-js/ultramodern-create/templates/workspace-scripts/ultramodern-performance-readiness.mjs';
        const catalogFile =
          'node_modules/@modern-js/ultramodern-create/dist/esm/ultramodern-workspace/tooling-command-catalog.js';
        const source = yield* read(vendorFile);
        const catalog = yield* read(catalogFile);
        const contractText = yield* read(WORKSPACE_CONTRACT);
        if (source === undefined || catalog === undefined || contractText === undefined) {
          return;
        }
        const vendor = parseSync(vendorFile, source);
        const commands = parseSync(catalogFile, catalog);
        if (
          vendor.errors.length !== 0 ||
          commands.errors.length !== 0 ||
          !readinessCatalog(commands.program) ||
          !readinessReader(vendor.program, source) ||
          !readinessFileArray(vendor.program) ||
          !readinessFileReads(vendor.program, source) ||
          !readinessInvoked(vendor.program, source)
        ) {
          return;
        }
        const contract = yield* Schema.decodeUnknownEffect(WorkspaceContract)(contractText);
        for (const app of [contract.shell, ...contract.verticals, ...(contract.shells ?? [])]) {
          if (isContainedDirectory(app.path)) {
            const target = 'src/routes/ultramodern-route-head.tsx';
            if ((yield* read(`${app.path}/${target}`)) !== undefined) {
              evidence.push(
                at(
                  vendorFile,
                  source,
                  source.indexOf('/src/routes/ultramodern-route-head.tsx'),
                  app.path,
                  'file',
                  target,
                  'Native invoked performance-readiness catalog selects this exact topology app file and reads it as source data, not exported API',
                ),
              );
            }
          }
        }
      },
    );
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
      yield* modernServerEvidence(manifest, prefix, workspace);
      yield* workerdBuiltinEvidence(manifest, prefix, workspace);
      if (workspace === '.') {
        yield* testPackageUrlEvidence(commands, workspaces);
      }
      for (const command of commands) {
        yield* shellEvidence(command, prefix, workspace);
      }
      for (const extension of ['tsx', 'ts', 'jsx', 'js']) {
        yield* cssEvidence(extension, prefix, workspace);
      }
      yield* nextCssEvidence(prefix, workspace, manifest);
      yield* federationEvidence(prefix, workspace);
      yield* workspacePresetEvidence(prefix, workspace, manifest);
    }
    yield* zeropsEvidence();
    yield* workflowScriptEvidence();
    yield* demoShellScriptEvidence();
    yield* storefrontDemoEvidence();
    yield* coreWorkerEvidence();
    yield* tsgoEvidence();
    yield* readinessEvidence();
    yield* readinessSourceEvidence();
    yield* lefthookEvidence();
    yield* workspaceContractEvidence();
    return evidence;
  },
);
