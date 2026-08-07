import { readFile } from 'node:fs/promises';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  ACTION_GENERATOR_HEADER,
  OUTBOX_CONTRACT_GENERATOR_HEADER,
  OUTBOX_SLOT_END,
  OUTBOX_SLOT_START,
  asJsonObject,
  createMutation,
  discoverOntosModule,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  isMissingFileError,
  patchJsonObjectProperty,
  requireCanonicalSlug,
  requireTopic,
  resolveContainedPath,
  toPascalCase,
  topicToSlug,
  updateMutation,
} from '../shared.mts';
import type {
  OutboxScaffoldConfig,
  OutboxScaffoldResult,
  ScaffoldPlan,
  OntosVerticalMetadata,
} from '../shared.mts';

const renderOutboxMessage = (
  vertical: OntosVerticalMetadata,
  action: string,
  topic: string,
): string => {
  const actionType = toPascalCase(action);
  const topicType = toPascalCase(topicToSlug(topic));
  const base = `${actionType}${topicType}Outbox`;
  const contractSubpath = `@app/${vertical.slug}/outbox/${topicToSlug(topic)}`;
  return `import type { OutboxMessage } from '@app/core-runtime';
import { OutboxPayloadSchema, outboxProducerModuleKey, outboxTopic } from '${contractSubpath}';
import type { OutboxPayload } from '${contractSubpath}';

export const ${base}Payload = OutboxPayloadSchema;
export type ${base}Payload = OutboxPayload;
export const ${base}ProducerModuleKey = outboxProducerModuleKey;
export const ${base}Topic = outboxTopic;

export const create${base}Message = (
  payload: ${base}Payload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: ${base}ProducerModuleKey,
  topic: ${base}Topic,
});
`;
};

const renderOutboxContract = (vertical: OntosVerticalMetadata, topic: string): string =>
  `${OUTBOX_CONTRACT_GENERATOR_HEADER}
// @ontos-outbox-producer ${vertical.moduleId}
// @ontos-outbox-topic ${topic}
import { Schema } from 'effect';

export const OutboxPayloadSchema = Schema.Struct({
  data: Schema.Json,
});
export type OutboxPayload = Schema.Schema.Type<typeof OutboxPayloadSchema>;

export const outboxTopic = '${topic}' as const;
export const outboxProducerModuleKey = '${vertical.moduleId}' as const;
`;

export const planOutboxScaffold = async (
  workspaceRoot: string,
  config: OutboxScaffoldConfig,
): Promise<ScaffoldPlan<OutboxScaffoldResult>> => {
  const action = requireCanonicalSlug(config.action, 'action');
  const topic = requireTopic(config.topic);
  const vertical = await discoverOntosModule(workspaceRoot, config.vertical);
  const actionPath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'actions',
    `${action}.action.ts`,
  );
  let actionContent: string;
  try {
    actionContent = await readFile(actionPath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Outbox Message requires the generated Action at ${actionPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (
    !actionContent.startsWith(`${ACTION_GENERATOR_HEADER}\n`) ||
    !actionContent.includes(`// @ontos-action-owner ${vertical.moduleId}\n`) ||
    !actionContent.includes(`// @ontos-action-slug ${action}\n`) ||
    !actionContent.includes(`entrypoint: defineTenantModuleEntrypoint({\n`) ||
    !actionContent.includes(`      access: 'write',\n`) ||
    !actionContent.includes(`      entrypointKey: '${vertical.moduleId}.${action}',\n`) ||
    !actionContent.includes(`      moduleKey: '${vertical.moduleId}',\n`) ||
    !actionContent.includes(`      role: 'action',\n`)
  ) {
    throw new Error(
      'Outbox Message can extend only the matching generated Action with its governed write entrypoint',
    );
  }
  const topicSlug = topicToSlug(topic);
  const base = `${toPascalCase(action)}${toPascalCase(topicSlug)}Outbox`;
  if (
    new RegExp(
      `\\b(?:${base}(?:Payload|ProducerModuleKey|Topic)|create${base}Message)\\b`,
      'u',
    ).test(actionContent)
  ) {
    throw new Error(`Outbox identifier ${base} already exists`);
  }
  const messagePath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'actions',
    `${action}.${topicSlug}.outbox-message.ts`,
  );
  const contractPath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'shared',
    'outbox',
    `${topicSlug}.ts`,
  );
  const contractMutation = await createMutation(
    contractPath,
    renderOutboxContract(vertical, topic),
  );
  const messageMutation = await createMutation(
    messagePath,
    renderOutboxMessage(vertical, action, topic),
  );
  const exportSource = `./${action}.${topicSlug}.outbox-message.ts`;
  const exportEntries = [
    `export { ${base}Payload } from '${exportSource}';`,
    `export { ${base}ProducerModuleKey } from '${exportSource}';`,
    `export { ${base}Topic } from '${exportSource}';`,
    `export { create${base}Message } from '${exportSource}';`,
  ];
  const patchedAction = insertSortedSlot(
    actionContent,
    OUTBOX_SLOT_START,
    OUTBOX_SLOT_END,
    exportEntries,
    (candidate) =>
      /^export \{ [A-Za-z0-9]+ \} from '\.\/[a-z0-9.-]+\.outbox-message\.ts';$/u.test(candidate),
  );
  const actionMutation = updateMutation(actionPath, actionContent, patchedAction);
  if (actionMutation === undefined) {
    throw new Error('Outbox Message Action export patch unexpectedly made no change');
  }
  const exportsValue = asJsonObject(
    vertical.packageJson['exports'],
    `vertical ${vertical.slug} package exports`,
  );
  const contractExport = `./outbox/${topicSlug}`;
  if (exportsValue[contractExport] !== undefined) {
    throw new Error(`Outbox contract export ${contractExport} already exists`);
  }
  const patchedExports = Object.fromEntries(
    Object.entries({
      ...exportsValue,
      [contractExport]: `./shared/outbox/${topicSlug}.ts`,
    }).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const packageMutation = updateMutation(
    vertical.packagePath,
    vertical.packageContent,
    patchJsonObjectProperty(vertical.packageContent, [], 'exports', patchedExports),
  );
  if (packageMutation === undefined) {
    throw new Error('Outbox Message package export patch unexpectedly made no change');
  }
  const mutations = [contractMutation, messageMutation, actionMutation, packageMutation];
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { contractPath, messagePath } };
};

export default createCodesmithGenerator(planOutboxScaffold);
