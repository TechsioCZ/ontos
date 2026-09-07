import { Effect, FileSystem, Path, Schema } from 'effect';
import { parse as parseJsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { parseSync } from 'oxc-parser';
import type { KnipModelEvidence } from './knip-model.mts';

const EFFECT_TSGO = '@effect/tsgo';
const EFFECT_PLUGIN = '@effect/language-service';
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const InstalledPackage = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, version: Schema.String }),
);
const documentsBuiltInPlugin = (readme: string): boolean =>
  readme.includes('A wrapper around [TypeScript-Go]') &&
  readme.includes('Adding the `@effect/tsgo` dependency to your project.') &&
  readme.includes('Configuring your `tsconfig.json` to use the Effect Language Service plugin.') &&
  readme.includes('"name": "@effect/language-service"');
class InvalidTsconfig extends Schema.TaggedError<InvalidTsconfig>()('InvalidTsconfig', {
  file: Schema.String,
  offset: Schema.Number,
}) {}
const Tsconfig = Schema.Struct({
  compilerOptions: Schema.optional(
    Schema.Struct({
      plugins: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
      types: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const parseTsconfig = Effect.fn('QualityAudit.parseTsconfig')(function* parseTsconfigEffect(
  file: string,
  source: string,
) {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
  const [error] = errors;
  if (error !== undefined) {
    yield* new InvalidTsconfig({ file, offset: error.offset });
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
const packageName = (specifier: string): string | undefined => {
  if (/^(?:[./#]|[a-z]+:)/u.test(specifier)) {
    return undefined;
  }
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
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
  const shell = /^(?:sh|bash)\s+(?:\.\/)?(?<shell>[\w./-]+\.sh)(?:\s|$)/u.exec(command)?.groups
    ?.shell;
  if (shell === undefined || shell.includes('..')) {
    return undefined;
  }
  return shell;
};
const cssDependencies = (
  cssFile: string,
  css: string,
  layoutFile: string,
  workspace: string,
): KnipModelEvidence[] => {
  const result: KnipModelEvidence[] = [];
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) =>
    comment.replaceAll(/[^\n]/gu, ' '),
  );
  for (const match of withoutComments.matchAll(
    /@import\s+(?:url\(\s*)?["'](?<specifier>[^"']+)["']/gu,
  )) {
    const target = packageName(match.groups?.specifier ?? '');
    if (target === undefined || target.length === 0) {
      continue;
    }
    result.push(
      at(
        cssFile,
        css,
        match.index,
        workspace,
        'dependency',
        target,
        `CSS package import reached from ${layoutFile}`,
      ),
    );
  }
  return result;
};

export const workspaceDirectories = Effect.fn('QualityAudit.knipWorkspaces')(
  function* readModelWorkspaces(appRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaces = ['.'];
    for (const directory of ['apps', 'verticals', 'packages']) {
      const location = path.join(appRoot, directory);
      if (!(yield* fs.exists(location))) {
        continue;
      }
      for (const name of yield* fs.readDirectory(location)) {
        if (yield* fs.exists(path.join(location, name, 'package.json'))) {
          workspaces.push(`${directory}/${name}`);
        }
      }
    }
    return workspaces;
  },
);

/** Model only source-backed runtime contracts; never execute a wrapper or vendor module. */
export const buildKnipRuntimeEvidence = Effect.fn('QualityAudit.buildKnipRuntimeEvidence')(
  function* buildRuntimeEvidence(appRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const evidence: KnipModelEvidence[] = [];
    const read = Effect.fn('QualityAudit.readRuntimeModelFile')(function* readOptional(
      file: string,
    ) {
      return (yield* fs.exists(path.join(appRoot, file)))
        ? yield* fs.readFileString(path.join(appRoot, file))
        : undefined;
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
      for (const match of source.matchAll(
        /^\s*node\s+(?<target>[\w./-]+\.[cm]?[jt]s)(?:\s|$)/gmu,
      )) {
        const target = match.groups?.target;
        if (
          target !== undefined &&
          !target.includes('..') &&
          (yield* read(`${prefix}${target}`)) !== undefined
        ) {
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
    const federationEvidence = Effect.fn('QualityAudit.federationEvidence')(
      function* federationEvidence(prefix: string, workspace: string) {
        const federationFile = `${prefix}module-federation.config.ts`;
        const federation = uncomment(federationFile, yield* read(federationFile));
        if (
          federation?.includes("from '@modern-js/app-tools/config'") === true &&
          federation.includes('resolveEffectTsgoCompiler({ from: import.meta.url })')
        ) {
          const offset = federation.indexOf('resolveEffectTsgoCompiler({ from: import.meta.url })');
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
      },
    );
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
          const target = match.groups?.target;
          if (
            target !== undefined &&
            !target.includes('..') &&
            (yield* read(target)) !== undefined
          ) {
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
    const tsgoDocumentation = Effect.fn('QualityAudit.tsgoDocumentation')(
      function* tsgoDocumentation() {
        const readme = yield* read('node_modules/@effect/tsgo/README.md');
        const installedText = yield* read('node_modules/@effect/tsgo/package.json');
        const rootText = yield* read('package.json');
        if (readme === undefined || installedText === undefined || rootText === undefined) {
          return false;
        }
        const installed = yield* Schema.decodeUnknownEffect(InstalledPackage)(installedText);
        const root = yield* Schema.decodeUnknownEffect(Manifest)(rootText);
        const pinned = root.devDependencies?.[EFFECT_TSGO] ?? root.dependencies?.[EFFECT_TSGO];
        return (
          installed.name === EFFECT_TSGO &&
          pinned === installed.version &&
          documentsBuiltInPlugin(readme)
        );
      },
    );
    const tsgoEvidence = Effect.fn('QualityAudit.tsgoEvidence')(function* tsgoEvidence() {
      const typecheckFile = 'scripts/ultramodern-typecheck.mts';
      const typecheck = yield* read(typecheckFile);
      const vendorTypecheck = yield* read(
        'node_modules/@modern-js/create/templates/workspace-scripts/ultramodern-typecheck.mjs',
      );
      const usesTsgo =
        typecheck?.includes("['ultramodern', 'typecheck', ...forwardedArgs]") === true &&
        vendorTypecheck?.includes('resolveEffectTsgoCompiler({') === true &&
        vendorTypecheck.includes("from: pathToFileURL(join(workspaceRoot, 'package.json'))");
      if (usesTsgo && typecheck !== undefined) {
        evidence.push(
          at(
            typecheckFile,
            typecheck,
            typecheck.indexOf("'typecheck'"),
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
            config.compilerOptions?.plugins?.some((plugin) => plugin.name === EFFECT_PLUGIN) ===
              true &&
            config.compilerOptions.types?.some((name) => packageName(name) === EFFECT_PLUGIN) !==
              true
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
    const readinessEvidence = Effect.fn('QualityAudit.readinessEvidence')(
      function* readinessEvidence() {
        const readinessFile = 'scripts/ultramodern-performance-readiness.mts';
        const readiness = yield* read(readinessFile);
        const vendorFile =
          'node_modules/@modern-js/create/templates/workspace-scripts/ultramodern-performance-readiness.mjs';
        const vendor = yield* read(vendorFile);
        if (
          readiness?.includes("['ultramodern', 'performance-readiness', ...forwardedArgs]") ===
            true &&
          vendor?.includes('pathToFileURL(path.join(root, configPath)).href') === true &&
          vendor.includes('import(moduleUrl)')
        ) {
          const match = /const configPath = '(?<target>[^']+)'/u.exec(vendor);
          const target = match?.groups?.target;
          if (
            match !== null &&
            target !== undefined &&
            !target.includes('..') &&
            (yield* read(target)) !== undefined
          ) {
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
      },
    );
    const lefthookEvidence = Effect.fn('QualityAudit.lefthookEvidence')(
      function* lefthookEvidence() {
        const file = 'lefthook.yml';
        const source = yield* read(file);
        if (source === undefined) {
          return;
        }
        for (const match of source.matchAll(
          /^(?:pre-commit|pre-push):\r?\n(?<body>(?:^[ \t].*(?:\r?\n|$))*)/gmu,
        )) {
          const body = match.groups?.body ?? '';
          if (/^\s+commands:\s*$/mu.test(body) && /^\s+run:\s+\S.+$/mu.test(body)) {
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
      for (const command of Object.values(manifest.scripts ?? {})) {
        yield* shellEvidence(command, prefix, workspace);
      }
      for (const extension of ['tsx', 'ts', 'jsx', 'js']) {
        yield* cssEvidence(extension, prefix, workspace);
      }
      yield* federationEvidence(prefix, workspace);
    }
    yield* zeropsEvidence();
    yield* tsgoEvidence();
    yield* readinessEvidence();
    yield* lefthookEvidence();
    return evidence;
  },
);
