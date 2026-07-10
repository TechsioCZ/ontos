const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const readText = (workspaceRoot, relativePath) =>
  fs.readFile(path.join(workspaceRoot, relativePath), 'utf-8');

const pathExists = async (absolutePath) => {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

const writeText = async (workspaceRoot, relativePath, content) => {
  assertWritableSourcePath(relativePath);
  await fs.writeFile(path.join(workspaceRoot, relativePath), content, 'utf-8');
};

const formatFiles = (workspaceRoot, relativePaths) => {
  const oxfmtBin = path.join(
    workspaceRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'oxfmt.cmd' : 'oxfmt',
  );
  const result = spawnSync(oxfmtBin, relativePaths, {
    cwd: workspaceRoot,
    encoding: 'utf-8',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'oxfmt failed for outbox message files.');
  }
};

const assertWritableSourcePath = (relativePath) => {
  const normalised = relativePath.split(path.sep).join('/');
  if (
    normalised.includes('/node_modules/') ||
    normalised.startsWith('node_modules/') ||
    normalised.includes('/dist/') ||
    normalised.includes('/@mf-types/')
  ) {
    throw new Error(`Refusing to write generated/dependency path: ${relativePath}`);
  }
};

const normaliseKebab = (value, label) => {
  const kebab = value
    .trim()
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>-$<upper>')
    .replaceAll(/[^a-zA-Z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .toLowerCase();

  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(kebab)) {
    throw new Error(`${label} must resolve to a non-empty kebab-case slug.`);
  }

  return kebab;
};

const toWords = (value) => normaliseKebab(value, 'value').split('-');

const toPascalCase = (value) =>
  toWords(value)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join('');

const toCamelCase = (value) => {
  const pascal = toPascalCase(value);
  return `${pascal[0].toLowerCase()}${pascal.slice(1)}`;
};

const assertTopic = (value) => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-zA-Z0-9]+)*$/u.test(value)) {
    throw new Error('topic must be a dotted or dashed non-empty string.');
  }
};

const assertActionExists = async (workspaceRoot, actionPath) => {
  if (!(await pathExists(path.join(workspaceRoot, actionPath)))) {
    throw new Error(`Action does not exist: ${actionPath}`);
  }
};

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const assertTopicIsUniqueForAction = ({ actionPath, source, topic }) => {
  const topicPattern = new RegExp(`topic:\\s*(['"\`])${escapeRegExp(topic)}\\1`, 'u');
  if (topicPattern.test(source)) {
    throw new Error(`Outbox topic "${topic}" is already configured for ${actionPath}.`);
  }
};

const addServicesParameter = (source) => {
  if (/>\s*=\s*\(\s*input\s*,\s*services\s*\)\s*=>\s*\{/u.test(source)) {
    return source;
  }

  const withServicesParameter = source.replace(
    />\s*=\s*\(\s*input\s*\)\s*=>\s*\{/u,
    '> = (input, services) => {',
  );
  if (withServicesParameter === source) {
    throw new Error('Could not add services parameter to action handler.');
  }

  return withServicesParameter;
};

const outboxBlock = ({ actionCamel, topic }) => `  services.context.addOutboxMessage?.({
    payload: {
      actionInvocationId: services.context.actionInvocation?.actionInvocationId,
      actionKey: ${actionCamel}ActionKey,
      targetResourceId,
    },
    topic: '${topic}',
  });

`;

const addOutboxMessage = ({ actionCamel, source, topic }) => {
  const withServicesParameter = addServicesParameter(source);
  const withOutboxMessage = withServicesParameter.replace(
    /\n {2}return \{\n {4}accepted: true,/u,
    `\n${outboxBlock({ actionCamel, topic })}  return {\n    accepted: true,`,
  );
  if (withOutboxMessage === withServicesParameter) {
    throw new Error('Could not insert outbox message before action success response.');
  }

  return withOutboxMessage;
};

module.exports = async function outboxMessageGenerator(context, generator) {
  const workspaceRoot = context.materials.default.basePath;
  const { config } = context;
  const verticalSlug = normaliseKebab(String(config.vertical ?? ''), 'vertical');
  const actionSlug = normaliseKebab(String(config.action ?? ''), 'action');
  const topic = typeof config.topic === 'string' ? config.topic.trim() : '';
  if (topic.length === 0) {
    throw new Error('Outbox message topic is required.');
  }

  assertTopic(topic);

  const actionCamel = toCamelCase(actionSlug);
  const actionFile = actionSlug;
  const actionPath = `verticals/${verticalSlug}/src/actions/${actionFile}.ts`;
  await assertActionExists(workspaceRoot, actionPath);
  const source = await readText(workspaceRoot, actionPath);
  assertTopicIsUniqueForAction({
    actionPath,
    source,
    topic,
  });

  const nextSource = addOutboxMessage({
    actionCamel,
    source,
    topic,
  });

  if (nextSource !== source) {
    await writeText(workspaceRoot, actionPath, nextSource);
    formatFiles(workspaceRoot, [actionPath]);
  }

  generator.logger.info(`Configured outbox message ${topic} for ${verticalSlug}/${actionSlug}.`);
};
