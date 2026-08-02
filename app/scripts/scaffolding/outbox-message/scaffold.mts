import { readFile } from 'node:fs/promises';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  ACTION_GENERATOR_HEADER,
  OUTBOX_SLOT_END,
  OUTBOX_SLOT_START,
  createMutation,
  discoverVertical,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  isMissingFileError,
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
  VerticalMetadata,
} from '../shared.mts';

const renderOutboxMessage = (vertical: VerticalMetadata, action: string, topic: string): string => {
  const actionType = toPascalCase(action);
  const topicType = toPascalCase(topicToSlug(topic));
  const base = `${actionType}${topicType}Outbox`;
  return `import { Schema } from 'effect';
import type { OutboxMessage } from '@app/core-runtime';

export const ${base}Payload = Schema.Struct({
  data: Schema.Json,
});
export type ${base}Payload = Schema.Schema.Type<
  typeof ${base}Payload
>;

export const ${base}Topic = '${topic}' as const;
export const ${base}ProducerModuleKey = '${vertical.appId}' as const;

export const create${base}Message = (
  payload: ${base}Payload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: ${base}ProducerModuleKey,
  topic: ${base}Topic,
});
`;
};

export const planOutboxScaffold = async (
  workspaceRoot: string,
  config: OutboxScaffoldConfig,
): Promise<ScaffoldPlan<OutboxScaffoldResult>> => {
  const action = requireCanonicalSlug(config.action, 'action');
  const topic = requireTopic(config.topic);
  const vertical = await discoverVertical(workspaceRoot, config.vertical);
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
    !actionContent.includes(`// @ontos-action-owner ${vertical.appId}\n`) ||
    !actionContent.includes(`// @ontos-action-slug ${action}\n`)
  ) {
    throw new Error('Outbox Message can extend only the matching generated Action');
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
  const mutations = [messageMutation, actionMutation];
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { messagePath } };
};

export default createCodesmithGenerator(planOutboxScaffold);
