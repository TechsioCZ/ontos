import type { OperationalScope } from '@app/core-runtime';
import { Schema } from 'effect';

import { SalesInsightsStateSchema } from '../../shared/apis/records.ts';

/** The state of a company before its first metric is stored: one empty collection, no metrics. */
export const emptySalesInsightsState = (tenantId: string, legalEntityId: string) =>
  Schema.decodeEffect(SalesInsightsStateSchema)({
    collection: {
      properties: {
        dueDate: { locked: true, type: 'DATE' },
        ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
        status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
        title: { locked: true, type: 'TEXT' },
      },
      ref: {
        moduleId: 'demo.sales-insights',
        resourceId: `metrics-${legalEntityId}`,
        resourceType: 'demo.sales-insights.metric-collection',
        tenantId,
      },
      title: 'Metriky',
    },
    metrics: [],
  });

/** An MCP connection may change the module directly only with write policy 'direct' and module write. */
export const connectionAllowsWrite = (
  scope: Partial<Pick<OperationalScope, 'authMethod' | 'connection'>>,
  moduleKey: string,
): boolean => {
  if (scope.authMethod !== 'oauth_connection') {
    return true;
  }
  const { connection } = scope;
  if (connection === undefined || connection.writePolicy !== 'direct') {
    return false;
  }
  return (
    connection.modules === 'all' ||
    connection.modules.some((module) => module.moduleId === moduleKey && module.access === 'write')
  );
};
