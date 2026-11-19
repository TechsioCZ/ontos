import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, ObjectExpression } from 'oxc-parser';
import { parse } from 'yaml';

import { parseCiMatrices } from '../ci/ci-matrices.mts';

const app = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(app, file), 'utf-8');
const packageManifest = 'package.json';
const matrixFile = 'scripts/ci-matrices.json';
const defaultInclude = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const defaultExclude = ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**'];
const manual = new Map([
  [
    'apps/shell-super-app/tests/integration/person-invitation-runtime.test.ts',
    'Operator acceptance requires a people_model_scratch database, Mailpit, and local SpiceDB.',
  ],
  [
    'scripts/integration/siampark-demo-http.test.mts',
    'Operator acceptance against the reset Nájempark stack on port 3020.',
  ],
  [
    'verticals/payment/tests/sandbox/comgate-sandbox.test.ts',
    'Comgate sandbox credentials and external payment service.',
  ],
  ['verticals/payment/tests/sandbox/gopay-sandbox.test.ts', 'GoPay sandbox credentials and external payment service.'],
  [
    'verticals/payment/tests/sandbox/stripe-sandbox.test.ts',
    'Stripe sandbox credentials and external payment service.',
  ],
]);

// Fixture source is input to the collected lint-rule tests, not an executable suite. Generated output is not source.
const ignoredDirectories = new Set([
  'node_modules',
  '.git',
  '.next',
  '.modern-js',
  '.cache',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);
const walk = (directory: string, root = app): string[] =>
  readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : walk(file, root);
    }
    return entry.isFile() ? [file] : [];
  });
const matches = (file: string, patterns: readonly string[]) =>
  patterns.filter((pattern) => !pattern.startsWith('!')).some((pattern) => path.matchesGlob(file, pattern)) &&
  !patterns.filter((pattern) => pattern.startsWith('!')).some((pattern) => path.matchesGlob(file, pattern.slice(1)));
const propertyName = (node: ObjectExpression['properties'][number]) => {
  if (node.type !== 'Property') {
    return null;
  }
  if (node.key.type === 'Identifier') {
    return node.key.name;
  }
  return node.key.type === 'Literal' ? node.key.value : null;
};
const initializer = (node: ObjectExpression, name: string) => {
  const found = node.properties.find((entry) => propertyName(entry) === name);
  return found?.type === 'Property' ? found.value : undefined;
};

// Read syntax, never import a config: Shell's config starts build plugins. Fail closed on unknown include syntax.
const configProjects = (file: string) => {
  const text = read(file);
  const source = parseSync(file, text);
  expect(source.errors, file).toEqual([]);
  const variables = new Map<string, Expression>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type === 'Identifier' && node.init !== null) {
        variables.set(node.id.name, node.init);
      }
    },
  }).visit(source.program);
  const evaluate = (node: Expression | undefined): string[] => {
    if (node === undefined) {
      return [];
    }
    if (node.type === 'Literal' && Schema.is(Schema.String)(node.value)) {
      return [node.value];
    }
    if (node.type === 'Identifier') {
      const value = variables.get(node.name);
      expect(value, `${file}: unresolved ${node.name}`).toBeDefined();
      return evaluate(value);
    }
    if (node.type === 'ArrayExpression') {
      return node.elements.flatMap((element) =>
        element === null ? [] : evaluate(element.type === 'SpreadElement' ? element.argument : element),
      );
    }
    if (node.type === 'TemplateLiteral' && node.quasis[0]?.value.raw === '!' && node.expressions.length === 1) {
      return evaluate(node.expressions[0]).map((pattern) => `!${pattern}`);
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'map'
    ) {
      const [callback] = node.arguments;
      expect(
        callback === undefined ? '' : text.slice(callback.start, callback.end),
        `${file}: unsupported include mapping`,
      ).toMatch(/[=]>\s*`!\$\{/u);
      return evaluate(node.callee.object).map((pattern) => `!${pattern}`);
    }
    return expect.fail(`${file}: unsupported discovery expression ${text.slice(node.start, node.end)}`);
  };
  const objects: ObjectExpression[] = [];
  new Visitor({
    ObjectExpression(node) {
      objects.push(node);
    },
  }).visit(source.program);
  const projectArray = objects
    .map((node) => initializer(node, 'projects'))
    .find((node) => node?.type === 'ArrayExpression');
  const projects =
    projectArray?.type === 'ArrayExpression'
      ? projectArray.elements.filter((node): node is ObjectExpression => node?.type === 'ObjectExpression')
      : objects.filter((node) => initializer(node, 'include') !== undefined && initializer(node, 'name') !== undefined);
  if (projects.length === 0) {
    const exported = source.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
    const call = exported?.type === 'ExportDefaultDeclaration' ? exported.declaration : undefined;
    if (call?.type === 'CallExpression') {
      projects.push(...call.arguments.filter((node): node is ObjectExpression => node.type === 'ObjectExpression'));
    }
  }
  expect(projects.length, `${file}: no discovery config found`).toBeGreaterThan(0);
  const discovery = projects.map((project) => initializer(project, 'test') ?? project);
  return discovery.map((project) => {
    expect(project.type, file).toBe('ObjectExpression');
    if (project.type !== 'ObjectExpression') {
      return expect.fail(`${file}: discovery is not an object`);
    }
    return {
      exclude: [...defaultExclude, ...evaluate(initializer(project, 'exclude'))],
      include:
        initializer(project, 'include') === undefined ? defaultInclude : evaluate(initializer(project, 'include')),
      name: evaluate(initializer(project, 'name'))[0] ?? 'default',
    };
  });
};

// Follow the executor's actual task branches, including shell array handoffs and CLI excludes. A package's project
// alone is not enough: migration files deliberately leave its shards and must have their whole task in the matrix.
const integrationCommand = (executor: string, task: string) => {
  const arrays = new Map(
    [...executor.matchAll(/^(?<name>\w+)=\((?<items>[\s\S]*?)^\)/gmu)].map((match) => [
      match.groups?.name ?? '',
      (match.groups?.items ?? '').trim().split(/\s+/u),
    ]),
  );
  const expand = (command: string, excluded: readonly string[]) =>
    command
      .replaceAll(/"\$\{(?<name>\w+)\[@\]\}"/gu, (_match, name: string) =>
        name === 'excluded'
          ? excluded.map((file) => `--exclude ${file}`).join(' ')
          : (arrays.get(name) ?? []).join(' '),
      )
      .replaceAll(`"\${task%#*}"`, task.split('#')[0] ?? '')
      .replaceAll('"$task"', task);
  const text = executor.replaceAll('\\\n', ' ');
  if (task.startsWith('whole:')) {
    const start = text.indexOf(`    ${task})`);
    expect(start, `missing executor for ${task}`).toBeGreaterThan(-1);
    return expand(text.slice(start, text.indexOf(';;', start)), []);
  }
  const start = text.indexOf('  esac');
  const lines = text.slice(start, text.indexOf('\nfi', start)).split('\n');
  const active: boolean[] = [];
  let excluded: readonly string[] = [];
  for (const line of lines) {
    const condition = /if \[\[ "(?<subject>\$task|\$\{task%#\*\})" == (?<pattern>\S+) \]\]; then/u.exec(line)?.groups;
    if (condition !== undefined) {
      const subject = condition.subject === '$task' ? task : (task.split('#')[0] ?? '');
      const pattern = (condition.pattern ?? '')
        .split('*')
        .map((part) => RegExp.escape(part))
        .join('.*');
      active.push(new RegExp(`^${pattern}$`, 'u').test(subject));
    } else if (line.trim() === 'fi') {
      active.pop();
    } else if (active.every(Boolean)) {
      const array = /excluding "\$\{(?<name>\w+)\[@\]\}"/u.exec(line)?.groups?.name;
      if (array !== undefined) {
        excluded = arrays.get(array) ?? [];
      }
      if (line.trim().startsWith('exec ')) {
        return expand(line, excluded);
      }
    }
  }
  return expect.fail(`No executable CI branch for ${task}`);
};

const PackageSchema = Schema.Struct({
  name: Schema.String,
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const WorkflowSchema = Schema.Struct({
  env: Schema.Struct({ CI_MATRICES_OVERLAY: Schema.String }),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            if: Schema.optionalKey(Schema.String),
            run: Schema.optionalKey(Schema.String),
            'working-directory': Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});

// Mirror the pinned Playwright FullProjectInternal precedence and createFileMatcher rules, without importing
// the config (which reads operator environment). Unsupported discovery expressions fail closed.
type PlaywrightPattern = string | RegExp;
const playwrightProjects = (file: string, text: string) => {
  const source = parseSync(file, text);
  expect(source.errors, file).toEqual([]);
  const exported = source.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  const declaration = exported?.type === 'ExportDefaultDeclaration' ? exported.declaration : undefined;
  const config = declaration?.type === 'CallExpression' ? declaration.arguments[0] : declaration;
  if (config?.type !== 'ObjectExpression') {
    return expect.fail(`${file}: expected a literal Playwright config`);
  }
  expect(
    config.properties.some((entry) => entry.type === 'SpreadElement'),
    file,
  ).toBe(false);
  const patterns = (node: Expression | undefined): PlaywrightPattern[] => {
    if (node === undefined) {
      return [];
    }
    if (node.type === 'Literal' && Schema.is(Schema.String)(node.value)) {
      return [node.value];
    }
    if (node.type === 'Literal' && 'regex' in node && node.regex !== undefined) {
      return [new RegExp(node.regex.pattern, node.regex.flags)];
    }
    if (node.type === 'ArrayExpression') {
      return node.elements.flatMap((entry) => {
        if (entry === null || entry.type === 'SpreadElement') {
          return expect.fail(`${file}: unsupported pattern spread`);
        }
        return patterns(entry);
      });
    }
    return expect.fail(`${file}: unsupported Playwright discovery expression ${text.slice(node.start, node.end)}`);
  };
  const value = (project: ObjectExpression, key: string) => {
    expect(
      project.properties.some((entry) => entry.type === 'SpreadElement'),
      file,
    ).toBe(false);
    return initializer(project, key) ?? initializer(config, key);
  };
  const string = (node: Expression | undefined, otherwise: string) => {
    if (node === undefined) {
      return otherwise;
    }
    if (node.type === 'Literal' && Schema.is(Schema.String)(node.value)) {
      return node.value;
    }
    return expect.fail(`${file}: expected a literal discovery string`);
  };
  const projectArray = initializer(config, 'projects');
  const projects: ObjectExpression[] = [];
  if (projectArray === undefined) {
    projects.push(config);
  } else if (projectArray.type === 'ArrayExpression') {
    for (const entry of projectArray.elements) {
      if (entry?.type !== 'ObjectExpression') {
        return expect.fail(`${file}: unsupported Playwright project`);
      }
      projects.push(entry);
    }
  } else {
    return expect.fail(`${file}: unsupported Playwright projects`);
  }
  return projects.map((project) => ({
    name: string(value(project, 'name'), ''),
    testDir: string(value(project, 'testDir'), '.'),
    testIgnore: patterns(value(project, 'testIgnore')),
    testMatch:
      value(project, 'testMatch') === undefined
        ? ['**/*.@(spec|test).?(c|m)[jt]s?(x)']
        : patterns(value(project, 'testMatch')),
  }));
};
// Use the invoked package's pinned matcher: Node's matchesGlob differs on dotfiles and minimatch options.
interface PlaywrightUtilities {
  createFileMatcher: (patterns: readonly PlaywrightPattern[]) => (file: string) => boolean;
}
const PlaywrightUtilitiesSchema = Schema.Struct({
  createFileMatcher: Schema.declare((value): value is PlaywrightUtilities['createFileMatcher'] =>
    Predicate.isFunction(value),
  ),
});
const playwrightMatcher = (directory: string, patterns: readonly PlaywrightPattern[]) => {
  const require = createRequire(path.join(app, directory, packageManifest));
  const utilities = Schema.decodeUnknownSync(PlaywrightUtilitiesSchema)(require('playwright/lib/util'));
  const matcher = utilities.createFileMatcher(patterns);
  // The pinned library owns the callable signature; check its observable result at this boundary too.
  return (file: string) => Schema.decodeUnknownSync(Schema.Boolean)(matcher(file));
};
const playwrightArguments = (args: string) => {
  // Quoted grep values are one option value, never accidental file filters.
  const tokens = [...args.matchAll(/'(?<single>[^']*)'|"(?<double>[^"]*)"|(?<bare>\S+)/gu)].map(
    ({ groups }) => groups?.single ?? groups?.double ?? groups?.bare ?? '',
  );
  const names: string[] = [];
  const filters: RegExp[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--project') {
      index += 1;
      names.push(tokens[index] ?? '');
    } else if (['--grep', '--grep-invert', '--workers', '--retries', '--repeat-each', '--shard'].includes(token)) {
      index += 1;
    } else if (token.startsWith('-')) {
      return expect.fail(`Unsupported Playwright collection option: ${token}`);
    } else {
      filters.push(new RegExp(token, 'u'));
    }
  }
  return { filters, names };
};
interface BrowserInputs {
  appRoot: string;
  browserEnabled: boolean;
  packages: ReadonlyMap<string, typeof PackageSchema.Type>;
  read: (file: string) => string;
  tests: readonly string[];
  workflow: typeof WorkflowSchema.Type;
}
const browserInvocation = (command: string, directory: string, packages: BrowserInputs['packages']) => {
  const invocation = /\bpnpm\s+--filter\s+(?<selector>[^\s]+)\s+(?<command>.+)/u.exec(command)?.groups;
  if (invocation === undefined) {
    return null;
  }
  const target = [...packages].find(
    ([root, manifest]) =>
      manifest.name === invocation.selector ||
      path.posix.normalize(path.posix.join(directory, invocation.selector ?? '')) === root,
  );
  if (target === undefined) {
    return expect.fail(`Unknown browser package: ${invocation.selector ?? ''}`);
  }
  const [root, manifest] = target;
  const script = /^(?:run\s+)?(?<name>test(?::[\w-]+)*)(?<extra>.*)$/u.exec(invocation.command ?? '')?.groups;
  const executable =
    script === undefined
      ? (invocation.command ?? '')
      : `${manifest.scripts?.[script.name ?? ''] ?? ''}${script.extra ?? ''}`;
  const args = /^(?:exec\s+)?playwright\s+test(?<args>.*)$/u.exec(executable)?.groups?.args;
  return args === undefined ? null : { root, ...playwrightArguments(args) };
};
const collectPlaywright = (invocation: NonNullable<ReturnType<typeof browserInvocation>>, inputs: BrowserInputs) => {
  const { filters, names, root } = invocation;
  const configFile = path.posix.join(root, 'playwright.config.ts');
  const projects = playwrightProjects(configFile, inputs.read(configFile));
  for (const name of names) {
    expect(
      projects.some((project) => project.name === name),
      configFile,
    ).toBe(true);
  }
  return projects
    .filter((project) => names.length === 0 || names.includes(project.name))
    .flatMap((project) => {
      const testDir = path.resolve(inputs.appRoot, root, project.testDir);
      const includes = playwrightMatcher(root, project.testMatch);
      const ignores = playwrightMatcher(root, project.testIgnore);
      return inputs.tests.filter((file) => {
        const absolute = path.resolve(inputs.appRoot, file);
        return (
          absolute.startsWith(`${testDir}/`) &&
          includes(absolute) &&
          !ignores(absolute) &&
          (filters.length === 0 || filters.some((filter) => filter.test(absolute)))
        );
      });
    });
};
const browserCollection = (inputs: BrowserInputs) => {
  const collected = new Set<string>();
  if (!inputs.browserEnabled) {
    return collected;
  }
  // Only this job receives integrationBrowser. Other jobs share its YAML-aliased steps but not its matrix.
  for (const step of inputs.workflow.jobs['browser-integration']?.steps ?? []) {
    if (step.if !== undefined && step.if !== "matrix.suite == 'browser'") {
      continue;
    }
    const directory = path.posix.relative('app', step['working-directory'] ?? '.');
    for (const command of (step.run ?? '').split(/\n|&&|;/u)) {
      const invocation = browserInvocation(command, directory, inputs.packages);
      if (invocation !== null) {
        for (const file of collectPlaywright(invocation, inputs)) {
          collected.add(file);
        }
      }
    }
  }
  return collected;
};

const declaresTests = (text: string, file: string) => {
  const source = parseSync(file, text);
  expect(source.errors, file).toEqual([]);
  // Assertion-only helpers do not register tests. Executable test modules may not be laundered through an import.
  return source.module.staticImports.some((statement) =>
    statement.entries.some(
      (entry) =>
        !entry.isType &&
        (entry.importName.name === null || ['it', 'test', 'describe'].includes(entry.importName.name ?? '')),
    ),
  );
};

const missingExecutableTests = (
  tests: readonly string[],
  collected: ReadonlySet<string>,
  readInput: (file: string) => string,
) => {
  // Supporting assertion modules are imports, not suites. A URL literal never grants an executable file credit.
  const supporting = new Set<string>();
  for (const file of collected) {
    const source = parseSync(file, readInput(file));
    for (const dependency of source.module.staticImports) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), dependency.moduleRequest.value));
      if (
        dependency.moduleRequest.value.startsWith('.') &&
        tests.includes(target) &&
        !declaresTests(readInput(target), target)
      ) {
        supporting.add(target);
      }
    }
  }
  return tests.filter((file) => !collected.has(file) && !supporting.has(file));
};

it('collects every executable test in a CI job or names its manual environment', () => {
  const files = walk('');
  const tests = files.filter(
    (file) =>
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) && !file.startsWith('tools/oxlint/effect-native/tests/fixtures/'),
  );
  const workflow = Schema.decodeUnknownSync(WorkflowSchema)(
    parse(read('../.github/workflows/ultramodern-workspace-gates.yml')),
  );
  const matrices = Result.getOrThrow(parseCiMatrices(read(matrixFile), read(workflow.env.CI_MATRICES_OVERLAY)));
  const workspace = Schema.decodeUnknownSync(Schema.Struct({ packages: Schema.Array(Schema.String) }))(
    parse(read('pnpm-workspace.yaml')),
  );
  const packages = new Map(
    files
      .filter(
        (file) =>
          path.posix.basename(file) === packageManifest &&
          (file === packageManifest || matches(path.posix.dirname(file), workspace.packages)),
      )
      .map((file) => [
        path.posix.dirname(file),
        Schema.decodeUnknownSync(Schema.fromJsonString(PackageSchema))(read(file)),
      ]),
  );
  const projects = new Map(
    [...packages.keys()].map((directory) => {
      const config = path.posix.join(directory, 'rstest.config.ts');
      const vitest = path.posix.join(directory, 'vitest.config.ts');
      if (existsSync(path.join(app, config))) {
        return [directory, configProjects(config)];
      }
      if (existsSync(path.join(app, vitest))) {
        return [directory, configProjects(vitest)];
      }
      return [directory, [{ exclude: defaultExclude, include: defaultInclude, name: 'unit' }]];
    }),
  );
  const collected = new Set<string>();
  const weightedShards = new Map<string, string[]>();
  const collect = (
    directory: string,
    names: readonly string[],
    filters: readonly string[] = [],
    excludes: readonly string[] = [],
  ) => {
    for (const project of projects.get(directory) ?? []) {
      if (names.length > 0 && !names.includes(project.name)) {
        continue;
      }
      for (const file of tests) {
        const relative = path.posix.relative(directory, file);
        if (
          relative.startsWith('../') ||
          !matches(relative, project.include) ||
          [...project.exclude, ...excludes].some((pattern) => path.matchesGlob(relative, pattern)) ||
          (filters.length > 0 && !filters.some((filter) => relative.includes(filter)))
        ) {
          continue;
        }
        collected.add(file);
      }
    }
  };
  const commands = {
    runCommand(directory: string, command: string, seen: readonly string[] = []) {
      for (const part of command.split(/\n|&&|;/u)) {
        commands.runPart(directory, part, seen);
      }
    },
    runPart(directory: string, part: string, seen: readonly string[]) {
      const runner = /\b(?:rstest(?:\.js)?|vitest)\s+(?<args>.*)/u.exec(part)?.groups?.args;
      if (runner !== undefined) {
        commands.runRunner(directory, runner);
      }
      if (part.includes('rstest-weighted-shard.sh')) {
        commands.runWeighted(directory, part);
        return;
      }
      const invocation = /\b(?:run\s+)?(?<name>test(?::[\w-]+)*)\b/u.exec(part);
      const script = invocation?.groups?.name;
      const extra = invocation === null ? '' : part.slice(invocation.index + invocation[0].length);
      if (runner !== undefined || script === undefined) {
        return;
      }
      const selected = (selector: string, target: string) =>
        selector.replace(/^\.\//u, '') === target || selector === packages.get(target)?.name;
      const selectors = [...part.matchAll(/--filter\s+['"]?(?<selector>!?[^\s'"]+)/gu)].map(
        (match) => match.groups?.selector ?? '',
      );
      const included = selectors.filter((selector) => !selector.startsWith('!'));
      const excluded = selectors.filter((selector) => selector.startsWith('!')).map((selector) => selector.slice(1));
      const targets =
        selectors.length === 0
          ? [directory]
          : [...packages.keys()].filter(
              (target) =>
                target !== '.' &&
                (included.length === 0 || included.some((selector) => selected(selector, target))) &&
                !excluded.some((selector) => selected(selector, target)),
            );
      for (const target of targets) {
        commands.runScript(target, script, extra, seen);
      }
    },
    runRunner(directory: string, runner: string) {
      const names = [...runner.matchAll(/--project\s+(?<name>[\w-]+)/gu)].map((match) => match.groups?.name ?? '');
      const filters = [
        ...runner.replaceAll(/--exclude\s+\S+/gu, '').matchAll(/(?:^|\s)(?<path>(?:tests|scripts|tools)\/[\w./*-]+)/gu),
      ].map((match) => match.groups?.path ?? '');
      const excludes = [...runner.matchAll(/--exclude\s+(?<path>\S+)/gu)].map((match) => match.groups?.path ?? '');
      collect(directory, names, filters, excludes);
    },
    runScript(directory: string, name: string, extra = '', seen: readonly string[] = []) {
      const script = packages.get(directory)?.scripts?.[name];
      if (script === undefined) {
        return;
      }
      expect(seen, `recursive script ${directory}:${name}`).not.toContain(name);
      commands.runCommand(directory, `${script} ${extra}`, [...seen, name]);
    },
    runWeighted(directory: string, part: string) {
      const shard = /\s(?<index>\d+)\/(?<count>\d+)\s+(?<project>[\w-]+)/u.exec(part)?.groups;
      expect(shard, part).toBeDefined();
      const selected = /--filter\s+(?<directory>\.\/\S+)/u.exec(part)?.groups?.directory;
      const target = selected?.slice(2) ?? directory;
      const family = `${target}:${shard?.project ?? ''}`;
      weightedShards.set(family, [
        ...(weightedShards.get(family) ?? []),
        `${shard?.index ?? ''}/${shard?.count ?? ''}`,
      ]);
      collect(target, [shard?.project ?? 'missing']);
    },
  };
  const collectIntegration = () => {
    const executor = read('scripts/ci/run-integration-suites.sh');
    const tasks = matrices.integration.flatMap((row) => row.tasks ?? []);
    const families = new Map<string, number[]>();
    for (const task of tasks) {
      const shard = /^(?<family>.+?)[#:]\d+\/(?<count>\d+)$/u.exec(task)?.groups;
      if (shard !== undefined) {
        families.set(shard.family ?? '', [...(families.get(shard.family ?? '') ?? []), Number(shard.count)]);
      }
      commands.runCommand('.', integrationCommand(executor, task));
    }
    for (const [family, counts] of families) {
      const shards = tasks.filter((task) => task.startsWith(`${family}#`) || task.startsWith(`${family}:`));
      expect(new Set(counts).size, family).toBe(1);
      expect(
        shards.map((task) => Number(/[#:](?<index>\d+)\//u.exec(task)?.groups?.index)).toSorted((a, b) => a - b),
        family,
      ).toEqual(Array.from({ length: counts[0] ?? 0 }, (_, index) => index + 1));
    }
  };
  for (const row of [...matrices.source, ...matrices.unit]) {
    commands.runCommand('.', row.commands);
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      commands.runCommand('.', step.run ?? '');
    }
  }
  for (const [family, shards] of weightedShards) {
    const counts = shards.map((shard) => Number(shard.split('/')[1]));
    expect(new Set(counts).size, family).toBe(1);
    expect(shards.toSorted(), family).toEqual(
      Array.from({ length: counts[0] ?? 0 }, (_, index) => `${index + 1}/${counts[0] ?? 0}`).toSorted(),
    );
  }
  collectIntegration();
  for (const file of browserCollection({
    appRoot: app,
    browserEnabled: matrices.integration.some((row) => row.suite === 'browser'),
    packages,
    read,
    tests,
    workflow,
  })) {
    collected.add(file);
  }
  for (const [file, reason] of manual) {
    expect(reason.length).toBeGreaterThan(0);
    expect(collected.has(file), `manual suite unexpectedly runs in CI: ${file}`).toBe(false);
  }
  expect(
    missingExecutableTests(tests, collected, read).filter((file) => !manual.has(file)),
    'Uncollected executable tests: add a real CI invocation and matching runner include, not a blanket exception.',
  ).toEqual([]);
});

it.each([
  'invocation removed',
  'uninvoked package',
  'testIgnore',
  'testMatch',
  'project selection',
  'URL-only reference',
])('rejects a scratch CI input with %s, then accepts the restored inputs', (mutation) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ontos-browser-collection-'));
  const root = path.join(scratch, 'app');
  const workflowFile = '../.github/workflows/ultramodern-workspace-gates.yml';
  const shell = 'apps/shell-super-app';
  const configFile = `${shell}/playwright.config.ts`;
  const files = walk(shell).filter(
    (file) => /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file) && file.includes('/tests/e2e/'),
  );
  const manifests = [`${shell}/package.json`];
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const readInput = (file: string) => readFileSync(path.join(root, file), 'utf-8');
  const originals = new Map(
    [workflowFile, configFile, ...manifests, matrixFile, 'scripts/ci-matrices.demo.json', ...files].map((file) => [
      file,
      read(file),
    ]),
  );
  const check = () => {
    const inventory = walk('', root);
    const tests = inventory.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
    const workflow = Schema.decodeUnknownSync(WorkflowSchema)(parse(readInput(workflowFile)));
    const matrices = Result.getOrThrow(
      parseCiMatrices(readInput(matrixFile), readInput(workflow.env.CI_MATRICES_OVERLAY)),
    );
    const collected = browserCollection({
      appRoot: root,
      browserEnabled: matrices.integration.some((row) => row.suite === 'browser'),
      packages: new Map(
        inventory
          .filter((file) => path.posix.basename(file) === packageManifest)
          .map((file) => [
            path.posix.dirname(file),
            Schema.decodeUnknownSync(Schema.fromJsonString(PackageSchema))(readInput(file)),
          ]),
      ),
      read: readInput,
      tests,
      workflow,
    });
    expect(missingExecutableTests(tests, collected, readInput), 'Uncollected executable browser tests').toEqual([]);
  };
  try {
    for (const [file, text] of originals) {
      write(file, text);
    }
    check();
    if (mutation === 'invocation removed') {
      // Leave the browser matrix row and targeted login repeat intact.
      const original = readInput(workflowFile);
      const changed = original.replace(
        'mise exec -- pnpm --filter @app/shell-super-app test:e2e',
        'echo browser invocation removed',
      );
      expect(changed).not.toBe(original);
      write(workflowFile, changed);
    } else if (mutation === 'uninvoked package') {
      const directory = 'apps/uninvoked-browser';
      manifests.push(`${directory}/package.json`);
      files.push(`${directory}/tests/e2e/uninvoked.spec.ts`);
      write(
        manifests.at(-1) ?? '',
        JSON.stringify({ name: '@app/uninvoked-browser', scripts: { 'test:e2e': 'playwright test' } }),
      );
      write(`${directory}/playwright.config.ts`, "export default defineConfig({ testDir: './tests/e2e' });");
      write(files.at(-1) ?? '', "import { test } from '@playwright/test'; test('not invoked', () => {});");
    } else if (mutation === 'testIgnore') {
      const ignored = files.find((file) => !file.endsWith('/login.spec.ts'));
      expect(ignored).toBeDefined();
      write(
        configFile,
        readInput(configFile).replace(
          "name: 'chromium',",
          `name: 'chromium', testIgnore: ['**/${path.posix.basename(ignored ?? '')}'],`,
        ),
      );
    } else if (mutation === 'testMatch') {
      write(
        configFile,
        readInput(configFile).replace("name: 'chromium',", "name: 'chromium', testMatch: '**/login.spec.ts',"),
      );
    } else if (mutation === 'project selection') {
      write(workflowFile, readInput(workflowFile).replace('test:e2e', 'test:e2e --project chromium'));
      write(
        configFile,
        readInput(configFile).replace('projects: [', "projects: [{ name: 'firefox', testDir: './tests/unselected' },"),
      );
      write(
        `${shell}/tests/unselected/unselected.spec.ts`,
        "import { test } from '@playwright/test'; test('unselected project', () => {});",
      );
    } else {
      const unexecuted = `${shell}/tests/not-in-testDir.spec.ts`;
      files.push(unexecuted);
      const referrer = files[0] ?? '';
      write(referrer, `${readInput(referrer)}\nnew URL('../not-in-testDir.spec.ts', import.meta.url);\n`);
      write(unexecuted, "import { test } from '@playwright/test'; test('URL is not execution', () => {});");
    }
    expect(() => check()).toThrow('Uncollected executable browser tests');
    for (const [file, text] of originals) {
      write(file, text);
    }
    // Restore the on-disk inventory too; don't hide scratch-only files from discovery.
    for (const file of walk('', root)) {
      if (!originals.has(file)) {
        rmSync(path.join(root, file));
      }
    }
    check();
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});
