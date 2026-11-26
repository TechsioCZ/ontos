import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Predicate, Schema } from 'effect';
import { afterAll, beforeAll, describe, it } from 'effect-rstest';
import { RuleTester } from 'oxlint/plugins-dev';

import effectNativePlugin from '../index.ts';
import { globToRegExp } from '../shared/paths.ts';
import { appRoot, fixtureConfigPath, fixturesDirectory } from './oxlint.mts';

/**
 * In-process rule harness. Every case lints one source text through Oxlint's own parser and rule
 * runtime, so rule behaviour is checked without starting the Oxlint binary per case.
 *
 * Cases address files by absolute path. Most paths are virtual: rules derive their scope from the
 * filename alone and nothing is written. Rules that read neighbouring files (imports, package
 * manifests, Rstest configurations) get a real workspace from `workspaceCase`, which is written
 * outside the scanned source tree before the case runs and removed after it.
 */
export { appRoot, fixtureConfigPath, fixturesDirectory } from './oxlint.mts';

RuleTester.describe = describe;
RuleTester.it = it;

export const ruleTester = new RuleTester();

type TesterRule = Parameters<RuleTester['run']>[1];
export type ValidCase = RuleTester.ValidTestCase;
export type InvalidCase = RuleTester.InvalidTestCase;

const lookup = (rules: Readonly<Record<string, TesterRule>>, plugin: string, name: string): TesterRule => {
  const rule = rules[name];
  if (rule === undefined) {
    throw new Error(`${plugin} does not register ${name}`);
  }
  return rule;
};

/** The rule object registered by the production `effect-native` plugin. */
export const effectNativeRule = (name: string): TesterRule => lookup(effectNativePlugin.rules, 'effect-native', name);

const PluginRule = Schema.declare<TesterRule>(
  (value): value is TesterRule =>
    Predicate.isObject(value) &&
    (('create' in value && Predicate.isFunction(value.create)) ||
      ('createOnce' in value && Predicate.isFunction(value.createOnce))),
);
const PluginModule = Schema.Struct({ default: Schema.Struct({ rules: Schema.Record(Schema.String, PluginRule) }) });

/** Rules of a synchronous JavaScript plugin outside this tool's strict typecheck. */
export const loadPluginRules = (specifier: string): Readonly<Record<string, TesterRule>> => {
  const requirePlugin = createRequire(nodePath.join(appRoot, 'package.json'));
  const filename = specifier.startsWith('.') ? fileURLToPath(new URL(specifier, import.meta.url)) : specifier;
  return Schema.decodeUnknownSync(PluginModule)(requirePlugin(filename)).default.rules;
};

const antiSlopEffectRules = loadPluginRules('../../anti-slop/effect/index.ts');

/** The rule object registered by the production `anti-slop-effect` plugin. */
export const antiSlopEffectRule = (name: string): TesterRule => lookup(antiSlopEffectRules, 'anti-slop-effect', name);

/** Register valid and invalid cases for one production rule under `effect-native/<name>`. */
export const testEffectNativeRule = (
  name: string,
  cases: { readonly invalid?: readonly InvalidCase[]; readonly valid?: readonly ValidCase[] },
  title = `effect-native/${name}`,
): void => {
  ruleTester.run(title, effectNativeRule(name), {
    invalid: [...(cases.invalid ?? [])],
    valid: [...(cases.valid ?? [])],
  });
};

/**
 * Roots for virtual filenames. Each mirrors the directory an earlier on-disk test used, because
 * several rules scope by repository markers or by their position relative to the application root:
 * - `workspace`: the ignored application-local workspace root (`.codex/reports/lint-rule-workspaces`);
 * - `temporary`: the operating-system temporary directory, outside the application root.
 */
const workspaceRoot = fileURLToPath(new URL('../../../../.codex/reports/lint-rule-workspaces/', import.meta.url));
export const virtualRoots = {
  temporary: nodePath.join(realpathSync(tmpdir()), 'effect-policy-rule-tester'),
  workspace: nodePath.join(workspaceRoot, 'effect-policy-rule-tester'),
} as const;

/** An absolute filename that is never created; the rule sees only its spelling. */
export const virtualFile = (logicalPath: string, root: keyof typeof virtualRoots = 'workspace'): string =>
  nodePath.join(virtualRoots[root], logicalPath);

let workspaceSequence = 0;
const ownedWorkspaces = new Set<string>();
process.once('exit', () => {
  for (const directory of ownedWorkspaces) {
    rmSync(directory, { force: true, recursive: true });
  }
});

export interface WorkspaceEntry {
  readonly path: string;
  readonly source?: string;
  /** Workspace-relative target; the entry becomes a symlink instead of a file. */
  readonly symlinkTo?: string;
}

export interface Workspace {
  /** Write every entry into a fresh directory. */
  readonly create: () => void;
  readonly directory: string;
  readonly file: (logicalPath: string) => string;
  /** Case hooks that create the workspace before one case and remove it afterwards. */
  readonly hooks: { readonly after: () => void; readonly before: () => void };
  /** Remove the directory and everything below it. */
  readonly remove: () => void;
}

/**
 * A real workspace for rules that read files other than the linted source. It lives below the
 * ignored `.codex/reports/lint-rule-workspaces/` directory, never in the scanned source tree.
 */
export const workspaceCase = (entries: readonly WorkspaceEntry[], root = workspaceRoot): Workspace => {
  workspaceSequence += 1;
  const directory = nodePath.join(root, `effect-policy-${process.pid}-${workspaceSequence}`);
  const file = (logicalPath: string): string => nodePath.join(directory, logicalPath);
  const create = (): void => {
    if (existsSync(directory)) {
      throw new Error(`Rule-tester workspace already exists: ${directory}`);
    }
    ownedWorkspaces.add(directory);
    mkdirSync(directory, { recursive: true });
    for (const entry of entries) {
      const target = file(entry.path);
      mkdirSync(nodePath.dirname(target), { recursive: true });
      if (entry.symlinkTo === undefined) {
        writeFileSync(target, entry.source ?? '');
      } else {
        symlinkSync(file(entry.symlinkTo), target);
      }
    }
  };
  const remove = (): void => {
    rmSync(directory, { force: true, recursive: true });
    ownedWorkspaces.delete(directory);
  };
  return { create, directory, file, hooks: { after: remove, before: create }, remove };
};

/**
 * Registers a describe block whose cases share one real workspace, written before its first case and
 * removed after its last. `cases` receives the workspace to address files and register rule cases.
 */
export const describeWorkspace = (
  title: string,
  entries: readonly WorkspaceEntry[],
  cases: (workspace: Workspace) => void,
): void => {
  const workspace = workspaceCase(entries);
  describe(title, () => {
    beforeAll(workspace.create);
    afterAll(workspace.remove);
    cases(workspace);
  });
};

type RuleOptions = NonNullable<ValidCase['options']>;
const RuleOption: Schema.Codec<RuleOptions[number]> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.mutable(Schema.Array(RuleOption)),
    Schema.Record(Schema.String, RuleOption),
  ]),
);
const RuleSetting = Schema.Union([Schema.String, Schema.Array(RuleOption)]);
const RuleMap = Schema.Record(Schema.String, RuleSetting);
const FixtureConfig = Schema.fromJsonString(
  Schema.Struct({
    categories: Schema.Struct({ correctness: Schema.Literal('off') }),
    jsPlugins: Schema.Tuple([
      Schema.Struct({ name: Schema.Literal('effect-native'), specifier: Schema.Literal('../../fixture-plugin.ts') }),
    ]),
    overrides: Schema.optional(Schema.Array(Schema.Struct({ files: Schema.Array(Schema.String), rules: RuleMap }))),
    rules: RuleMap,
  }).pipe(Schema.check(Schema.makeFilter((config) => Object.keys(config.rules).length === 1))),
);
const decodeFixtureConfig = Schema.decodeUnknownSync(FixtureConfig);

const settingOptions = (setting: typeof RuleSetting.Type, label: string): RuleOptions | undefined => {
  const [severity, ...options] = Schema.is(Schema.String)(setting) ? [setting] : setting;
  if (severity !== 'error') {
    throw new Error(`${label} must enable its rule as an error`);
  }
  return options.length === 0 ? undefined : options;
};

/**
 * Options the rule's fixture configuration selects for one file: the base setting, replaced by the
 * last override whose `files` glob matches the path relative to the fixture directory.
 */
export const fixtureOptions = (rule: string, filename?: string): RuleOptions | undefined => {
  const config = decodeFixtureConfig(readFileSync(fixtureConfigPath(rule), 'utf-8'));
  const key = `effect-native/${rule}`;
  const base = config.rules[key];
  if (base === undefined) {
    throw new Error(`${fixtureConfigPath(rule)} must enable ${key}`);
  }
  let setting = base;
  if (filename !== undefined) {
    const relative = nodePath.relative(nodePath.join(fixturesDirectory, rule), filename).replaceAll('\\', '/');
    for (const override of config.overrides ?? []) {
      const overridden = override.rules[key];
      if (overridden !== undefined && override.files.some((glob) => globToRegExp(glob).test(relative))) {
        setting = overridden;
      }
    }
  }
  return settingOptions(setting, fixtureConfigPath(rule));
};

const ProductionConfigModule = Schema.Struct({
  default: Schema.Struct({
    ignorePatterns: Schema.Array(Schema.String),
    overrides: Schema.Array(
      Schema.Struct({
        excludeFiles: Schema.optional(Schema.Array(Schema.String)),
        files: Schema.Array(Schema.String),
        rules: RuleMap,
      }),
    ),
    rules: RuleMap,
  }),
});
const productionConfig = Schema.decodeUnknownSync(ProductionConfigModule)(
  await import(pathToFileURL(nodePath.join(appRoot, 'oxlint.config.ts')).href),
);

// Production uses the Git wildmatch subset of literals, *, ?, and whole-segment **.
// Reject unsupported syntax rather than silently treating a future pattern as a different glob.
const productionIgnores = productionConfig.default.ignorePatterns.map((pattern) => {
  if (
    !/^\/?(?:[\w.*?-]+\/)*[\w.*?-]+\/?$/u.test(pattern) ||
    pattern.split('/').some((part) => part !== '**' && part.includes('**'))
  ) {
    throw new Error(`Unsupported production ignore pattern: ${pattern}`);
  }
  const path = pattern.replaceAll(/^\/|\/$/gu, '');
  // A slash in the beginning or middle anchors the pattern. Git wildcards also match leading dots.
  const glob = !pattern.startsWith('/') && !path.includes('/') ? `**/${path}` : path;
  return { directoryOnly: pattern.endsWith('/'), matcher: globToRegExp(glob) };
});

/** Whether production ignores a file or one of its parent directories. */
export const isProductionIgnored = (filename: string): boolean =>
  filename.split('/').some((_, index, parts) => {
    const path = parts.slice(0, index + 1).join('/');
    return productionIgnores.some(
      ({ directoryOnly, matcher }) => (!directoryOnly || index < parts.length - 1) && matcher.test(path),
    );
  });

// Oxlint override globs match leading dots, and patterns without a slash match basenames at any depth.
// Compile the production subset; fail if a new pattern needs syntax the shared matcher does not implement.
const compileOverrideGlob = (pattern: string): RegExp => {
  if (
    pattern
      .split('/')
      .some((part) => part !== '**' && (part.includes('**') || !/^(?:[\w.*?-]|\{[\w.-]+(?:,[\w.-]+)+\})+$/u.test(part)))
  ) {
    throw new Error(`Unsupported production override pattern: ${pattern}`);
  }
  return globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`);
};
const productionOverrides = productionConfig.default.overrides.map(({ excludeFiles, files, rules }) => ({
  excludeFiles: (excludeFiles ?? []).map(compileOverrideGlob),
  files: files.map(compileOverrideGlob),
  rules,
}));

/**
 * Options selected by production's ordered overrides for a non-ignored application-relative filename.
 * Omitting the filename selects only the base setting, for assertions about global rules.
 */
export const productionOptions = (key: string, filename?: string): RuleOptions | undefined => {
  if (filename !== undefined && isProductionIgnored(filename)) {
    throw new Error(`File is ignored in production: ${filename}`);
  }
  let setting = productionConfig.default.rules[key];
  if (filename !== undefined) {
    for (const override of productionOverrides) {
      const overridden = override.rules[key];
      if (
        overridden !== undefined &&
        override.files.some((matcher) => matcher.test(filename)) &&
        !override.excludeFiles.some((matcher) => matcher.test(filename))
      ) {
        setting = overridden;
      }
    }
  }
  if (setting === undefined) {
    throw new Error(`Rule is not enabled in production: ${key}`);
  }
  return settingOptions(setting, `app/oxlint.config.ts ${key}`);
};

/** Spread into a case: omits `options` when the configuration supplies none. */
export const withOptions = (options: RuleOptions | undefined): { readonly options?: RuleOptions } =>
  options === undefined ? {} : { options };

type CaseDefaults = Omit<ValidCase, 'code'>;

/**
 * Collects valid and invalid cases that share a filename, options and hooks, then registers them
 * for one rule. Case titles default to their source text, as in RuleTester.
 */
export const collectCases = (rule: TesterRule, title: string, defaults: CaseDefaults) => {
  const valid: ValidCase[] = [];
  const invalid: InvalidCase[] = [];
  return {
    accept: (code: string, overrides: Partial<ValidCase> = {}): void => {
      valid.push({ code, ...defaults, ...overrides });
    },
    register: (): void => {
      ruleTester.run(title, rule, { invalid, valid });
    },
    reject: (errors: InvalidCase['errors'], code: string, overrides: Partial<ValidCase> = {}): void => {
      invalid.push({ code, errors, ...defaults, ...overrides });
    },
  };
};

/**
 * Valid fixtures that are clean only because the Oxlint binary applies inline disable directives
 * before it collects plugin diagnostics. RuleTester runs the rule without that directive handling,
 * so the rule's own report is asserted in-process and the binary's suppression end to end.
 */
export const directiveSuppressedFixtures: ReadonlySet<string> = new Set([
  'no-unjustified-file-wide-lint-suppression/valid/packages/core-runtime/src/blanket-disable-swallowed-by-oxlint.ts',
]);
