import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { Match, Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, ObjectExpression } from 'oxc-parser';
import { parse, stringify } from 'yaml';

import { parseCiMatrices } from '../ci/ci-matrices.mts';

const app = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(app, file), 'utf-8');
const packageManifest = 'package.json';
const matrixFile = 'scripts/ci-matrices.json';
const workflowFile = '../.github/workflows/ultramodern-workspace-gates.yml';
const checkoutProofFile = 'scripts/tests/stage-n1-checkout.test.mts';
const topologyJob = 'node-topology-proof';
const uncollectedCensus = 'Uncollected census files';
const uncollectedBrowser = 'Uncollected executable browser tests';
const browserUnknownStep = 'browser unknown step key';
const browserUnknownDefaults = 'browser unknown defaults key';
const invalidPackageSelector = 'package selector without dot slash';
const unsupportedDispatchShell = 'Unsupported test dispatch shell: bash -n {0}';
const unsupportedDispatchStep = 'Unsupported test dispatch step:';
const rootAndListMutation = 'root AND-list script';
const scratchUnitCommand = 'rstest run --project unit';
const syntaxOnlyBrowserShell = 'syntax-only browser shell';
const organizationTask = 'whole:organization';
const wrongWorkingDirectory = 'app/scripts';
const rstestConfig = 'rstest.config.ts';
const sourceJob = 'workspace-gate';
const lintJob = 'format-and-lint';
const literalDirectoryMutation = 'changed literal working directory';
const browserShardMutation = 'incomplete shard family';
const browserTitleMutation = 'title filter';
const browserInvertedTitleMutation = 'inverted title filter';
const browserProjectGrepMutation = 'project config grep';
const browserConfigGrepInvertMutation = 'inherited config grepInvert';
const projectArrayAnchor = 'projects: [';
const chromiumAnchor = "name: 'chromium',";
const unmodelledProjectOption = 'unmodelled project option';
const browserConfigFilters = new Map([
  [
    browserProjectGrepMutation,
    { anchor: chromiumAnchor, option: 'grep: /reloads failed Contacts into a genuinely published R2/,' },
  ],
  ['project config grepInvert', { anchor: chromiumAnchor, option: 'grepInvert: /login/,' }],
  ['inherited config grep', { anchor: projectArrayAnchor, option: 'grep: /login/,' }],
  [browserConfigGrepInvertMutation, { anchor: projectArrayAnchor, option: 'grepInvert: /login/,' }],
]);
const unsupportedBrowserConfig = new Map([
  ['config shard', 'shard: { current: 1, total: 2 },'],
  ['config test list', "testList: 'selected-tests.txt',"],
  ['config inverted test list', "testListInverted: 'excluded-tests.txt',"],
  ['config git ignore', 'respectGitIgnore: true,'],
  ['config zero repeats', 'repeatEach: 0,'],
  ['config max failures', 'maxFailures: 1,'],
  ['config unknown selector', 'futureCollectionSelector: true,'],
]);
const browserConfigMutation = (mutation: string, original: string) => {
  const filter = browserConfigFilters.get(mutation);
  if (filter !== undefined) {
    const { anchor, option } = filter;
    return original.replace(anchor, anchor === projectArrayAnchor ? `${option} ${anchor}` : `${anchor} ${option}`);
  }
  const unsupported = unsupportedBrowserConfig.get(mutation);
  if (unsupported !== undefined) {
    return original.replace(projectArrayAnchor, `${unsupported} ${projectArrayAnchor}`);
  }
  return mutation === unmodelledProjectOption
    ? original.replace(chromiumAnchor, `${chromiumAnchor} dependencies: ['setup'],`)
    : null;
};
const browserDispatchMutation = (mutation: string, workflow: string, shell: string) => {
  const anchor = 'run: mise exec -- pnpm --filter @app/shell-super-app test:e2e';
  const transforms = new Map([
    [invalidPackageSelector, () => workflow.replaceAll('@app/shell-super-app', shell)],
    [syntaxOnlyBrowserShell, () => workflow.replace(anchor, `shell: bash -n {0}\n        ${anchor}`)],
    [browserUnknownStep, () => workflow.replace(anchor, `futureDispatchOption: do not execute\n        ${anchor}`)],
    [
      browserUnknownDefaults,
      () => workflow.replace('shell: bash', 'shell: bash\n    futureDispatchOption: do not execute'),
    ],
    ['syntax-only inherited browser shell', () => workflow.replace('shell: bash', 'shell: bash -n {0}')],
  ]);
  return transforms.get(mutation)?.();
};
const browserMutationFailure = (mutation: string) => {
  if (mutation === invalidPackageSelector) {
    return 'Unsupported pnpm filter: apps/shell-super-app';
  }
  if (mutation.includes('syntax-only')) {
    return unsupportedDispatchShell;
  }
  if (mutation === browserUnknownDefaults) {
    return 'Unsupported test dispatch defaults:';
  }
  if (mutation === browserUnknownStep) {
    return unsupportedDispatchStep;
  }
  if (mutation === browserShardMutation) {
    return 'Unsupported Playwright collection option: --shard';
  }
  if (unsupportedBrowserConfig.has(mutation) || mutation === unmodelledProjectOption) {
    return 'unsupported Playwright collection option:';
  }
  return uncollectedBrowser;
};
const unsupportedShellCommands = new Map([
  ['exit before runner', 'exit 0; pnpm run test:unit'],
  ['short-circuited runner', 'false && pnpm run test:unit'],
  ['subshell runner', '(pnpm run test:unit)'],
  ['directory change before runner', 'cd scripts; pnpm run test:unit'],
  ['exit on a preceding line', 'exit 0\npnpm run test:unit'],
  ['return before runner', 'return 0\npnpm run test:unit'],
  ['exec before runner', 'exec echo done\npnpm run test:unit'],
  ['exec runner', 'exec pnpm run test:unit'],
  ['unknown preceding executable', 'unknown-command\npnpm run test:unit'],
  ['directory change on a preceding line', 'cd scripts\npnpm run test:unit'],
  ['OR short circuit', 'true || pnpm run test:unit'],
  ['backgrounded runner', 'pnpm run test:unit &'],
  ['redirected runner', 'pnpm run test:unit > /dev/null'],
  ['conditional runner', 'if false; then pnpm run test:unit; fi'],
  ['loop runner', 'while false; do pnpm run test:unit; done'],
  ['command substitution', '$(exit 0) pnpm run test:unit'],
  ['double-quoted command substitution', 'echo "$(exit 0)"\npnpm run test:unit'],
  ['unknown environment assignment', 'BASH_ENV=skip-tests.sh pnpm run test:unit'],
  ['unmodelled shell wrapper', 'bash -c "exit 0"\npnpm run test:unit'],
  ['literal instead of expanded wrapper path', "pnpm exec bash '$PWD/scripts/ci/rstest-weighted-shard.sh' 1/1 unit"],
]);
const workspaceFile = 'pnpm-workspace.yaml';
const runnerShardMutation = 'incomplete runner shard family';
const newBrowserScriptMutation = 'new unlisted AKROS browser script';
const unitJob = 'workspace-unit';
const artifactUnitJob = 'workspace-unit-artifacts';
const browserJob = 'browser-integration';
const playwrightTestCommand = 'playwright test';
const weightedShardScript = 'scripts/ci/rstest-weighted-shard.sh';
const absoluteWeightedShardScript = `$PWD/${weightedShardScript}`;
const integrationShellSource = `\${BASH_SOURCE[0]}`;
const promotionGenerator = '../../scripts/generate-ontos-module-contract.mts --vertical promotion --target dist';
const integrationNodeRunner =
  '--import ../../scripts/ci/integration-worker-setup.mts ../../node_modules/@rstest/core/bin/rstest.js';
const creditlessPnpmScripts = new Set([
  'typecheck',
  'lint:effect-diagnostics',
  'lint:effect-diagnostics:demo',
  'api:check:ontos',
  'handler-services:check',
  'lint',
  'shell:ui-candidates:check',
  'module-entrypoints:check',
]);
const defaultInclude = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const defaultExclude = ['**/node_modules/**', '**/dist/**', '**/.{idea,git,cache,output,temp}/**'];
const akrosBrowserManualReason =
  'Manual AKROS browser suite against an operator-prepared site and shared browser; no CI job invokes test:browser.';
const manual = new Map([
  ...[
    'account-profile',
    'address-autocomplete-live',
    'favorites-routing',
    'favorites',
    'home-carousel',
    'newsletter-consent',
    'product-actions',
    'search-routing',
    'variant-detail',
    'variant-filters',
    'variant-list',
  ].map((name): [string, string] => [
    `akros-storefront/tests/browser/${name}.mjs`,
    name === 'newsletter-consent'
      ? 'Operator-run proof requiring CI runner variables and a prepared stage customer; no checked-in CI job invokes it.'
      : akrosBrowserManualReason,
  ]),
  [
    'akros-storefront/tests/browser/variant-filter-checks.mjs',
    'Helper imported by the manual variant-filters suite; not a standalone runner and not invoked by CI.',
  ],
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
const configProjects = (file: string, readInput = read) => {
  const text = readInput(file);
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

// Every dispatch boundary is closed: credit only fully modelled keys, selectors and shell text; reject the
// offending input rather than extracting a plausible runner from an otherwise unmodelled execution path.
// Like matrixDispatcher, this fixed supervisor grammar models the task handoffs and their status propagation.
// Only literal file arrays and terminal exec commands vary; routing/control-flow changes require a new model.
const validateIntegrationExecutor = (executor: string) => {
  // A backslash in a shell comment does not continue that comment onto the next executable line.
  const lines = executor
    .replaceAll(/^[\t ]*#[^\n]*/gmu, '')
    .replaceAll('\\\n', ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const model = read('scripts/tests/support/ci-integration-executor.txt').trim().split('\n');
  let index = 0;
  for (const expected of model) {
    if (expected === '@@ARRAY@@') {
      while (index < lines.length && lines[index] !== ')') {
        expect(lines[index], `Unsupported integration executor array item: ${lines[index]}`).toMatch(
          /^[A-Za-z0-9_./-]+$/u,
        );
        index += 1;
      }
    } else {
      const line = lines[index] ?? '<end of script>';
      const supported = expected.startsWith('@@EXEC@@')
        ? (expected.endsWith(' ;;') ? /^exec .+ ;;$/u : /^exec [^;]+$/u).test(line)
        : line === expected;
      expect(supported, `Unsupported integration executor line: ${line}; expected ${expected}`).toBe(true);
      index += 1;
    }
  }
  expect(index === lines.length, `Unsupported integration executor line: ${lines[index]}`).toBe(true);
};

// Follow the executor's actual task branches, including shell array handoffs and CLI excludes. A package's project
// alone is not enough: migration files deliberately leave its shards and must have their whole task in the matrix.
const integrationCommand = (executor: string, task: string) => {
  validateIntegrationExecutor(executor);
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
          : (arrays.get(name) ?? expect.fail(`Unsupported integration executor array: ${name}`)).join(' '),
      )
      .replaceAll(`"\${task%#*}"`, task.split('#')[0] ?? '')
      .replaceAll('"$task"', task)
      .replaceAll(`"\${task#root:}"`, task.slice('root:'.length))
      .replaceAll(`"\${task##*#}"`, task.split('#')[1] ?? '');
  const text = executor.replaceAll('\\\n', ' ');
  if (task.startsWith('whole:')) {
    const start = text.indexOf(`    ${task})`);
    expect(start, `missing executor for ${task}`).toBeGreaterThan(-1);
    const command = text
      .slice(start, text.indexOf(';;', start))
      .split('\n')
      .find((line) => line.trim().startsWith('exec '));
    expect(command, `missing executable command for ${task}`).toBeDefined();
    return expand(command ?? '', []);
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
const ConditionSchema = Schema.Union([Schema.String, Schema.Boolean]);
const DefaultsSchema = Schema.Struct({
  run: Schema.optionalKey(
    Schema.Struct({
      shell: Schema.optionalKey(Schema.String),
      'working-directory': Schema.optionalKey(Schema.String),
    }),
  ),
});
const StepSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
  if: Schema.optionalKey(ConditionSchema),
  name: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  shell: Schema.optionalKey(Schema.String),
  'working-directory': Schema.optionalKey(Schema.String),
});
const WorkflowSchema = Schema.Struct({
  defaults: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  env: Schema.Struct({ CI_MATRICES_OVERLAY: Schema.String }),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      defaults: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      if: Schema.optionalKey(ConditionSchema),
      steps: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      strategy: Schema.optionalKey(
        Schema.Struct({
          matrix: Schema.Struct({
            include: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
          }),
        }),
      ),
    }),
  ),
});
type Workflow = typeof WorkflowSchema.Type;
type WorkflowStep = typeof StepSchema.Type;
type WorkflowInputStep = NonNullable<Workflow['jobs'][string]['steps']>[number];
const modelDefaults = (input: NonNullable<Workflow['defaults']> | undefined) => {
  const result = Schema.decodeUnknownResult(DefaultsSchema, { onExcessProperty: 'error' })(input ?? {});
  if (Result.isFailure(result)) {
    return expect.fail(`Unsupported test dispatch defaults: ${JSON.stringify(input)}: ${String(result.failure)}`);
  }
  return result.success;
};

const modelStep = (workflow: Workflow, job: Workflow['jobs'][string], input: WorkflowInputStep) => {
  const decoded = Schema.decodeUnknownResult(StepSchema, { onExcessProperty: 'error' })(input);
  if (Result.isFailure(decoded)) {
    return expect.fail(`Unsupported test dispatch step: ${JSON.stringify(input)}: ${String(decoded.failure)}`);
  }
  const step = decoded.success;
  const workflowDefaults = modelDefaults(workflow.defaults);
  const jobDefaults = modelDefaults(job.defaults);
  const shell = step.shell ?? jobDefaults.run?.shell ?? workflowDefaults.run?.shell;
  expect(shell === undefined || shell === 'bash', `Unsupported test dispatch shell: ${shell}`).toBe(true);
  const directory = path.posix.relative(
    'app',
    step['working-directory'] ??
      jobDefaults.run?.['working-directory'] ??
      workflowDefaults.run?.['working-directory'] ??
      '.',
  );
  return { ...step, directory };
};
const staticallyFalse = (condition: typeof ConditionSchema.Type | undefined) =>
  condition === false ||
  (Schema.is(Schema.String)(condition) && /^(?:false|\$\{\{\s*false\s*\}\})$/u.test(condition.trim()));
const stepEnabled = (step: WorkflowStep, allowed: readonly string[] = []) => {
  if (staticallyFalse(step.if)) {
    return false;
  }
  if (step.if === undefined || step.if === true || step.if === 'true' || allowed.includes(String(step.if))) {
    return true;
  }
  return expect.fail(`Unsupported test dispatch condition: ${String(step.if)}`);
};
// These conditions select known CI plan outputs, not arbitrary runtime expressions. A new condition needs review.
const ciPlanReady = "!cancelled() && needs.ci-plan.result == 'success'";
const nodeBuildReady = " && needs.node-artifact-build.result == 'success'";
const expectedGate = (job: string) => ` && fromJSON(needs.ci-plan.outputs.expected)['${job}'] == 'success'`;
const jobConditions = new Map([
  [sourceJob, ciPlanReady + expectedGate(sourceJob)],
  [unitJob, ciPlanReady + expectedGate(unitJob)],
  [artifactUnitJob, ciPlanReady + nodeBuildReady + expectedGate(artifactUnitJob)],
  [lintJob, ciPlanReady + expectedGate(lintJob)],
  [topologyJob, `${ciPlanReady}${nodeBuildReady} && needs.ci-plan.outputs.integrationTopology != '[]'`],
  [browserJob, `${ciPlanReady} && needs.ci-plan.outputs.integrationBrowser != '[]'`],
  [
    'owner-integration',
    `${ciPlanReady}${nodeBuildReady} && needs.service-integration.result == 'success' && needs.ci-plan.outputs.integrationOwners != '[]'`,
  ],
]);
const jobEnabled = (job: Workflow['jobs'][string], name: string) => {
  const condition = jobConditions.get(name);
  return stepEnabled({ if: job.if }, condition === undefined ? [] : [`\${{ ${condition} }}`]);
};
const unwrapCommand = (input: readonly string[]) => {
  let tokens = [...input];
  const environment = new Set([
    'ONTOS_PREPROPOSAL_STANDALONE=true',
    'ONTOS_PREPROPOSAL_NATIVE=true',
    'ONTOS_APPROVAL_NATIVE=true',
  ]);
  while (environment.has(tokens[0] ?? '')) {
    tokens.shift();
  }
  if (tokens[0] === 'timeout') {
    tokens.shift();
    while (/^--(?:foreground|kill-after=\d+s)$/u.test(tokens[0] ?? '')) {
      tokens.shift();
    }
    expect(tokens.shift(), 'Unsupported CI timeout wrapper').toMatch(/^\d+[sm]$/u);
  }
  if (tokens.slice(0, 3).join(' ') === `bash ${integrationShellSource} --shell-shard`) {
    expect(tokens[3], 'Unsupported CI command shell-shard task').toMatch(/^\.\/apps\/shell-super-app#\d+\/\d+$/u);
    tokens = tokens.slice(4);
  }
  if (tokens.slice(0, 3).join(' ') === 'mise exec --') {
    tokens = tokens.slice(3);
  }
  return tokens;
};

// Derive the accepted grammar from ci-matrices{,.demo}.json, the workflow's literal test steps, their package
// scripts and the executor's extracted terminal command, not from a blacklist of shell control words:
//   sequence := simple-command (newline simple-command)*
//   word := [A-Za-z0-9_./:@%=,+!#-]+ | single-quoted-literal | double-quoted-literal
// A simple command may carry the three literal preproposal environment assignments, then the timeout wrapper
// (integer s/m duration; --foreground / --kill-after=Ns), the integration --shell-shard adapter, and mise exec --,
// in that order, exactly as unwrapCommand models them. Runner/pnpm options are parsed separately below.
// Whitespace separates words; backslash-newline continues a line. Quotes may concatenate literal word parts.
// Single-quoted words containing $ are rejected too, so literal paths cannot masquerade as expanded adapters.
// Only "$PWD/scripts/ci/rstest-weighted-shard.sh" expands in ordinary commands; only the extracted integration
// terminal command may additionally use "${BASH_SOURCE[0]}" and a leading exec (never a sequence).
// Simple commands are pnpm, rstest, vitest, playwright, echo (no credit), the exact node/bash adapters below, and the
// shared-contracts typecheck. No other shell executable, expansion, control operator or redirection is accepted.
// Other AND lists (including the root test:unit script, unused by today's matrices) fail with the complete input.
// These two exact package scripts are the only AND lists in the credited call graph today. They have a known
// generator/typecheck prerequisite and a required-success RHS; a successful CI job therefore executed both.
const understoodAndLists = new Set([
  'node ../../scripts/generate-ontos-module-contract.mts --vertical promotion --target dist && rstest --project integration',
  'ultramodern-create ultramodern typecheck --project tests/tsconfig.json && ultramodern-create ultramodern typecheck --project tests/client-runtime-types.tsconfig.json',
]);
const supportedDoubleQuote = (literal: string, terminalExec: boolean) =>
  !/[`\\]/u.test(literal) &&
  (!literal.includes('$') ||
    literal === absoluteWeightedShardScript ||
    (terminalExec && literal === integrationShellSource));
const supportedQuote = (quote: string, literal: string, terminalExec: boolean) =>
  quote === '"' ? supportedDoubleQuote(literal, terminalExec) : !literal.includes('$');
const creditlessCommand = (executable: string, args: readonly string[]) =>
  executable === 'echo' ||
  (executable === 'node' && args.join(' ') === promotionGenerator) ||
  (executable === 'ultramodern-create' &&
    /^ultramodern typecheck --project tests\/(?:tsconfig|client-runtime-types\.tsconfig)\.json$/u.test(args.join(' ')));
const supportedShellCommand = (command: readonly string[]) => {
  const [executable = '', ...args] = unwrapCommand(command);
  return (
    ['pnpm', 'rstest', 'vitest', 'playwright'].includes(executable) ||
    creditlessCommand(executable, args) ||
    (executable === 'bash' && [weightedShardScript, absoluteWeightedShardScript].includes(args[0] ?? '')) ||
    (executable === 'node' &&
      (args.slice(0, 3).join(' ') === integrationNodeRunner ||
        (args.length === 1 && /^tests\/browser\/[\w-]+\.mjs$/u.test(args[0] ?? ''))))
  );
};
const validateShellCommands = (commands: string[][], text: string, terminalExec: boolean) => {
  for (const command of commands) {
    if (command[0] === 'exec') {
      if (!terminalExec || commands.length !== 1) {
        expect.fail(`Unsupported CI command control transfer in line: ${text}`);
      }
      command.shift();
    }
    expect(supportedShellCommand(command), `Unsupported CI command executable in line: ${text}`).toBe(true);
  }
};
const shellCommands = (text: string, terminalExec = false) => {
  const input = understoodAndLists.has(text.trim()) ? text.trim().replace(' && ', '\n') : text;
  const unsupported = () => expect.fail(`Unsupported CI command syntax or executable in line: ${text}`);
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let quoted = '';
  let quoteStart = 0;
  let started = false;
  const finishToken = () => {
    if (started) {
      tokens.push(token);
    }
    token = '';
    started = false;
  };
  const finishCommand = () => {
    finishToken();
    if (tokens.length > 0) {
      commands.push(tokens);
    }
    tokens = [];
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    if (quoted !== '') {
      if (char === quoted) {
        const literal = input.slice(quoteStart + 1, index);
        if (!supportedQuote(quoted, literal, terminalExec)) {
          return unsupported();
        }
        quoted = '';
      } else {
        token += char;
      }
    } else if (char === "'" || char === '"') {
      quoted = char;
      quoteStart = index;
      started = true;
    } else if (char === '\\' && input[index + 1] === '\n') {
      index += 1;
    } else if (char === '\n') {
      finishCommand();
    } else if (/\s/u.test(char)) {
      finishToken();
    } else {
      if (!/[A-Za-z0-9_./:@%=,+!#-]/u.test(char)) {
        return unsupported();
      }
      token += char;
      started = true;
    }
  }
  expect(quoted, `Unterminated CI command quote: ${text}`).toBe('');
  finishCommand();
  validateShellCommands(commands, text, terminalExec);
  return commands;
};
const matrixDispatcher = `failed=()
while IFS= read -r command; do
  [[ -n "$command" ]] || continue
  echo "::group::$command"
  started=$SECONDS
  if ! mise exec -- bash -c "$command"; then
    failed+=("$command")
  fi
  printf 'Command wall time: %ss — %s\\n' "$((SECONDS - started))" "$command"
  echo '::endgroup::'
done <<<"$COMMANDS"
for command in "\${failed[@]}"; do
  echo "::error title=Gate command failed::$command"
done
[[ \${#failed[@]} -eq 0 ]]`;
const pnpmTarget = (directory: string, selector: string, packages: ReadonlyMap<string, typeof PackageSchema.Type>) => {
  const target =
    selector === '.' || selector === './' || selector.startsWith('./') || selector.startsWith('../')
      ? [...packages.keys()].find((root) => path.posix.normalize(path.posix.join(directory, selector)) === root)
      : [...packages].find(([, manifest]) => manifest.name === selector)?.[0];
  if (target === undefined || !/^(?:@?[A-Za-z0-9_./-]+)$/u.test(selector)) {
    return expect.fail(
      `Unsupported pnpm filter: ${selector}. Use an exact workspace package name or an explicit ./ or ../ package directory.`,
    );
  }
  return target;
};
const pnpmInvocation = (
  directory: string,
  args: readonly string[],
  packages: ReadonlyMap<string, typeof PackageSchema.Type>,
) => {
  const tokens = [...args];
  const selectors: string[] = [];
  let recursive = false;
  while (tokens[0]?.startsWith('-')) {
    const option = tokens.shift();
    if (option === '--filter') {
      selectors.push(tokens.shift() ?? '');
    } else if (option === '-r') {
      recursive = true;
    } else if (option !== '--no-sort' && option !== '--if-present') {
      expect.fail(`Unsupported pnpm collection option: ${option}`);
    }
  }
  const included = new Set(
    selectors
      .filter((selector) => !selector.startsWith('!'))
      .map((selector) => pnpmTarget(directory, selector, packages)),
  );
  const excluded = new Set(
    selectors
      .filter((selector) => selector.startsWith('!'))
      .map((selector) => pnpmTarget(directory, selector.slice(1), packages)),
  );
  const targets =
    selectors.length === 0 && !recursive
      ? [directory]
      : [...packages.keys()].filter(
          (target) =>
            (target !== '.' || included.has('.')) &&
            (included.size === 0 || included.has(target)) &&
            !excluded.has(target),
        );
  return { targets, tokens };
};
interface RunnerSelection {
  excludes: string[];
  filters: string[];
  namePattern: string;
  names: string[];
  shard: string;
}
const runnerOption = (selection: RunnerSelection, option: string, value: string) =>
  Match.value(option).pipe(
    Match.when('--project', () => ({ ...selection, names: [...selection.names, value] })),
    Match.when('--exclude', () => ({ ...selection, excludes: [...selection.excludes, value] })),
    Match.whenOr('-t', '--testNamePattern', () => ({ ...selection, namePattern: value })),
    Match.when('--config', () => {
      expect(value, 'Unsupported runner config selector').toBe(rstestConfig);
      return selection;
    }),
    Match.when('--shard', () => {
      expect(value, 'Unsupported runner shard').toMatch(/^[1-9]\d*\/[1-9]\d*$/u);
      return { ...selection, shard: value };
    }),
    Match.whenOr('--pool.maxWorkers', '--testTimeout', () => {
      expect(value, `Unsupported runner option ${option}`).toMatch(/^[1-9]\d*$/u);
      return selection;
    }),
    Match.orElse(() =>
      expect.fail(
        `Unsupported runner collection selector: ${option}. Extend the census parser before awarding execution credit.`,
      ),
    ),
  );

const completeRunnerShard = (
  families: Map<string, { count: number; indices: Set<number> }>,
  family: string,
  shard: string,
) => {
  if (shard === '') {
    return true;
  }
  const [index = 0, count = 0] = shard.split('/').map(Number);
  expect(index, `Invalid runner shard ${shard}`).toBeLessThanOrEqual(count);
  const existing = families.get(family) ?? { count, indices: new Set<number>() };
  expect(existing.count, `Runner shard counts differ: ${family}`).toBe(count);
  const duplicate = existing.indices.has(index);
  existing.indices.add(index);
  families.set(family, existing);
  return !duplicate && existing.indices.size === count;
};

const runnerSelection = (input: readonly string[]) => {
  if (input.includes('list')) {
    return null;
  }
  const tokens = [...input];
  const excludes: string[] = [];
  const filters: string[] = [];
  const names: string[] = [];
  let selection: RunnerSelection = { excludes, filters, namePattern: '', names, shard: '' };
  while (tokens.length > 0) {
    const token = tokens.shift() ?? '';
    if (token !== 'run') {
      if (token.startsWith('-')) {
        if (token.includes('=')) {
          expect.fail(
            `Unsupported runner collection selector: ${token}. Extend the census parser before awarding execution credit.`,
          );
        }
        const value = tokens.shift();
        if (value === undefined || value.startsWith('--')) {
          expect.fail(`Missing runner option value: ${token}`);
        }
        selection = runnerOption(selection, token, value ?? '');
      } else if (/^(?:tests|scripts|tools)\/[\w./*-]+$/u.test(token)) {
        selection.filters.push(token);
      } else {
        expect.fail(
          `Unsupported runner collection selector: ${token}. Extend the census parser before awarding execution credit.`,
        );
      }
    }
  }
  return selection;
};
// Mirror the pinned Playwright FullProjectInternal precedence and createFileMatcher rules, without importing
// the config (which reads operator environment). Read name, projects, testDir, testMatch, testIgnore, grep and
// grepInvert; either effective title filter grants no full-file credit. Only the following runtime-only options
// used by today's config are ignored. Every other option fails closed, including unmodelled selectors such as
// shard, testList, testListInverted, respectGitIgnore, dependencies, repeatEach or maxFailures.
const playwrightRuntimeOptions = new Set([
  'build',
  'forbidOnly',
  'fullyParallel',
  'metadata',
  'reporter',
  'retries',
  'use',
  'webServer',
  'workers',
]);
const playwrightSelectionOptions = new Set([
  'name',
  'projects',
  'testDir',
  'testMatch',
  'testIgnore',
  'grep',
  'grepInvert',
]);
type PlaywrightPattern = string | RegExp;
const playwrightProjects = (file: string, text: string) => {
  const source = parseSync(file, text);
  expect(source.errors, file).toEqual([]);
  const exported = source.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  const declaration = exported?.type === 'ExportDefaultDeclaration' ? exported.declaration : undefined;
  if (
    declaration?.type === 'CallExpression' &&
    (declaration.arguments.length !== 1 ||
      declaration.callee.type !== 'Identifier' ||
      declaration.callee.name !== 'defineConfig')
  ) {
    return expect.fail(`${file}: unsupported Playwright config composition`);
  }
  const config = declaration?.type === 'CallExpression' ? declaration.arguments[0] : declaration;
  if (config?.type !== 'ObjectExpression') {
    return expect.fail(`${file}: expected a literal Playwright config`);
  }
  const validateOptions = (object: ObjectExpression): void => {
    const keys = new Set<string>();
    for (const property of object.properties) {
      const key = propertyName(property);
      if (
        property.type !== 'Property' ||
        property.computed ||
        property.method ||
        property.kind !== 'init' ||
        !Schema.is(Schema.String)(key) ||
        keys.has(key) ||
        (!playwrightSelectionOptions.has(key) && !playwrightRuntimeOptions.has(key))
      ) {
        expect.fail(
          `${file}: unsupported Playwright collection option: ${String(key)}. Extend the census model before awarding credit.`,
        );
      }
      keys.add(key);
    }
  };
  validateOptions(config);
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
  const value = (project: ObjectExpression, key: string) => initializer(project, key) ?? initializer(config, key);
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
  return projects.map((project) => {
    validateOptions(project);
    return {
      name: string(value(project, 'name'), ''),
      nameFiltered: value(project, 'grep') !== undefined || value(project, 'grepInvert') !== undefined,
      testDir: string(value(project, 'testDir'), '.'),
      testIgnore: patterns(value(project, 'testIgnore')),
      testMatch:
        value(project, 'testMatch') === undefined
          ? ['**/*.@(spec|test).?(c|m)[jt]s?(x)']
          : patterns(value(project, 'testMatch')),
    };
  });
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
const playwrightTitleOptions = new Set(['--grep', '--grep-invert']);
const playwrightArguments = (tokens: readonly string[]) => {
  const names: string[] = [];
  const filters: RegExp[] = [];
  let nameFiltered = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--project') {
      index += 1;
      const name = tokens[index];
      expect(name, 'Missing Playwright project').toBeDefined();
      names.push(name ?? '');
    } else if (playwrightTitleOptions.has(token) || ['--workers', '--retries', '--repeat-each'].includes(token)) {
      if (playwrightTitleOptions.has(token)) {
        nameFiltered = true;
      }
      index += 1;
      const value = tokens[index];
      expect(value, `Missing Playwright option value: ${token}`).toBeDefined();
      if (!playwrightTitleOptions.has(token)) {
        expect(value, `Unsupported Playwright option value: ${token}`).toMatch(/^\d+$/u);
        if (token !== '--retries') {
          expect(Number(value), token).toBeGreaterThan(0);
        }
      }
    } else if (token.startsWith('-')) {
      return expect.fail(`Unsupported Playwright collection option: ${token}`);
    } else {
      filters.push(new RegExp(token, 'u'));
    }
  }
  return { filters, nameFiltered, names };
};
interface BrowserInputs {
  appRoot: string;
  browserEnabled: boolean;
  packages: ReadonlyMap<string, typeof PackageSchema.Type>;
  read: (file: string) => string;
  tests: readonly string[];
  workflow: typeof WorkflowSchema.Type;
}
const browserInvocation = (input: readonly string[], directory: string, packages: BrowserInputs['packages']) => {
  const [executable, filter, selector = '', ...command] = unwrapCommand(input);
  if (executable !== 'pnpm' || filter !== '--filter') {
    return null;
  }
  const root = pnpmTarget(directory, selector, packages);
  const manifest = packages.get(root);
  let tokens = command[0] === 'run' ? command.slice(1) : command;
  const [script = '', ...extra] = tokens;
  if (/^test(?::[\w-]+)*$/u.test(script)) {
    const parts = shellCommands(manifest?.scripts?.[script] ?? '');
    expect(parts.length, `Unsupported browser script chain: ${root}:${script}`).toBe(1);
    tokens = [...(parts[0] ?? []), ...extra];
  }
  if (tokens[0] === 'exec') {
    tokens = tokens.slice(1);
  }
  return tokens.slice(0, 2).join(' ') === playwrightTestCommand
    ? { root, ...playwrightArguments(tokens.slice(2)) }
    : null;
};
const collectPlaywright = (invocation: NonNullable<ReturnType<typeof browserInvocation>>, inputs: BrowserInputs) => {
  const { filters, names, root } = invocation;
  if (invocation.nameFiltered) {
    return [];
  }
  const configFile = path.posix.join(root, 'playwright.config.ts');
  const projects = playwrightProjects(configFile, inputs.read(configFile));
  for (const name of names) {
    expect(
      projects.some((project) => project.name === name),
      configFile,
    ).toBe(true);
  }
  return projects
    .filter((project) => !project.nameFiltered && (names.length === 0 || names.includes(project.name)))
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
  const job = inputs.workflow.jobs[browserJob];
  if (job === undefined || !jobEnabled(job, browserJob)) {
    return collected;
  }
  expect(job.strategy?.matrix.include, 'browser matrix dispatcher').toBe(
    `\${{ fromJSON(needs.ci-plan.outputs.integrationBrowser) }}`,
  );
  for (const input of (job.steps ?? []).filter((step) =>
    [
      'Run parallel authenticated browser tests without retries',
      'Verify browser recovery into a newly published release',
    ].some((name) => step.name === name),
  )) {
    const step = modelStep(inputs.workflow, job, input);
    if (!stepEnabled(step, ["matrix.suite == 'browser'"])) {
      continue;
    }
    const { directory } = step;
    expect(
      directory === '..' || directory.startsWith('../'),
      `Browser working directory is outside the app workspace: ${directory}`,
    ).toBe(false);
    for (const command of shellCommands(step.run ?? '')) {
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

const testFilename = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const censusScope = `filenames matching ${testFilename} (excluding tools/oxlint/effect-native/tests/fixtures/) and akros-storefront/tests/browser/*.mjs; directory names excluded at every depth: ${[...ignoredDirectories].join(', ')}; direct static relative imports without test declarations count as supporting modules`;
const checkCollection = (root: string, manualSuites: ReadonlyMap<string, string>) => {
  const readInput = (file: string) => readFileSync(path.join(root, file), 'utf-8');
  const files = walk('', root);
  const tests = files.filter(
    (file) =>
      (testFilename.test(file) && !file.startsWith('tools/oxlint/effect-native/tests/fixtures/')) ||
      /^akros-storefront\/tests\/browser\/[^/]+\.mjs$/u.test(file),
  );
  const workflow = Schema.decodeUnknownSync(WorkflowSchema)(parse(readInput(workflowFile)));
  const matrices = Result.getOrThrow(
    parseCiMatrices(readInput(matrixFile), readInput(workflow.env.CI_MATRICES_OVERLAY)),
  );
  const workspace = Schema.decodeUnknownSync(Schema.Struct({ packages: Schema.Array(Schema.String) }))(
    parse(readInput(workspaceFile)),
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
        Schema.decodeUnknownSync(Schema.fromJsonString(PackageSchema))(readInput(file)),
      ]),
  );
  const projects = new Map(
    [...packages.keys()].map((directory) => {
      const config = path.posix.join(directory, rstestConfig);
      const vitest = path.posix.join(directory, 'vitest.config.ts');
      if (existsSync(path.join(root, config))) {
        return [directory, configProjects(config, readInput)];
      }
      if (existsSync(path.join(root, vitest))) {
        return [directory, configProjects(vitest, readInput)];
      }
      return [directory, [{ exclude: defaultExclude, include: defaultInclude, name: 'unit' }]];
    }),
  );
  const collected = new Set<string>();
  let checkoutCollections = 0;
  const n1Collections = new Map<string, number>();
  const weightedShards = new Map<string, string[]>();
  const weightedSelections = new Map<string, string>();
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
        if (file.startsWith('n1-storefront/')) {
          n1Collections.set(file, (n1Collections.get(file) ?? 0) + 1);
        }
        if (file === checkoutProofFile) {
          checkoutCollections += 1;
        }
      }
    }
  };
  const nameFiltered = new Map<string, Set<string>>();
  const runnerShards = new Map<string, { count: number; indices: Set<number> }>();
  const commands = {
    runCommand(directory: string, command: string, seen: readonly string[] = [], terminalExec = false) {
      for (const tokens of shellCommands(command, terminalExec)) {
        commands.runTokens(directory, tokens, seen);
      }
    },
    runPnpm(directory: string, args: readonly string[], seen: readonly string[]): void {
      const { targets, tokens } = pnpmInvocation(directory, args, packages);
      const [verb, ...extra] = tokens;
      if (verb === 'exec') {
        for (const target of targets) {
          commands.runTokens(target, extra, seen);
        }
      } else {
        const [script = '', ...scriptArgs] = verb === 'run' ? extra : tokens;
        if (/^test(?::[\w-]+)*$/u.test(script)) {
          for (const target of targets) {
            commands.runScript(target, script, scriptArgs, seen);
          }
        } else {
          expect(
            scriptArgs.length === 0 && creditlessPnpmScripts.has(script),
            `Unsupported CI command: pnpm ${args.join(' ')}`,
          ).toBe(true);
        }
      }
    },
    runRunner(directory: string, input: readonly string[], awardCredit = true): void {
      const selection = runnerSelection(input);
      if (selection === null) {
        return;
      }
      const { excludes, filters, namePattern, names } = selection;
      expect(projects.has(directory), `Unknown runner working directory: ${directory}`).toBe(true);
      for (const name of names) {
        expect(
          projects.get(directory)?.some((project) => project.name === name),
          `Unknown runner project ${directory}:${name}`,
        ).toBe(true);
      }
      if (!awardCredit) {
        return;
      }
      if (namePattern !== '') {
        // Name-filtered commands do not prove a whole file. The repo's privacy pair is an exact regex complement;
        // only both invocations with identical file/project/exclusion selection can collectively receive credit.
        const key = JSON.stringify([directory, names, filters, excludes, selection.shard]);
        const patterns = nameFiltered.get(key) ?? new Set<string>();
        patterns.add(namePattern);
        nameFiltered.set(key, patterns);
        if (![...patterns].some((pattern) => pattern.startsWith('^') && patterns.has(`^(?!${pattern.slice(1)})`))) {
          return;
        }
      }
      if (completeRunnerShard(runnerShards, JSON.stringify([directory, names, filters, excludes]), selection.shard)) {
        collect(directory, names, filters, excludes);
      }
    },
    runScript(directory: string, name: string, extra: readonly string[], seen: readonly string[]) {
      const script = packages.get(directory)?.scripts?.[name];
      if (script === undefined) {
        return;
      }
      const identity = `${directory}:${name}`;
      expect(seen, `recursive script ${identity}`).not.toContain(identity);
      const parts = shellCommands(script);
      for (const [index, tokens] of parts.entries()) {
        commands.runTokens(directory, index === parts.length - 1 ? [...tokens, ...extra] : tokens, [...seen, identity]);
      }
    },
    runTokens(directory: string, input: readonly string[], seen: readonly string[]): void {
      const [executable = '', ...args] = unwrapCommand(input);
      if (executable === 'pnpm') {
        commands.runPnpm(directory, args, seen);
      } else if (executable === 'rstest' || executable === 'vitest') {
        commands.runRunner(directory, args);
      } else if (executable === 'node' && args.slice(0, 3).join(' ') === integrationNodeRunner) {
        commands.runRunner(directory, args.slice(3));
      } else if (executable === 'bash' && [weightedShardScript, absoluteWeightedShardScript].includes(args[0] ?? '')) {
        commands.runWeighted(directory, args.slice(1));
      } else if (executable === 'node' && /^tests\/browser\/[^/]+\.mjs$/u.test(args[0] ?? '')) {
        expect(args.length, 'Unsupported browser script arguments').toBe(1);
        collected.add(path.posix.join(directory, args[0] ?? ''));
      } else {
        expect(creditlessCommand(executable, args), `Unsupported CI command: ${input.join(' ')}`).toBe(true);
      }
      // Only the explicitly understood checks/generator and literal echo commands grant no execution credit.
    },
    runWeighted(directory: string, args: readonly string[]) {
      const [shard = '', project = '', ...options] = args;
      expect(shard, 'Unsupported weighted shard').toMatch(/^\d+\/\d+$/u);
      const family = `${directory}:${project}`;
      weightedShards.set(family, [...(weightedShards.get(family) ?? []), shard]);
      const selection = JSON.stringify(options);
      expect(weightedSelections.get(family) ?? selection, `Weighted shard selections differ: ${family}`).toBe(
        selection,
      );
      weightedSelections.set(family, selection);
      // Every shard must use the same understood selectors; the complete family runs its project once.
      commands.runRunner(directory, ['--project', project, ...options], weightedShards.get(family)?.length === 1);
    },
  };
  const collectIntegration = () => {
    const executor = readInput('scripts/ci/run-integration-suites.sh');
    const tasks = matrices.integration.flatMap((row) => row.tasks ?? []);
    const families = new Map<string, number[]>();
    for (const task of tasks) {
      const shard = /^(?<family>.+?)[#:]\d+\/(?<count>\d+)$/u.exec(task)?.groups;
      if (shard !== undefined) {
        families.set(shard.family ?? '', [...(families.get(shard.family ?? '') ?? []), Number(shard.count)]);
      }
      commands.runCommand('.', integrationCommand(executor, task), [], true);
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
  const dispatchRows = (jobName: string, matrixName: string, rows: typeof matrices.source) => {
    if (rows.length === 0) {
      return;
    }
    const job = workflow.jobs[jobName];
    expect(job, `Missing matrix dispatch job: ${jobName}`).toBeDefined();
    if (job === undefined || !jobEnabled(job, jobName)) {
      return;
    }
    expect(job.strategy?.matrix.include, `${jobName}: matrix binding`).toBe(
      `\${{ fromJSON(needs.ci-plan.outputs.${matrixName}) }}`,
    );
    const dispatch = job.steps?.find((step) => step.name === `Run \${{ matrix.name }}`);
    expect(dispatch, `Missing matrix dispatch step: ${jobName}`).toBeDefined();
    const step = dispatch === undefined ? undefined : modelStep(workflow, job, dispatch);
    if (step === undefined || !stepEnabled(step)) {
      return;
    }
    expect(step.env?.COMMANDS, `${jobName}: commands binding`).toBe(`\${{ matrix.commands }}`);
    expect(step.run?.trim(), `Unsupported matrix dispatcher body: ${jobName}`).toBe(matrixDispatcher);
    const { directory } = step;
    expect(directory, `${jobName}: matrix dispatch working directory must be app`).toBe('');
    for (const row of rows) {
      commands.runCommand('.', row.commands);
    }
  };
  dispatchRows(sourceJob, 'source', matrices.source);
  dispatchRows(
    unitJob,
    'unit',
    matrices.unit.filter((row) => row['node-artifacts'] !== true),
  );
  dispatchRows(
    artifactUnitJob,
    'unit-artifacts',
    matrices.unit.filter((row) => row['node-artifacts'] === true),
  );
  const collectLiteralSteps = () => {
    // Only these literal test steps dispatch suites outside the command matrices. Never scan arbitrary jobs/steps.
    for (const [jobName, stepName, conditions] of [
      [
        lintJob,
        'Test the Effect lint rules',
        [`\${{ !cancelled() && steps.install.outcome == 'success' && matrix.shard <= 1 }}`],
      ],
      [topologyJob, 'Prove migration equivalence on the cluster this row migrated', ["matrix.suite == 'bootstrap'"]],
    ] as const) {
      const job = workflow.jobs[jobName];
      if (
        job === undefined ||
        !jobEnabled(job, jobName) ||
        (jobName === topologyJob && !matrices.integration.some((row) => row.suite === 'bootstrap'))
      ) {
        continue;
      }
      for (const input of job.steps ?? []) {
        if (input.name === stepName) {
          const step = modelStep(workflow, job, input);
          if (stepEnabled(step, conditions)) {
            commands.runCommand(step.directory || '.', step.run ?? '');
          }
        }
      }
    }
  };
  collectLiteralSteps();
  for (const [family, shards] of weightedShards) {
    const counts = shards.map((shard) => Number(shard.split('/')[1]));
    expect(new Set(counts).size, family).toBe(1);
    expect(shards.toSorted(), family).toEqual(
      Array.from({ length: counts[0] ?? 0 }, (_, index) => `${index + 1}/${counts[0] ?? 0}`).toSorted(),
    );
  }
  const dispatchIntegration = () => {
    if (matrices.integration.some((row) => row.tasks !== undefined)) {
      const job = workflow.jobs['owner-integration'];
      expect(job, 'Missing owner integration dispatch job').toBeDefined();
      if (job !== undefined && jobEnabled(job, 'owner-integration')) {
        expect(job.strategy?.matrix.include, 'owner matrix binding').toBe(
          `\${{ fromJSON(needs.ci-plan.outputs.integrationOwners) }}`,
        );
        const dispatch = job.steps?.find(
          (step) =>
            step.name ===
            'Run database, RLS, Action, authorization, identity, Outbox, module-state, Shell, and Contacts integration tests, including Party Registry',
        );
        expect(dispatch, 'Missing owner integration dispatch step').toBeDefined();
        const step = dispatch === undefined ? undefined : modelStep(workflow, job, dispatch);
        if (step !== undefined && stepEnabled(step, ["matrix.suite == 'integration'"])) {
          expect(step.run, 'Unsupported owner integration dispatcher').toBe(
            'bash scripts/ci/run-integration-suites.sh',
          );
          expect(step.env?.INTEGRATION_TASKS, 'owner tasks binding').toBe(`\${{ toJSON(matrix.tasks) }}`);
          expect(step.directory, 'owner dispatch working directory must be app').toBe('');
          collectIntegration();
        }
      }
    }
  };
  dispatchIntegration();
  for (const file of tests.filter((entry) => entry.startsWith('n1-storefront/'))) {
    expect(n1Collections.get(file), `N1 must run in exactly one CI row: ${file}`).toBe(1);
  }
  if (tests.includes(checkoutProofFile)) {
    expect(checkoutCollections, 'The checkout browser proof must run in exactly one CI job').toBe(1);
  }
  for (const file of browserCollection({
    appRoot: root,
    browserEnabled: matrices.integration.some((row) => row.suite === 'browser'),
    packages,
    read: readInput,
    tests,
    workflow,
  })) {
    collected.add(file);
  }
  for (const [file, reason] of manualSuites) {
    expect(tests, `Stale manual census entry: ${file}`).toContain(file);
    expect(reason.length).toBeGreaterThan(0);
    expect(collected.has(file), `manual suite unexpectedly runs in CI: ${file}`).toBe(false);
  }
  expect(
    missingExecutableTests(tests, collected, readInput).filter((file) => !manualSuites.has(file)),
    `${uncollectedCensus} (${censusScope}): add a real CI invocation and matching runner include, or name the manual suite and its environment.`,
  ).toEqual([]);
};

it(`accounts for the bounded CI/manual census: ${censusScope}`, () => {
  checkCollection(app, manual);
});

const rootUnitScript =
  Schema.decodeUnknownSync(Schema.fromJsonString(PackageSchema))(read(packageManifest)).scripts?.['test:unit'] ??
  expect.fail('Missing root test:unit script');

it.each([
  ...[...unsupportedShellCommands.keys()].map((mutation) => [mutation, 'Unsupported CI command']),
  [invalidPackageSelector, 'Unsupported pnpm filter: packages/example'],
  ['matrix step syntax-only shell', unsupportedDispatchShell],
  ['literal step syntax-only shell', unsupportedDispatchShell],
  ['matrix step unknown key', unsupportedDispatchStep],
  [rootAndListMutation, rootUnitScript],
  ['echo-only package command', uncollectedCensus],
  ['echo-only runner command', uncollectedCensus],
  ['removed matrix dispatch step', 'Missing matrix dispatch step'],
  ['echo-only matrix dispatcher', 'Unsupported matrix dispatcher body'],
  ['disabled matrix dispatch step', uncollectedCensus],
  ['disabled literal step', uncollectedCensus],
  ['disabled boolean literal step', uncollectedCensus],
  ['disabled expression literal step', uncollectedCensus],
  ['disabled job', uncollectedCensus],
  ['unsupported job condition', 'Unsupported test dispatch condition'],
  ['equals project selector', 'Unsupported runner collection selector: --project=unit'],
  ['equals test-name selector', 'Unsupported runner collection selector: --testNamePattern=one-case'],
  ['test-name filtering', uncollectedCensus],
  [runnerShardMutation, uncollectedCensus],
  ['changed matrix working directory', 'matrix dispatch working directory must be app'],
  [literalDirectoryMutation, uncollectedCensus],
  [newBrowserScriptMutation, uncollectedCensus],
])('fails closed on scratch inputs: %s; restores to green', (mutation, failure) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ontos-dispatch-collection-'));
  const root = path.join(scratch, 'app');
  const workflow = Schema.decodeUnknownSync(WorkflowSchema)(parse(read(workflowFile)));
  const source = workflow.jobs[sourceJob];
  const lint = workflow.jobs[lintJob];
  expect(source).toBeDefined();
  expect(lint).toBeDefined();
  const dispatch = source?.steps?.find((step) => step.name === `Run \${{ matrix.name }}`);
  const literal = lint?.steps?.find((step) => step.name === 'Test the Effect lint rules');
  expect(dispatch).toBeDefined();
  expect(literal).toBeDefined();
  const literalCase = mutation.includes('literal step') || mutation === literalDirectoryMutation;
  const fixtureWorkflow = {
    defaults: workflow.defaults,
    env: workflow.env,
    jobs: {
      [lintJob]: { ...lint, steps: literal === undefined || !literalCase ? [] : [{ ...literal }] },
      [sourceJob]: { ...source, steps: dispatch === undefined || literalCase ? [] : [{ ...dispatch }] },
    },
  };
  const matrices = {
    integration: [],
    source: literalCase ? [] : [{ commands: 'pnpm run test:unit', name: 'Scratch executable suite' }],
    unit: [],
  };
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const originals = new Map([
    [workflowFile, stringify(fixtureWorkflow)],
    [matrixFile, JSON.stringify(matrices)],
    [workflow.env.CI_MATRICES_OVERLAY, '{}'],
    [workspaceFile, 'packages: []'],
    [
      'package.json',
      JSON.stringify({
        name: 'scratch',
        scripts: { 'test:lint-rules': scratchUnitCommand, 'test:unit': scratchUnitCommand },
      }),
    ],
    [
      rstestConfig,
      "export default defineConfig({ projects: [{ name: 'unit', include: ['scripts/**/*.test.mts'] }] });",
    ],
    [
      'scripts/tests/dispatch.test.mts',
      "import { it } from 'effect-rstest'; it('one-case', () => {}); it('another-case', () => {});",
    ],
  ]);
  try {
    for (const [file, text] of originals) {
      write(file, text);
    }
    checkCollection(root, new Map());
    const setCommands = (commands: string) => {
      const [row] = matrices.source;
      if (row === undefined) {
        expect.fail(`Missing scratch command row: ${mutation}`);
      } else {
        row.commands = commands;
      }
    };
    const changeStep = (job: keyof typeof fixtureWorkflow.jobs, changes: WorkflowInputStep) => {
      const [step] = fixtureWorkflow.jobs[job].steps;
      if (step === undefined) {
        expect.fail(`Missing scratch step: ${mutation}`);
      } else {
        fixtureWorkflow.jobs[job].steps = [{ ...step, ...changes }];
      }
    };
    const changes = new Map<string, () => void>([
      ...[...unsupportedShellCommands].map(([name, command]): [string, () => void] => [
        name,
        () => setCommands(command),
      ]),
      [
        invalidPackageSelector,
        () => {
          write(workspaceFile, 'packages: [packages/*]');
          write(
            'packages/example/package.json',
            JSON.stringify({ name: '@scratch/example', scripts: { 'test:unit': scratchUnitCommand } }),
          );
          write(
            'packages/example/tests/example.test.mts',
            "import { it } from 'effect-rstest'; it('example', () => {});",
          );
          setCommands('pnpm run test:unit\npnpm --filter packages/example run test:unit');
        },
      ],
      ...['matrix step syntax-only shell', 'literal step syntax-only shell'].map((name): [string, () => void] => [
        name,
        () => {
          changeStep(name.startsWith('literal') ? lintJob : sourceJob, { shell: 'bash -n {0}' });
        },
      ]),
      [
        'matrix step unknown key',
        () => {
          const [step] = fixtureWorkflow.jobs[sourceJob].steps;
          fixtureWorkflow.jobs[sourceJob].steps = [{ ...step, futureDispatchOption: 'do not execute' }];
        },
      ],
      [
        rootAndListMutation,
        () => {
          write(
            packageManifest,
            JSON.stringify({
              name: 'scratch',
              scripts: {
                'test:unit': rootUnitScript,
              },
            }),
          );
        },
      ],
      [
        'echo-only package command',
        () => {
          setCommands('echo pnpm run test:unit');
        },
      ],
      [
        'echo-only runner command',
        () => {
          setCommands('echo pnpm exec rstest run --project unit');
        },
      ],
      [
        'removed matrix dispatch step',
        () => {
          fixtureWorkflow.jobs[sourceJob].steps = [];
        },
      ],
      [
        'echo-only matrix dispatcher',
        () => {
          changeStep(sourceJob, { run: 'echo mise exec -- bash -c "$COMMANDS"' });
        },
      ],
      [
        'disabled matrix dispatch step',
        () => {
          changeStep(sourceJob, { if: 'false' });
        },
      ],
      [
        'disabled literal step',
        () => {
          changeStep(lintJob, { if: 'false' });
        },
      ],
      [
        'disabled boolean literal step',
        () => {
          changeStep(lintJob, { if: false });
        },
      ],
      [
        'disabled expression literal step',
        () => {
          changeStep(lintJob, { if: `\${{ false }}` });
        },
      ],
      [
        'disabled job',
        () => {
          fixtureWorkflow.jobs[sourceJob].if = 'false';
        },
      ],
      [
        'unsupported job condition',
        () => {
          fixtureWorkflow.jobs[sourceJob].if = '1 == 2';
        },
      ],
      [
        'equals project selector',
        () => {
          setCommands('pnpm exec rstest run --project=unit');
        },
      ],
      [
        'equals test-name selector',
        () => {
          setCommands('pnpm exec rstest run --project unit --testNamePattern=one-case');
        },
      ],
      [
        'test-name filtering',
        () => {
          setCommands('pnpm exec rstest run --project unit --testNamePattern one-case');
        },
      ],
      [
        runnerShardMutation,
        () => {
          setCommands('pnpm exec rstest run --project unit --shard 1/2');
        },
      ],
      [
        'changed matrix working directory',
        () => {
          changeStep(sourceJob, { 'working-directory': wrongWorkingDirectory });
        },
      ],
      [
        literalDirectoryMutation,
        () => {
          changeStep(lintJob, { 'working-directory': wrongWorkingDirectory });
        },
      ],
      [
        newBrowserScriptMutation,
        () => {
          write(
            'akros-storefront/tests/browser/new-suite.mjs',
            "import assert from 'node:assert/strict'; assert.ok(true);",
          );
        },
      ],
    ]);
    const change = changes.get(mutation);
    if (change === undefined) {
      expect.fail(`Scratch mutation did not apply: ${mutation}`);
    } else {
      change();
    }
    write(workflowFile, stringify(fixtureWorkflow));
    write(matrixFile, JSON.stringify(matrices));
    expect(() => checkCollection(root, new Map())).toThrow(failure);
    const unsupportedCommand = unsupportedShellCommands.get(mutation);
    if (unsupportedCommand !== undefined) {
      // The diagnostic must name the actual rejected input, not merely report a downstream collection gap.
      expect(() => checkCollection(root, new Map())).toThrow(unsupportedCommand);
    }
    if (mutation === runnerShardMutation) {
      setCommands('pnpm exec rstest run --project unit --shard 1/2\npnpm exec rstest run --project unit --shard 2/2');
      write(matrixFile, JSON.stringify(matrices));
      checkCollection(root, new Map());
    }
    if (mutation === newBrowserScriptMutation) {
      const script = 'akros-storefront/tests/browser/new-suite.mjs';
      checkCollection(root, new Map([[script, akrosBrowserManualReason]]));
      write(workspaceFile, 'packages: [akros-storefront]');
      write(
        'akros-storefront/package.json',
        JSON.stringify({
          name: 'akros-storefront',
          scripts: { 'test:browser': 'pnpm run test:new', 'test:new': 'node tests/browser/new-suite.mjs' },
        }),
      );
      setCommands('pnpm run test:unit\npnpm --filter ./akros-storefront run test:browser');
      write(matrixFile, JSON.stringify(matrices));
      checkCollection(root, new Map());
    }
    // Prove the original inputs still pass after the precise defect is removed, including inventory restoration.
    for (const [file, text] of originals) {
      write(file, text);
    }
    for (const file of walk('', root)) {
      if (!originals.has(file)) {
        rmSync(path.join(root, file));
      }
    }
    checkCollection(root, new Map());
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});

it.each([
  invalidPackageSelector,
  syntaxOnlyBrowserShell,
  'syntax-only inherited browser shell',
  browserUnknownStep,
  browserUnknownDefaults,
  'invocation removed',
  'uninvoked package',
  'testIgnore',
  'testMatch',
  'project selection',
  'URL-only reference',
  browserShardMutation,
  browserTitleMutation,
  browserInvertedTitleMutation,
  ...browserConfigFilters.keys(),
  ...unsupportedBrowserConfig.keys(),
  unmodelledProjectOption,
])('rejects a scratch CI input with %s, then accepts the restored inputs', (mutation) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ontos-browser-collection-'));
  const root = path.join(scratch, 'app');
  const shell = 'apps/shell-super-app';
  const configFile = `${shell}/playwright.config.ts`;
  const files = walk(shell).filter((file) => testFilename.test(file) && file.includes('/tests/e2e/'));
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
    const tests = inventory.filter((file) => testFilename.test(file));
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
    expect(missingExecutableTests(tests, collected, readInput), uncollectedBrowser).toEqual([]);
  };
  try {
    for (const [file, text] of originals) {
      write(file, text);
    }
    check();
    const configMutation = browserConfigMutation(mutation, readInput(configFile));
    const dispatchMutation = browserDispatchMutation(mutation, readInput(workflowFile), shell);
    if (dispatchMutation !== undefined) {
      write(workflowFile, dispatchMutation);
    } else if (mutation === 'invocation removed') {
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
        JSON.stringify({ name: '@app/uninvoked-browser', scripts: { 'test:e2e': playwrightTestCommand } }),
      );
      write(`${directory}/playwright.config.ts`, "export default defineConfig({ testDir: './tests/e2e' });");
      write(files.at(-1) ?? '', "import { test } from '@playwright/test'; test('not invoked', () => {});");
    } else if (mutation === 'testIgnore') {
      const ignored = files.find((file) => !file.endsWith('/login.spec.ts'));
      expect(ignored).toBeDefined();
      write(
        configFile,
        readInput(configFile).replace(
          chromiumAnchor,
          `name: 'chromium', testIgnore: ['**/${path.posix.basename(ignored ?? '')}'],`,
        ),
      );
    } else if (mutation === 'testMatch') {
      write(
        configFile,
        readInput(configFile).replace(chromiumAnchor, "name: 'chromium', testMatch: '**/login.spec.ts',"),
      );
    } else if (mutation === 'project selection') {
      write(workflowFile, readInput(workflowFile).replace('test:e2e', 'test:e2e --project chromium'));
      write(
        configFile,
        readInput(configFile).replace(
          projectArrayAnchor,
          "projects: [{ name: 'firefox', testDir: './tests/unselected' },",
        ),
      );
      write(
        `${shell}/tests/unselected/unselected.spec.ts`,
        "import { test } from '@playwright/test'; test('unselected project', () => {});",
      );
    } else if (configMutation !== null) {
      expect(configMutation).not.toBe(readInput(configFile));
      write(configFile, configMutation);
      expect(readInput(workflowFile)).toBe(originals.get(workflowFile));
    } else if (
      mutation === browserShardMutation ||
      mutation === browserTitleMutation ||
      mutation === browserInvertedTitleMutation
    ) {
      const option = new Map([
        [browserShardMutation, '--shard 1/2'],
        [browserTitleMutation, "--grep 'one-case'"],
        [browserInvertedTitleMutation, "--grep-invert 'one-case'"],
      ]).get(mutation);
      const original = readInput(workflowFile);
      const changed = original.replace('test:e2e', `test:e2e ${option ?? ''}`);
      expect(changed).not.toBe(original);
      const repeat = (text: string) =>
        Schema.decodeUnknownSync(WorkflowSchema)(parse(text)).jobs[browserJob]?.steps?.find(
          (step) => step.name === 'Verify browser recovery into a newly published release',
        )?.run;
      expect(repeat(original)).toContain(playwrightTestCommand);
      expect(repeat(changed)).toBe(repeat(original));
      write(workflowFile, changed);
    } else {
      const unexecuted = `${shell}/tests/not-in-testDir.spec.ts`;
      files.push(unexecuted);
      const referrer = files[0] ?? '';
      write(referrer, `${readInput(referrer)}\nnew URL('../not-in-testDir.spec.ts', import.meta.url);\n`);
      write(unexecuted, "import { test } from '@playwright/test'; test('URL is not execution', () => {});");
    }
    expect(() => check()).toThrow(browserMutationFailure(mutation));
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

const integrationExecutorFile = 'scripts/ci/run-integration-suites.sh';
it.each([
  ['whole arm early exit', '    whole:organization)\n', '      exit 0\n', organizationTask],
  [
    'comment continuation cannot hide an executable',
    '    whole:organization)\n',
    '      # literal comment \\\n      exit 0\n',
    organizationTask,
  ],
  [
    'second whole arm early exit',
    '    whole:organization-identity)\n',
    '      exit 0\n',
    'whole:organization-identity',
  ],
  ['nonliteral array item', 'core_runtime_migrations=(\n', '  $(exit 0)\n', organizationTask],
  ['appended supervisor executable', '', 'unknown-command', organizationTask],
  ['supervisor early exit', 'set -euo pipefail\n', 'exit 0\n', organizationTask],
  ['shard arm early exit', '  if [[ "$task" == root:* ]]; then\n', '    exit 0\n', 'root:1/1'],
  ['shard arm unknown executable', '  if [[ "$task" == root:* ]]; then\n', '    unknown-command\n', 'root:1/1'],
])('rejects unmodelled executor input: %s; restores to green', (_name, anchor, insertion, task) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ontos-executor-collection-'));
  const root = path.join(scratch, 'app');
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const workflow = Schema.decodeUnknownSync(WorkflowSchema)(parse(read(workflowFile)));
  try {
    write(
      workflowFile,
      stringify({
        defaults: workflow.defaults,
        env: workflow.env,
        jobs: { 'owner-integration': workflow.jobs['owner-integration'] },
      }),
    );
    write(
      matrixFile,
      JSON.stringify({
        integration: [{ name: 'Scratch integration', suite: 'integration', tasks: [task] }],
        source: [],
        unit: [],
      }),
    );
    write(workflow.env.CI_MATRICES_OVERLAY, '{}');
    write(workspaceFile, 'packages: []');
    write(packageManifest, JSON.stringify({ name: 'scratch' }));
    write(
      rstestConfig,
      "export default defineConfig({ projects: [{ name: 'integration', include: ['scripts/integration/**/*.test.mts'] }] });",
    );
    const suite = task.startsWith('root:')
      ? 'executor.test.mts'
      : `${task === organizationTask ? 'organization-source-customer-owner' : 'organization-source-customer-identity'}-conformance.test.mts`;
    write(`scripts/integration/${suite}`, "import { it } from 'effect-rstest'; it('must execute', () => {});");
    const original = read(integrationExecutorFile);
    write(integrationExecutorFile, original);
    checkCollection(root, new Map());
    write(
      integrationExecutorFile,
      anchor === '' ? `${original}\n${insertion}\n` : original.replace(anchor, anchor + insertion),
    );
    expect(() => checkCollection(root, new Map())).toThrow(
      insertion
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .trim(),
    );
    write(integrationExecutorFile, original);
    checkCollection(root, new Map());
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});
