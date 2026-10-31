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
