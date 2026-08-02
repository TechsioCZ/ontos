import { readFile } from 'node:fs/promises';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  CORE_POLICY_SLOT_END,
  CORE_POLICY_SLOT_START,
  createMutation,
  discoverVertical,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  isMissingFileError,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
  toTitle,
  updateMutation,
  withCoreDependency,
} from '../shared.mts';
import type { PolicyScaffoldConfig, PolicyScaffoldResult, ScaffoldPlan } from '../shared.mts';

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

export const planPolicyScaffold = async (
  workspaceRoot: string,
  config: PolicyScaffoldConfig,
): Promise<ScaffoldPlan<PolicyScaffoldResult>> => {
  const policy = requireCanonicalSlug(config.policy, 'policy');
  if (config.scope === 'global') {
    if (config.vertical !== undefined) {
      throw new Error('--vertical is forbidden when --scope is global');
    }
    const policyPath = resolveContainedPath(
      workspaceRoot,
      'packages',
      'core-runtime',
      'src',
      'policies',
      `${policy}.policy.ts`,
    );
    const policyMutation = await createMutation(policyPath, renderPolicy(policy, 'global'));
    const indexPath = resolveContainedPath(
      workspaceRoot,
      'packages',
      'core-runtime',
      'src',
      'index.ts',
    );
    let indexContent: string;
    try {
      indexContent = await readFile(indexPath, 'utf-8');
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`Core public index is missing at ${indexPath}`, { cause: error });
      }
      throw error;
    }
    const exportIdentifier = `${toCamelCase(policy)}Policy`;
    if (new RegExp(`^export \\{ ${exportIdentifier} \\} from `, 'mu').test(indexContent)) {
      throw new Error(`Policy identifier ${exportIdentifier} already exists`);
    }
    const exportEntry = `export { ${exportIdentifier} } from './policies/${policy}.policy.ts';`;
    const patchedIndex = insertSortedSlot(
      indexContent,
      CORE_POLICY_SLOT_START,
      CORE_POLICY_SLOT_END,
      [exportEntry],
      (candidate) =>
        /^export \{ [A-Za-z][A-Za-z0-9]*Policy \} from '\.\/policies\/[a-z0-9-]+\.policy\.ts';$/u.test(
          candidate,
        ),
    );
    const indexMutation = updateMutation(indexPath, indexContent, patchedIndex);
    if (indexMutation === undefined) {
      throw new Error('global Policy export patch unexpectedly made no change');
    }
    const mutations = [policyMutation, indexMutation];
    ensureUniqueMutationPaths(mutations);
    return { mutations, result: { policyPath } };
  }

  if (config.vertical === undefined) {
    throw new Error('--vertical is required when --scope is microvertical');
  }
  const vertical = await discoverVertical(workspaceRoot, config.vertical);
  const policyPath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'policies',
    `${policy}.policy.ts`,
  );
  const policyMutation = await createMutation(
    policyPath,
    renderPolicy(policy, 'microvertical', vertical.appId),
  );
  const dependencyMutation = withCoreDependency(vertical);
  const mutations =
    dependencyMutation === undefined ? [policyMutation] : [policyMutation, dependencyMutation];
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { policyPath } };
};

export default createCodesmithGenerator(planPolicyScaffold);
