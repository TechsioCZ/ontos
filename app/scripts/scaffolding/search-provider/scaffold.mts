import { createCodesmithGenerator } from '../generator-adapter.mts';
import { planGovernedContributionScaffold } from '../governed-contribution/scaffold.mts';
import type { GovernedContributionScaffoldConfig } from '../shared.mts';
import { planCorePeopleSearchProvider } from '../core-people/scaffold.mts';

export default createCodesmithGenerator((workspaceRoot: string, config: GovernedContributionScaffoldConfig) =>
  config.vertical === 'core'
    ? planCorePeopleSearchProvider(workspaceRoot, config)
    : planGovernedContributionScaffold(workspaceRoot, 'search-provider', config),
);
