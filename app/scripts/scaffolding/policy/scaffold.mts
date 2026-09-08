import { Effect, FileSystem, Match, Schema, Predicate } from 'effect';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  CORE_POLICY_SLOT_END,
  CORE_POLICY_SLOT_START,
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
  toTitle,
  updateMutation,
  withCoreDependency,
} from '../shared.mts';
import type {
  Mutation,
  PolicyScaffoldConfig,
  PolicyScaffoldResult,
  ScaffoldPlan,
} from '../shared.mts';

class PolicyScaffoldError extends Schema.TaggedError<PolicyScaffoldError>()('PolicyScaffoldError', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const planningFailure = (cause: unknown): PolicyScaffoldError =>
  new PolicyScaffoldError({ reason: Predicate.isError(cause) ? cause.message : String(cause) });

const fromLegacySync = <Value,>(
  operation: () => Value,
): Effect.Effect<Value, PolicyScaffoldError> =>
  Effect.try({ catch: planningFailure, try: operation });

const createPolicyMutation = (
  filePath: string,
  content: string,
): Effect.Effect<Mutation, PolicyScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* createPolicyMutationEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.mapError(planningFailure));
    if (exists) {
      return yield* Effect.fail(
        new PolicyScaffoldError({
          reason: `refusing to overwrite existing business file: ${filePath}`,
        }),
      );
    }
    return { content, kind: 'create', path: filePath };
  });

const renderPolicy = (
  policy: string,
  scope: 'global' | 'microvertical',
  owner?: string,
): string => {
  const valueName = `${toCamelCase(policy)}Policy`;
  const definition = scope === 'global' ? 'defineGlobalPolicy' : 'defineMicroverticalPolicy';
  const policyKey = scope === 'global' ? `global.${policy}.v1` : `${owner}.${policy}.v1`;
  const ownerLine = scope === 'global' ? '' : `  owningModuleKey: '${owner}',\n`;
  const policyImport = scope === 'global' ? '../actions/policy.ts' : '@app/core-runtime';
  return `import { Effect } from 'effect';
import { ${definition}, denyPolicy } from '${policyImport}';

export const ${valueName} = ${definition}<unknown${scope === 'global' ? '' : `, '${owner}'`}>({
  evaluate: () =>
    Effect.fail(
      denyPolicy('policy_not_implemented', 'The ${toTitle(policy)} Policy is not implemented'),
    ),
${ownerLine}  policyKey: '${policyKey}',
});
`;
};

const planPolicyScaffold = Effect.fn('PolicyScaffold.planPolicyScaffold')(
  function* planPolicyScaffoldEffect(
    workspaceRoot: string,
    config: PolicyScaffoldConfig,
  ): Effect.fn.Return<
    ScaffoldPlan<PolicyScaffoldResult>,
    PolicyScaffoldError,
    FileSystem.FileSystem
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const policy = yield* fromLegacySync(() => requireCanonicalSlug(config.policy, 'policy'));
    if (config.scope === 'global') {
      if (config.vertical !== undefined) {
        return yield* Effect.fail(
          new PolicyScaffoldError({ reason: '--vertical is forbidden when --scope is global' }),
        );
      }
      const policyPath = yield* fromLegacySync(() =>
        resolveContainedPath(
          workspaceRoot,
          'packages',
          'core-runtime',
          'src',
          'policies',
          `${policy}.policy.ts`,
        ),
      );
      const policyMutation = yield* createPolicyMutation(
        policyPath,
        renderPolicy(policy, 'global'),
      );
      const indexPath = yield* fromLegacySync(() =>
        resolveContainedPath(workspaceRoot, 'packages', 'core-runtime', 'src', 'index.ts'),
      );
      const indexContent = yield* fileSystem.readFileString(indexPath).pipe(
        Effect.mapError((cause) =>
          Match.value(cause.reason).pipe(
            Match.tag(
              'NotFound',
              () =>
                new PolicyScaffoldError({ reason: `Core public index is missing at ${indexPath}` }),
            ),
            Match.orElse(planningFailure),
          ),
        ),
      );
      const exportIdentifier = `${toCamelCase(policy)}Policy`;
      if (new RegExp(`^export \\{ ${exportIdentifier} \\} from `, 'mu').test(indexContent)) {
        return yield* Effect.fail(
          new PolicyScaffoldError({
            reason: `Policy identifier ${exportIdentifier} already exists`,
          }),
        );
      }
      const exportEntry = `export { ${exportIdentifier} } from './policies/${policy}.policy.ts';`;
      const patchedIndex = yield* fromLegacySync(() =>
        insertSortedSlot(
          indexContent,
          CORE_POLICY_SLOT_START,
          CORE_POLICY_SLOT_END,
          [exportEntry],
          (candidate) =>
            /^export \{ [A-Za-z][A-Za-z0-9]*Policy \} from '\.\/policies\/[a-z0-9-]+\.policy\.ts';$/u.test(
              candidate,
            ),
        ),
      );
      const indexMutation = updateMutation(indexPath, indexContent, patchedIndex);
      if (indexMutation === undefined) {
        return yield* Effect.fail(
          new PolicyScaffoldError({
            reason: 'global Policy export patch unexpectedly made no change',
          }),
        );
      }
      const mutations = [policyMutation, indexMutation];
      yield* fromLegacySync(() => ensureUniqueMutationPaths(mutations));
      return { mutations, result: { policyPath } };
    }

    if (config.vertical === undefined) {
      return yield* Effect.fail(
        new PolicyScaffoldError({ reason: '--vertical is required when --scope is microvertical' }),
      );
    }
    const requestedVertical = config.vertical;
    const vertical = yield* discoverOntosModuleEffect(workspaceRoot, requestedVertical).pipe(
      Effect.mapError(planningFailure),
    );
    const policyPath = yield* fromLegacySync(() =>
      resolveContainedPath(
        workspaceRoot,
        'verticals',
        vertical.slug,
        'src',
        'policies',
        `${policy}.policy.ts`,
      ),
    );
    const policyMutation = yield* createPolicyMutation(
      policyPath,
      renderPolicy(policy, 'microvertical', vertical.moduleId),
    );
    const dependencyMutation = yield* fromLegacySync(() => withCoreDependency(vertical));
    const mutations =
      dependencyMutation === undefined ? [policyMutation] : [policyMutation, dependencyMutation];
    yield* fromLegacySync(() => ensureUniqueMutationPaths(mutations));
    return { mutations, result: { policyPath } };
  },
);

export default createCodesmithGenerator(planPolicyScaffold);
