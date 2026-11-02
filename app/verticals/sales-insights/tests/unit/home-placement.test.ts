import { expect, it } from 'effect-rstest';

import { salesInsightsManifest } from '../../vertical.manifest.ts';

/**
 * Home placement order of the CRM's single-module summary (demo.crm.component.home-summary). The Shell shows the
 * lowest order whose required modules are all in the person's navigation, so the dashboard has to come first.
 */
const crmHomeSummaryOrder = 100;

const homePlacements = salesInsightsManifest.publicSurface.shellContributions.publicComponents.flatMap(
  ({ entrypoint, home }) =>
    home === undefined
      ? []
      : [{ entrypointKey: entrypoint.entrypointKey, order: home.order, requiresModules: home.requiresModules }],
);

it('offers the sales dashboard on Home ahead of the CRM summary, only with the whole sales agenda', () => {
  expect(homePlacements).toEqual([
    {
      entrypointKey: 'demo.sales-insights.component.crm-dashboard',
      order: 50,
      requiresModules: ['demo.sales-insights', 'demo.sales-pipeline', 'work.tasks', 'finance.billing'],
    },
  ]);
  // Obchodní firma shows CRM too (tenant administrator); its Home must still be the five sales indicators. Velkoobchod
  // Hanák has no sales pipeline or billing, so it falls through to the CRM summary.
  expect(homePlacements.every(({ order }) => order < crmHomeSummaryOrder)).toBe(true);
});
