import { createCodesmithGenerator } from '../generator-adapter.mts';
import { planGovernedContributionScaffold } from '../governed-contribution/scaffold.mts';
import type { GovernedContributionScaffoldConfig } from '../shared.mts';
import { planCorePeopleSearchProvider } from '../core-people/scaffold.mts';

export default createCodesmithGenerator((workspaceRoot: string, config: GovernedContributionScaffoldConfig) =>
  // Demo-only exception: Core's reviewed people search (no main concept) has its own exact plan.
  config.vertical === 'core'
    ? planCorePeopleSearchProvider(workspaceRoot, config)
    : planGovernedContributionScaffold(workspaceRoot, 'search-provider', config),
);
