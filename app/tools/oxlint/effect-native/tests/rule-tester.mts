import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Schema } from 'effect';
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

/**
 * Rules of a plugin outside this tool's strict typecheck: the vendored anti-slop plugin and
 * ESLint-typed packages. Oxlint loads them as JavaScript plugins, so they are imported by URL.
 */
export const loadPluginRules = async (specifier: string): Promise<Readonly<Record<string, TesterRule>>> => {
  const url = specifier.startsWith('.')
    ? new URL(specifier, import.meta.url).href
    : pathToFileURL(createRequire(nodePath.join(appRoot, 'package.json')).resolve(specifier)).href;
  const plugin: { readonly default: { readonly rules: Readonly<Record<string, TesterRule>> } } = await import(url);
  return plugin.default.rules;
};

const antiSlopEffectRules = await loadPluginRules('../../anti-slop/effect/index.ts');

/** The rule object registered by the production `anti-slop-effect` plugin. */
export const antiSlopEffectRule = (name: string): TesterRule => lookup(antiSlopEffectRules, 'anti-slop-effect', name);

/** Register valid and invalid cases for one production rule under `effect-native/<name>`. */
export const testEffectNativeRule = (
  name: string,
  cases: { readonly valid?: readonly ValidCase[]; readonly invalid?: readonly InvalidCase[] },
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
  readonly directory: string;
  readonly file: (logicalPath: string) => string;
  /** Write every entry into a fresh directory. */
  readonly create: () => void;
  /** Remove the directory and everything below it. */
  readonly remove: () => void;
  /** Case hooks that create the workspace before one case and remove it afterwards. */
  readonly hooks: { readonly after: () => void; readonly before: () => void };
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

const RuleSetting = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);
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

type RuleOptions = NonNullable<ValidCase['options']>;
const isRuleOption = (value: unknown): value is RuleOptions[number] => {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isRuleOption);
  }
  return typeof value === 'object' && Object.values(value).every(isRuleOption);
};
const decodeOptions = (options: readonly unknown[], label: string): RuleOptions => {
  const decoded = options.filter(isRuleOption);
  if (decoded.length !== options.length) {
    throw new Error(`${label} has options that are not JSON values`);
  }
  return decoded;
};

const settingOptions = (setting: typeof RuleSetting.Type, label: string): RuleOptions | undefined => {
  const [severity, ...options] = typeof setting === 'string' ? [setting] : setting;
  if (severity !== 'error') {
    throw new Error(`${label} must enable its rule as an error`);
  }
  return options.length === 0 ? undefined : decodeOptions(options, label);
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

const ProductionConfigModule = Schema.Struct({ default: Schema.Struct({ rules: RuleMap }) });
const productionConfig = Schema.decodeUnknownSync(ProductionConfigModule)(
  await import(pathToFileURL(nodePath.join(appRoot, 'oxlint.config.ts')).href),
);

/** Base options `app/oxlint.config.ts` assigns to a plugin rule. */
export const productionOptions = (key: string): RuleOptions | undefined => {
  const setting = productionConfig.default.rules[key];
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
