import { createCodesmithGenerator } from '../generator-adapter.mts';
import { planGovernedContributionScaffold } from '../governed-contribution/scaffold.mts';
import type { GovernedContributionScaffoldConfig } from '../shared.mts';

export default createCodesmithGenerator(
  (workspaceRoot: string, config: GovernedContributionScaffoldConfig) =>
    planGovernedContributionScaffold(workspaceRoot, 'public-component', config)
);
