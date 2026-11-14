/** Sales metric tools offered to agents. */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const salesInsightsMcpContribution = defineOntosMcpContribution({
  approvals: false,
  commands: {
    AssignMetric: { title: { cs: 'Přiřadit metriku', en: 'Assign a metric' } },
    ChangeMetricState: { title: { cs: 'Změnit stav metriky', en: 'Change a metric state' } },
    CreateMetric: { title: { cs: 'Vytvořit metriku', en: 'Create a metric' } },
    UpdateMetric: { title: { cs: 'Upravit metriku', en: 'Update a metric' } },
  },
  description: {
    cs: 'Obchodní metriky a jejich cíle.',
    en: 'Sales metrics and their targets.',
  },
  keywords: 'přehled report statistika metrika cíl výkon prodej insight metric target performance sales',
  label: { cs: 'Obchodní přehledy a metriky', en: 'Sales insights and metrics' },
  page: '/prehledy/statistiky',
  reads: {
    records: { title: { cs: 'Přehled obchodních metrik a cílů', en: 'Sales metrics and targets overview' } },
  },
  revision: { read: 'records' },
});
