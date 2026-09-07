import { Cause, Effect, FileSystem, Result, Schema } from 'effect';
import type { PlatformError } from 'effect';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  ACTION_GENERATOR_HEADER,
  OUTBOX_CONTRACT_GENERATOR_HEADER,
  OUTBOX_SLOT_END,
  OUTBOX_SLOT_START,
  ScaffoldFailure,
  createMutationEffect,
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  patchJsonObjectProperty,
  requireCanonicalSlug,
  requireTopic,
  resolveContainedPath,
  toPascalCase,
  topicToSlug,
  updateMutation,
} from '../shared.mts';
import type {
  OntosVerticalMetadata,
  OutboxScaffoldConfig,
  OutboxScaffoldResult,
  ScaffoldPlan,
} from '../shared.mts';

export class OutboxMessageScaffoldError extends Schema.TaggedError<OutboxMessageScaffoldError>()(
  'OutboxMessageScaffoldError',
  { cause: Schema.optional(Schema.Unknown), reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const planningFailure = (reason: string, cause?: unknown): OutboxMessageScaffoldError =>
  cause === undefined
    ? new OutboxMessageScaffoldError({ reason })
    : new OutboxMessageScaffoldError({ cause, reason });

const failureFromCause = (cause: unknown): OutboxMessageScaffoldError =>
  planningFailure(cause instanceof Error ? cause.message : String(cause), cause);

const fromLegacySync = <Value,>(
  operation: () => Value,
): Effect.Effect<Value, OutboxMessageScaffoldError> =>
  Effect.try({ catch: failureFromCause, try: operation });

const PackageExportsSchema = Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.Json),
});

const isNotFoundPlatformError = Schema.is(
  Schema.Struct({
    _tag: Schema.Literal('PlatformError'),
    reason: Schema.Struct({ _tag: Schema.Literal('NotFound') }),
  }),
);

const isScaffoldFailure = Schema.is(ScaffoldFailure);

const rethrowDiscoveryCause = (cause: Cause.Cause<ScaffoldFailure>) =>
  Effect.failCause(cause).pipe(Effect.mapError(failureFromCause));

const recoverDiscoveryCause = (cause: Cause.Cause<ScaffoldFailure>) => {
  const hasUnexpectedDefect = cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && !isScaffoldFailure(reason.defect),
  );
  if (Cause.hasInterrupts(cause) || hasUnexpectedDefect) {
    return rethrowDiscoveryCause(cause);
  }
  const failure = Cause.findError(cause);
  if (Result.isSuccess(failure)) {
    return Effect.fail(failureFromCause(failure.success));
  }
  const defect = Cause.findDefect(cause);
  return Result.isSuccess(defect) && isScaffoldFailure(defect.success)
    ? Effect.fail(failureFromCause(defect.success))
    : rethrowDiscoveryCause(cause);
};

const FORMATTED_ACTION_GENERATOR_PREFIX =
  "import { defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';\n";

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

export const ${base}PayloadSchema = OutboxPayloadSchema;
export type ${base}Payload = OutboxPayload;
export const ${base}ProducerModuleKey = outboxProducerModuleKey;
export const ${base}Topic = outboxTopic;

export const create${base}Message = (
  payload: OutboxPayload,
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

export const planOutboxScaffold = (
  workspaceRoot: string,
  config: OutboxScaffoldConfig,
): Effect.Effect<
  ScaffoldPlan<OutboxScaffoldResult>,
  OutboxMessageScaffoldError | PlatformError.PlatformError | ScaffoldFailure,
  FileSystem.FileSystem
> =>
  Effect.gen(function* planOutboxScaffoldEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const action = yield* fromLegacySync(() => requireCanonicalSlug(config.action, 'action'));
    const topic = yield* fromLegacySync(() => requireTopic(config.topic));
    const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical).pipe(
      Effect.catchCause(recoverDiscoveryCause),
    );
    const actionPath = yield* fromLegacySync(() =>
      resolveContainedPath(
        workspaceRoot,
        'verticals',
        vertical.slug,
        'src',
        'actions',
        `${action}.action.ts`,
      ),
    );
    const actionContent = yield* fileSystem
      .readFileString(actionPath)
      .pipe(
        Effect.catchIf(isNotFoundPlatformError, (cause) =>
          Effect.fail(
            planningFailure(`Outbox Message requires the generated Action at ${actionPath}`, cause),
          ),
        ),
      );
    const hasGeneratedActionPrefix =
      actionContent.startsWith(`${ACTION_GENERATOR_HEADER}\n`) ||
      actionContent.startsWith(`${FORMATTED_ACTION_GENERATOR_PREFIX}${ACTION_GENERATOR_HEADER}\n`);
    if (
      !hasGeneratedActionPrefix ||
      !actionContent.includes(`// @ontos-action-owner ${vertical.moduleId}\n`) ||
      !actionContent.includes(`// @ontos-action-slug ${action}\n`) ||
      !actionContent.includes(`entrypoint: defineTenantModuleEntrypoint({\n`) ||
      !actionContent.includes(`      access: 'write',\n`) ||
      !actionContent.includes(`      entrypointKey: '${vertical.moduleId}.${action}',\n`) ||
      !actionContent.includes(`      moduleKey: '${vertical.moduleId}',\n`) ||
      !actionContent.includes(`      role: 'action',\n`)
    ) {
      return yield* Effect.fail(
        planningFailure(
          'Outbox Message can extend only the matching generated Action with its governed write entrypoint',
        ),
      );
    }
    const topicSlug = topicToSlug(topic);
    const base = `${toPascalCase(action)}${toPascalCase(topicSlug)}Outbox`;
    if (
      new RegExp(
        `\\b(?:${base}(?:Payload|PayloadSchema|ProducerModuleKey|Topic)|create${base}Message)\\b`,
        'u',
      ).test(actionContent)
    ) {
      return yield* Effect.fail(planningFailure(`Outbox identifier ${base} already exists`));
    }
    const messagePath = yield* fromLegacySync(() =>
      resolveContainedPath(
        workspaceRoot,
        'verticals',
        vertical.slug,
        'src',
        'actions',
        `${action}.${topicSlug}.outbox-message.ts`,
      ),
    );
    const contractPath = yield* fromLegacySync(() =>
      resolveContainedPath(
        workspaceRoot,
        'verticals',
        vertical.slug,
        'shared',
        'outbox',
        `${topicSlug}.ts`,
      ),
    );
    const contractMutation = yield* createMutationEffect(
      contractPath,
      renderOutboxContract(vertical, topic),
    );
    const messageMutation = yield* createMutationEffect(
      messagePath,
      renderOutboxMessage(vertical, action, topic),
    );
    const exportSource = `./${action}.${topicSlug}.outbox-message.ts`;
    const exportEntries = [
      `export { ${base}PayloadSchema } from '${exportSource}';`,
      `export { ${base}ProducerModuleKey } from '${exportSource}';`,
      `export { ${base}Topic } from '${exportSource}';`,
      `export { create${base}Message } from '${exportSource}';`,
      `export type { ${base}Payload } from '${exportSource}';`,
    ];
    const patchedAction = yield* fromLegacySync(() =>
      insertSortedSlot(
        actionContent,
        OUTBOX_SLOT_START,
        OUTBOX_SLOT_END,
        exportEntries,
        (candidate) =>
          /^export (?:type )?\{ [A-Za-z0-9]+ \} from '\.\/[a-z0-9.-]+\.outbox-message\.ts';$/u.test(
            candidate,
          ),
      ),
    );
    const actionMutation = updateMutation(actionPath, actionContent, patchedAction);
    if (actionMutation === undefined) {
      return yield* Effect.fail(
        planningFailure('Outbox Message Action export patch unexpectedly made no change'),
      );
    }
    const packageDocument = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PackageExportsSchema),
      { onExcessProperty: 'preserve' },
    )(vertical.packageContent).pipe(
      Effect.mapError((cause) =>
        planningFailure(`vertical ${vertical.slug} package exports must be a JSON object`, cause),
      ),
    );
    const exportsValue = packageDocument.exports;
    const contractExport = `./outbox/${topicSlug}`;
    if (exportsValue[contractExport] !== undefined) {
      return yield* Effect.fail(
        planningFailure(`Outbox contract export ${contractExport} already exists`),
      );
    }
    const patchedExports = Object.fromEntries(
      Object.entries({
        ...exportsValue,
        [contractExport]: `./shared/outbox/${topicSlug}.ts`,
      }).toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const packageMutation = yield* fromLegacySync(() =>
      updateMutation(
        vertical.packagePath,
        vertical.packageContent,
        patchJsonObjectProperty(vertical.packageContent, [], 'exports', patchedExports),
      ),
    );
    if (packageMutation === undefined) {
      return yield* Effect.fail(
        planningFailure('Outbox Message package export patch unexpectedly made no change'),
      );
    }
    const mutations = [contractMutation, messageMutation, actionMutation, packageMutation];
    yield* fromLegacySync(() => ensureUniqueMutationPaths(mutations));
    return { mutations, result: { contractPath, messagePath } };
  });

export default createCodesmithGenerator(planOutboxScaffold);
