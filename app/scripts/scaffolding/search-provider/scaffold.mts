import { createCodesmithGenerator } from '../generator-adapter.mts';
import { planGovernedContributionScaffold } from '../governed-contribution/scaffold.mts';
import type {
  GovernedContributionScaffoldConfig,
  GovernedContributionScaffoldResult,
} from '../shared.mts';

export default createCodesmithGenerator<
  GovernedContributionScaffoldConfig,
  GovernedContributionScaffoldResult
>((workspaceRoot, config) =>
  planGovernedContributionScaffold(workspaceRoot, 'search-provider', config),
);
