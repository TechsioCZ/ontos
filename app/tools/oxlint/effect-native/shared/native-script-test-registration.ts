import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ESTree } from '@oxlint/plugins';
import { Predicate, Result, Schema } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type { Node, Program } from 'oxc-parser';
import { parse } from 'yaml';

import { parseCiMatrices } from '../../../../scripts/ci/ci-matrices.mts';
import type { CiScope } from '../../../../scripts/ci/ci-matrices-rules.mts';
import { isNativeScriptTest } from './native-script-test-filenames.ts';

export const nativeScriptAppRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const registrationName = 'nativeScriptTests';
const configurationFile = 'rstest.config.ts';
const mutationError = 'Mutated Rstest metadata';
const sourceJobName = 'workspace-gate';
const matrixCommands = 'matrix.commands';
const workflowExpression = (body: string) => `\${{ ${body} }}`;
const sourceMatrix = workflowExpression('fromJSON(needs.ci-plan.outputs.source)');
const commandEnvironment = workflowExpression(matrixCommands);

/** A closed dispatch form, not a search for a runner token inside possibly conditional shell code. */
export const nativeCiCommandDispatch = `failed=()
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

export type NativeScriptRegistration =
  | { readonly errors: readonly []; readonly files: readonly string[]; readonly kind: 'valid'; readonly root: string }
  | {
      readonly errors: readonly string[];
      readonly files: readonly [];
      readonly kind: 'invalid';
      readonly root: string;
    };

const refuse: (reason: string) => never = (reason) => {
  throw new Error(reason);
};

const expressionOf = (node: Node): Node =>
  node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' ? expressionOf(node.expression) : node;

type ModuleExpression = Node | ESTree.Node;

const moduleExpression = (node: ModuleExpression): ModuleExpression => {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'ChainExpression'
  ) {
    return moduleExpression(node.expression);
  }
  return node;
};

/** The rule and census share the same static module syntax, including cooked templates and concatenation. */
const moduleText = (input: ModuleExpression): string | undefined => {
  const node = moduleExpression(input);
  if (node.type === 'Literal' && Predicate.isString(node.value)) {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = moduleText(node.left);
    const right = moduleText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

const modulePrefix = (input: ModuleExpression): string | undefined => {
  const node = moduleExpression(input);
  const text = moduleText(node);
  if (text !== undefined) {
    return text;
  }
  if (node.type === 'TemplateLiteral') {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return node.type === 'BinaryExpression' && node.operator === '+' ? modulePrefix(node.left) : undefined;
};

export const nativeModuleAccess = (
  node: ModuleExpression,
): 'node:test' | 'node:assert/strict' | 'unsupported' | undefined => {
  const text = moduleText(node);
  if (text !== undefined) {
    return text === 'node:test' || text === 'node:assert/strict' ? text : undefined;
  }
  const prefix = modulePrefix(node);
  return prefix !== undefined &&
    prefix.length > 0 &&
    ('node:test'.startsWith(prefix) || 'node:assert/strict'.startsWith(prefix))
    ? 'unsupported'
    : undefined;
};

export const isRequireAccess = (input: ModuleExpression): boolean => {
  const node = moduleExpression(input);
  return (
    (node.type === 'Identifier' && node.name === 'require') ||
    (node.type === 'MemberExpression' &&
      ((!node.computed && node.property.type === 'Identifier' && node.property.name === 'require') ||
        (node.computed && moduleText(node.property) === 'require')))
  );
};

/** Runner imports are syntax, not occurrences in comments, fixture strings, or generated source text. */
export const importsNativeScriptTestRunner = (filename: string, source: string): boolean => {
  const parsed = parseSync(filename, source, { sourceType: 'module' });
  if (parsed.errors.length > 0) {
    return refuse(`Native test census cannot parse ${filename}`);
  }
  let native = false;
  const check = (node: Node) => {
    const access = nativeModuleAccess(node);
    if (access === 'unsupported') {
      refuse(`Native test census cannot prove a dynamic native module access in ${filename}`);
    }
    native ||= access === 'node:test';
  };
  new Visitor({
    CallExpression(node) {
      const [argument] = node.arguments;
      if (isRequireAccess(node.callee) && argument !== undefined) {
        check(argument);
      }
    },
    ExportAllDeclaration(node) {
      check(node.source);
    },
    ExportNamedDeclaration(node) {
      if (node.source !== null) {
        check(node.source);
      }
    },
    ImportDeclaration(node) {
      check(node.source);
    },
    ImportExpression(node) {
      check(node.source);
    },
  }).visit(parsed.program);
  return native;
};

const addConfigurationDeclaration = (statement: Node, constants: Map<string, Node>): boolean => {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
  if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
    refuse('Rstest metadata must be immutable const declarations');
  }
  let exported = false;
  for (const item of declaration.declarations) {
    if (item.id.type !== 'Identifier' || item.init === null || constants.has(item.id.name)) {
      refuse('Rstest metadata has a dynamic or duplicate binding');
    }
    constants.set(item.id.name, item.init);
    if (item.id.name === registrationName && statement.type === 'ExportNamedDeclaration') {
      exported = true;
    }
  }
  return exported;
};

const nativeConfigurationFactory = (statement: Extract<Node, { type: 'ImportDeclaration' }>): string => {
  if (
    statement.source.value !== '@rstest/core' ||
    statement.importKind === 'type' ||
    statement.specifiers.length !== 1
  ) {
    return refuse('Rstest configuration imports unsupported executable metadata');
  }
  const [specifier] = statement.specifiers;
  if (
    specifier?.type !== 'ImportSpecifier' ||
    specifier.imported.type !== 'Identifier' ||
    specifier.imported.name !== 'defineConfig' ||
    specifier.importKind === 'type'
  ) {
    return refuse('Rstest configuration must use the native defineConfig import');
  }
  return specifier.local.name;
};

const configurationBindings = (program: Program) => {
  const constants = new Map<string, Node>();
  let configuration: Node | undefined;
  let factory: string | undefined;
  let exportedRegistration = false;
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (factory !== undefined) {
        refuse('Duplicate configuration factory import');
      }
      factory = nativeConfigurationFactory(statement);
    } else if (statement.type === 'ExportDefaultDeclaration') {
      if (configuration !== undefined) {
        refuse('Duplicate Rstest default configuration');
      }
      configuration = statement.declaration;
    } else {
      exportedRegistration = addConfigurationDeclaration(statement, constants) || exportedRegistration;
    }
  }
  if (!exportedRegistration || factory === undefined || constants.has(factory)) {
    refuse('Missing or shadowed native Rstest configuration metadata');
  }
  return { configuration, constants, factory };
};

const isLiteralNegation = (mapper: Extract<Node, { type: 'ArrowFunctionExpression' }>): boolean => {
  const [parameter] = mapper.params;
  const { body } = mapper;
  return (
    !mapper.async &&
    parameter?.type === 'Identifier' &&
    body.type === 'TemplateLiteral' &&
    body.expressions.length === 1 &&
    body.expressions[0]?.type === 'Identifier' &&
    body.expressions[0].name === parameter.name &&
    body.quasis[0]?.value.cooked === '!' &&
    body.quasis[1]?.value.cooked === ''
  );
};

const negationSource = (node: Node): Node => {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'map' &&
    node.arguments.length === 1
  ) {
    const [mapper] = node.arguments;
    if (mapper?.type !== 'ArrowFunctionExpression' || mapper.params.length !== 1) {
      return refuse('Unsupported Rstest pattern mapping');
    }
    if (!isLiteralNegation(mapper)) {
      return refuse('Only literal negation of registered patterns is supported');
    }
    return node.callee.object;
  }
  return refuse('Unsupported executable Rstest pattern');
};

/** Only literal metadata and const references are evaluated. The configuration is never imported or executed. */
const readTestConfiguration = (source: string) => {
  const parsed = parseSync(configurationFile, source, { sourceType: 'module' });
  if (parsed.errors.length > 0) {
    refuse('Rstest configuration does not parse');
  }
  const { configuration, constants, factory } = configurationBindings(parsed.program);
  const resolve = (input: Node, seen: readonly string[] = []): Node => {
    const node = expressionOf(input);
    if (node.type !== 'Identifier') {
      return node;
    }
    if (seen.includes(node.name)) {
      return refuse('Cyclic Rstest metadata');
    }
    const value = constants.get(node.name);
    return value === undefined
      ? refuse(`Unresolved Rstest metadata: ${node.name}`)
      : resolve(value, [...seen, node.name]);
  };
  const fields = (input: Node): ReadonlyMap<string, Node> => {
    const node = resolve(input);
    if (node.type !== 'ObjectExpression') {
      return refuse('Expected literal Rstest object');
    }
    const result = new Map<string, Node>();
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        for (const [key, value] of fields(property.argument)) {
          if (result.has(key)) {
            refuse(`Shadowed Rstest field: ${key}`);
          }
          result.set(key, value);
        }
        continue;
      }
      if (property.computed || property.method || property.kind !== 'init') {
        refuse('Dynamic Rstest object field');
      }
      let key: string | undefined;
      if (property.key.type === 'Identifier') {
        key = property.key.name;
      } else if (property.key.type === 'Literal' && Predicate.isString(property.key.value)) {
        key = property.key.value;
      }
      if (key === undefined || result.has(key)) {
        refuse('Duplicate or nonliteral Rstest object field');
      }
      result.set(key, property.value);
    }
    return result;
  };
  const strings = (input: Node): readonly string[] => {
    const node = resolve(input);
    if (node.type === 'ArrayExpression') {
      return node.elements.flatMap((element) => {
        if (element === null) {
          return refuse('Sparse Rstest metadata');
        }
        if (element.type === 'SpreadElement') {
          return strings(element.argument);
        }
        const value = resolve(element);
        return value.type === 'Literal' && Predicate.isString(value.value)
          ? [value.value]
          : refuse('Rstest patterns must be literal strings');
      });
    }
    return strings(negationSource(node)).map((file) => `!${file}`);
  };
  // Reject hidden mutations, getters and eager calls, even when they are in an otherwise unused binding.
  new Visitor({
    AssignmentExpression() {
      refuse(mutationError);
    },
    CallExpression(node) {
      if (node === configuration && node.callee.type === 'Identifier' && node.callee.name === factory) {
        return;
      }
      strings(node);
    },
    NewExpression() {
      refuse('Executable Rstest metadata');
    },
    TaggedTemplateExpression() {
      refuse('Executable Rstest metadata');
    },
    UnaryExpression(node) {
      if (node.operator === 'delete') {
        refuse(mutationError);
      }
    },
    UpdateExpression() {
      refuse(mutationError);
    },
  }).visit(parsed.program);
  if (
    configuration?.type !== 'CallExpression' ||
    configuration.callee.type !== 'Identifier' ||
    configuration.callee.name !== factory ||
    configuration.arguments.length !== 1
  ) {
    return refuse('Rstest default must be the native defineConfig call');
  }
  const [argument] = configuration.arguments;
  if (argument === undefined) {
    return refuse('Missing Rstest configuration');
  }
  const root = fields(argument);
  if (root.size !== 1) {
    refuse('Unsupported inherited or global Rstest configuration');
  }
  const projectsNode = root.get('projects');
  if (projectsNode === undefined || resolve(projectsNode).type !== 'ArrayExpression') {
    return refuse('Missing literal Rstest projects');
  }
  const projects = resolve(projectsNode);
  if (projects.type !== 'ArrayExpression') {
    return refuse('Missing Rstest projects');
  }
  const patterns = projects.elements.map((project) => {
    if (project === null || project.type === 'SpreadElement') {
      return refuse('Dynamic Rstest project');
    }
    const properties = fields(project);
    for (const key of properties.keys()) {
      if (!['name', 'include', 'exclude', 'testEnvironment', 'testTimeout', 'tools', 'setupFiles'].includes(key)) {
        refuse(`Unsupported Rstest project field: ${key}`);
      }
    }
    const name = properties.get('name');
    const identity = name === undefined ? undefined : resolve(name);
    if (identity?.type !== 'Literal' || !Predicate.isString(identity.value)) {
      return refuse('Rstest project requires a literal name');
    }
    const include = properties.get('include');
    const exclude = properties.get('exclude');
    if (include === undefined) {
      return refuse('Rstest project has an implicit include');
    }
    return { exclude: exclude === undefined ? [] : strings(exclude), include: strings(include) };
  });
  const native = constants.get(registrationName);
  if (native === undefined || expressionOf(native).type !== 'ArrayExpression') {
    return refuse('nativeScriptTests must be a literal array');
  }
  return { files: strings(native), projects: patterns };
};

const RunDefaults = Schema.Struct({
  run: Schema.optional(Schema.Struct({ shell: Schema.optional(Schema.String) })),
});
const WorkflowEnvironment = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));
const WorkflowStep = Schema.Struct({
  'continue-on-error': Schema.optional(Schema.Union([Schema.String, Schema.Boolean])),
  env: Schema.optional(WorkflowEnvironment),
  if: Schema.optional(Schema.Union([Schema.String, Schema.Boolean])),
  run: Schema.optional(Schema.String),
  shell: Schema.optional(Schema.String),
  'working-directory': Schema.optional(Schema.String),
});
const WorkflowJob = Schema.Struct({
  container: Schema.optional(Schema.Unknown),
  'continue-on-error': Schema.optional(Schema.Union([Schema.String, Schema.Boolean])),
  defaults: Schema.optional(RunDefaults),
  env: Schema.optional(WorkflowEnvironment),
  if: Schema.optional(Schema.Union([Schema.String, Schema.Boolean])),
  needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  'runs-on': Schema.optional(Schema.Unknown),
  steps: Schema.optional(Schema.Array(WorkflowStep)),
  strategy: Schema.optional(Schema.Struct({ matrix: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })),
});
const WorkflowSchema = Schema.Struct({
  defaults: Schema.optional(RunDefaults),
  env: WorkflowEnvironment,
  jobs: Schema.Record(Schema.String, WorkflowJob),
});

const checkedFile = (root: string, relative: string): string => {
  if (
    path.isAbsolute(relative) ||
    relative !== path.posix.normalize(relative) ||
    relative.split('/').some((part) => part === '..' || part === '') ||
    relative.includes('\\')
  ) {
    return refuse(`Non-normalized metadata path: ${relative}`);
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      refuse(`Symlinked registration path: ${relative}`);
    }
  }
  if (!lstatSync(current).isFile()) {
    refuse(`Registration is not a file: ${relative}`);
  }
  return current;
};

const literalNodeTests = (commands: readonly string[], registered: readonly string[]): readonly string[] =>
  commands
    .flatMap((commandsOfRow) => {
      const lines = commandsOfRow.trim().split('\n');
      if (
        registered.some((file) => commandsOfRow.includes(file)) &&
        lines.some((line) => !line.trim().startsWith('node --test '))
      ) {
        refuse('Native CI row must contain only unconditional literal Node test invocations');
      }
      return lines;
    })
    .flatMap((line) => {
      if (!/(?:^|\s)--test(?:\s|=|$)/u.test(line)) {
        if (registered.some((file) => line.includes(file))) {
          return refuse('Native test appears outside a literal Node test invocation');
        }
        return [];
      }
      const words = line.trim().split(/\s+/u);
      if (words[0] !== 'node' || words[1] !== '--test') {
        return refuse('Native CI invocation has a conditional, dynamic, or non-Node executor');
      }
      const argumentsOfTest = words.slice(2);
      const files = argumentsOfTest.filter((word) => !/^--test-concurrency=[1-9]\d*$/u.test(word));
      if (files.length === 0 || files.some((file) => !isNativeScriptTest(file))) {
        return refuse('Native CI invocation must contain only literal test paths and no filters or shell operators');
      }
      return files;
    });

const sourceJob = (workflow: typeof WorkflowSchema.Type) => {
  const job = workflow.jobs[sourceJobName];
  if (
    job === undefined ||
    job['continue-on-error'] !== undefined ||
    job.container !== undefined ||
    job['runs-on'] !== 'ubuntu-24.04' ||
    job.strategy?.matrix?.include !== sourceMatrix ||
    !Array.isArray(job.needs) ||
    job.needs.length !== 1 ||
    job.needs[0] !== 'ci-plan' ||
    job.if !==
      workflowExpression(
        "!cancelled() && needs.ci-plan.result == 'success' && fromJSON(needs.ci-plan.outputs.expected)['workspace-gate'] == 'success'",
      )
  ) {
    refuse('Native CI source job does not dispatch the planned source rows');
  }
  return job;
};

const sourceDispatcher = (workflow: typeof WorkflowSchema.Type, job: typeof WorkflowJob.Type) => {
  const dispatch =
    job.steps?.filter(
      (step) => step.env?.COMMANDS === commandEnvironment && step.run?.includes('"$command"') === true,
    ) ?? [];
  const [step] = dispatch;
  if (
    dispatch.length !== 1 ||
    step === undefined ||
    step.if !== undefined ||
    step['continue-on-error'] !== undefined ||
    step['working-directory'] !== 'app' ||
    step.run?.trim() !== nativeCiCommandDispatch
  ) {
    refuse('Native CI command dispatch is conditional, filtered, or unrecognized');
  }
  const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell ?? 'bash';
  if (shell !== 'bash') {
    refuse('Native CI dispatcher requires the executing Bash shell, not a custom or syntax-only shell');
  }
  return step;
};

const jobSourceConsumers = (identity: string, candidate: typeof WorkflowJob.Type, step: typeof WorkflowStep.Type) => {
  const sourceConsumerConditions: (string | boolean | undefined)[] = [];
  if (
    identity !== sourceJobName &&
    JSON.stringify(candidate.strategy?.matrix ?? {}).includes('needs.ci-plan.outputs.source')
  ) {
    refuse('Native source matrix has another workflow consumer');
  }
  if (
    identity === sourceJobName &&
    Object.values(candidate.env ?? {}).some((value) => Predicate.isString(value) && value.includes(matrixCommands))
  ) {
    refuse('Source commands have an unproven job-level consumer');
  }
  for (const consumer of candidate.steps ?? []) {
    if (
      identity === sourceJobName &&
      consumer !== step &&
      [consumer.run ?? '', ...Object.values(consumer.env ?? {})].some(
        (value) => Predicate.isString(value) && value.includes(matrixCommands),
      )
    ) {
      sourceConsumerConditions.push(consumer.if);
    }
  }
  return sourceConsumerConditions;
};

const proveNoJobInvocation = (
  candidate: typeof WorkflowJob.Type,
  step: typeof WorkflowStep.Type,
  registered: readonly string[],
) => {
  const commands = (candidate.steps ?? []).flatMap((candidateStep) =>
    candidateStep === step
      ? []
      : [candidateStep.run ?? '', ...Object.values(candidateStep.env ?? {}).filter(Predicate.isString)],
  );
  commands.push(...Object.values(candidate.env ?? {}).filter(Predicate.isString));
  if (literalNodeTests(commands, registered).some((file) => registered.includes(file))) {
    refuse('Native test has an invocation outside the proven matrix dispatcher');
  }
};

const readNativeWorkflow = (root: string, registered: readonly string[]) => {
  const workflowPath = path.join(root, '../.github/workflows/ultramodern-workspace-gates.yml');
  if (realpathSync(workflowPath) !== workflowPath) {
    refuse('Workflow registration escapes the checkout');
  }
  const decoded = Schema.decodeUnknownResult(WorkflowSchema)(parse(readFileSync(workflowPath, 'utf-8')));
  if (Result.isFailure(decoded)) {
    refuse(`Malformed native CI workflow: ${String(decoded.failure)}`);
  }
  const workflow = decoded.success;
  const step = sourceDispatcher(workflow, sourceJob(workflow));
  // A literal matrix invocation is not an exact-once proof if another job, step, or matrix setup runs it too.
  const sourceConsumerConditions = Object.entries(workflow.jobs).flatMap(([identity, candidate]) => {
    proveNoJobInvocation(candidate, step, registered);
    return jobSourceConsumers(identity, candidate, step);
  });
  if (
    literalNodeTests(Object.values(workflow.env).filter(Predicate.isString), registered).some((file) =>
      registered.includes(file),
    )
  ) {
    refuse('Native test has an unproven workflow-level invocation');
  }
  return { sourceConsumerConditions, workflow };
};

const proveRegisteredFile = (
  file: string,
  root: string,
  projects: ReturnType<typeof readTestConfiguration>['projects'],
  rows: readonly { readonly files: readonly string[]; readonly name: string }[],
  scopes: readonly CiScope[],
) => {
  const scheduled = rows.flatMap(({ files }) => files);
  if (!isNativeScriptTest(file)) {
    refuse(`Native registration is not a script test: ${file}`);
  }
  checkedFile(root, file);
  for (const project of projects) {
    const included = project.include.some((pattern) => !pattern.startsWith('!') && path.matchesGlob(file, pattern));
    const excluded =
      project.exclude.some((pattern) => path.matchesGlob(file, pattern)) ||
      project.include.some((pattern) => pattern.startsWith('!') && path.matchesGlob(file, pattern.slice(1)));
    if (included && !excluded) {
      refuse(`Native test is also collected by Rstest: ${file}`);
    }
  }
  if (!projects.some((project) => project.include.includes(`!${file}`))) {
    refuse(`Native test has no explicit Rstest exclusion: ${file}`);
  }
  if (scheduled.filter((scheduledFile) => scheduledFile === file).length !== 1) {
    refuse(`Native test must have exactly one literal CI invocation: ${file}`);
  }
  for (const scope of scopes) {
    if (rows.filter((row) => scope.source.includes(row.name) && row.files.includes(file)).length !== 1) {
      refuse(`Native test is not registered exactly once in scope ${scope.name}: ${file}`);
    }
  }
};

/** Reads the canonical registration, effective Rstest patterns and workflow-selected CI matrices without executing config. */
export const validateNativeScriptRegistration = (appRoot: string): NativeScriptRegistration => {
  try {
    const root = realpathSync(appRoot);
    const read = (file: string) => readFileSync(checkedFile(root, file), 'utf-8');
    const configuration = readTestConfiguration(read(configurationFile));
    if (configuration.files.length === 0 || new Set(configuration.files).size !== configuration.files.length) {
      refuse('Native test registration must be nonempty and unique');
    }
    const { sourceConsumerConditions, workflow } = readNativeWorkflow(root, configuration.files);
    const overlay = workflow.env.CI_MATRICES_OVERLAY;
    if (!Predicate.isString(overlay)) {
      refuse('Native CI workflow requires a literal matrices overlay');
    }
    const matrices = parseCiMatrices(read('scripts/ci-matrices.json'), read(overlay));
    if (Result.isFailure(matrices)) {
      refuse('Native CI matrices are invalid');
    }
    const rows = matrices.success.source.map(({ commands, name }) => ({
      files: literalNodeTests([commands], configuration.files),
      name,
    }));
    for (const condition of sourceConsumerConditions) {
      // Other consumers must be provably disjoint from the native rows, not merely promise not to execute them.
      const prefix = Predicate.isString(condition)
        ? /^startsWith\(matrix\.name, '(?<prefix>[^']*)'\)$/u.exec(condition)?.groups?.prefix
        : undefined;
      if (
        prefix === undefined ||
        rows.some((row) => row.files.some((file) => configuration.files.includes(file)) && row.name.startsWith(prefix))
      ) {
        refuse('Native source commands have another possible workflow execution path');
      }
    }
    const unitTests = literalNodeTests(
      matrices.success.unit.map(({ commands }) => commands),
      configuration.files,
    );
    if (unitTests.some((file) => configuration.files.includes(file))) {
      refuse('Native source tests also have a unit-job invocation');
    }
    const setupTests = literalNodeTests(
      [...matrices.success.source, ...matrices.success.unit].map((row) => row.setup ?? ''),
      configuration.files,
    );
    if (setupTests.some((file) => configuration.files.includes(file))) {
      refuse('Native source tests also have a matrix-setup invocation');
    }
    for (const file of configuration.files) {
      proveRegisteredFile(file, root, configuration.projects, rows, matrices.success.scopes);
    }
    return Object.freeze({
      errors: Object.freeze([] satisfies []),
      files: Object.freeze([...configuration.files]),
      kind: 'valid',
      root,
    });
  } catch (error) {
    return Object.freeze({
      errors: Object.freeze([Predicate.isError(error) ? error.message : 'Unreadable native test registration']),
      files: Object.freeze([] satisfies []),
      kind: 'invalid',
      root: appRoot,
    });
  }
};

/** The proof is checkout-bound; a matching relative filename in a foreign or symlinked tree grants nothing. */
export const allowsNativeScriptImport = (
  registration: NativeScriptRegistration,
  filename: string,
  specifier: string,
): boolean => {
  if (specifier !== 'node:test' && specifier !== 'node:assert/strict') {
    return false;
  }
  if (registration.kind !== 'valid' || !path.isAbsolute(filename)) {
    return false;
  }
  const relative = path.relative(registration.root, filename).split(path.sep).join('/');
  if (!registration.files.includes(relative)) {
    return false;
  }
  try {
    return checkedFile(registration.root, relative) === filename && realpathSync(filename) === filename;
  } catch {
    return false;
  }
};
