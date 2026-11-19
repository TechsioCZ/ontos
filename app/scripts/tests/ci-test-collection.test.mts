import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, ObjectExpression } from 'oxc-parser';
import { parse } from 'yaml';

import { parseCiMatrices } from '../ci/ci-matrices.mts';

const app = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(app, file), 'utf-8');
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
const walk = (directory: string): string[] =>
  readdirSync(path.join(app, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : walk(file);
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
      steps: Schema.optionalKey(Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) }))),
    }),
  ),
});

it('collects every executable test in a CI job or names its manual environment', () => {
  const files = walk('');
  const tests = files.filter(
    (file) => /\.(?:test|spec)\.[^/]+$/u.test(file) && !file.startsWith('tools/oxlint/effect-native/tests/fixtures/'),
  );
  const workflow = Schema.decodeUnknownSync(WorkflowSchema)(
    parse(read('../.github/workflows/ultramodern-workspace-gates.yml')),
  );
  const matrices = Result.getOrThrow(
    parseCiMatrices(read('scripts/ci-matrices.json'), read(workflow.env.CI_MATRICES_OVERLAY)),
  );
  const workspace = Schema.decodeUnknownSync(Schema.Struct({ packages: Schema.Array(Schema.String) }))(
    parse(read('pnpm-workspace.yaml')),
  );
  const packages = new Map(
    files
      .filter(
        (file) =>
          path.posix.basename(file) === 'package.json' &&
          (file === 'package.json' || matches(path.posix.dirname(file), workspace.packages)),
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
  const collectBrowser = () => {
    // Playwright defaults are separate from Rstest. The browser matrix invokes this package's real script.
    if (matrices.integration.some((row) => row.suite === 'browser')) {
      for (const [directory, manifest] of packages) {
        if (manifest.scripts?.['test:e2e']?.includes('playwright') === true) {
          const config = read(path.posix.join(directory, 'playwright.config.ts'));
          const testDir = /testDir:\s*['"](?<directory>[^'"]+)/u.exec(config)?.groups?.directory;
          expect(testDir, `${directory}: browser testDir`).toBeDefined();
          for (const file of tests) {
            if (
              file.startsWith(`${path.posix.join(directory, testDir ?? '')}/`) &&
              /\.(?:test|spec)\.[jt]sx?$/u.test(file)
            ) {
              collected.add(file);
            }
          }
        }
      }
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
  collectBrowser();
  // Shared *.spec.mts assertions and data such as SpiceDB's *.test.yaml are inputs, not extra manual suites.
  // Follow real imports and URL reads in the parsed code, not strings in comments or embedded fixture programs.
  for (const file of collected) {
    if (!/\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    const source = parseSync(file, read(file));
    expect(source.errors, file).toEqual([]);
    const dependencies = source.module.staticImports
      .filter((statement) => statement.entries.length === 0 || !statement.entries.every((entry) => entry.isType))
      .map((statement) => statement.moduleRequest.value);
    new Visitor({
      NewExpression(node) {
        const [target] = node.arguments;
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'URL' &&
          target?.type === 'Literal' &&
          Schema.is(Schema.String)(target.value)
        ) {
          dependencies.push(target.value);
        }
      },
    }).visit(source.program);
    for (const dependency of dependencies.filter((target) => target.startsWith('.'))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), dependency));
      if (tests.includes(target)) {
        collected.add(target);
      }
    }
  }
  for (const [file, reason] of manual) {
    expect(reason.length).toBeGreaterThan(0);
    expect(collected.has(file), `manual suite unexpectedly runs in CI: ${file}`).toBe(false);
  }
  expect(
    tests.filter((file) => !collected.has(file) && !manual.has(file)),
    'Uncollected executable tests: add a real CI invocation and matching runner include, not a blanket exception.',
  ).toEqual([]);
});
