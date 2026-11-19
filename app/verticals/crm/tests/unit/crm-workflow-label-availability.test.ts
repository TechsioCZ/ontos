import { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { getI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { ModernI18nProvider, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { jsx } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { crmI18nResources } from '../../src/crm/i18n.ts';

// Public labels consumed by the CRM workflows: wording may change, translation availability must not.
const workflowKeys = [
  'crm.ciWorkflow.aiApprovalLog',
  'crm.ciWorkflow.approvedLinks',
  'crm.ciWorkflow.awaitingPairing',
  'crm.ciWorkflow.batchView',
  'crm.ciWorkflow.businessOverview',
  'crm.ciWorkflow.chartCurrency',
  'crm.ciWorkflow.client',
  'crm.ciWorkflow.clientAssignment',
  'crm.ciWorkflow.clientsWithOrders',
  'crm.ciWorkflow.completeContact',
  'crm.ciWorkflow.completed30Days',
  'crm.ciWorkflow.contactOn',
  'crm.ciWorkflow.contactOutcome',
  'crm.ciWorkflow.contactToday',
  'crm.ciWorkflow.crmClient',
  'crm.ciWorkflow.crossSourceDuplicate',
  'crm.ciWorkflow.csvContents',
  'crm.ciWorkflow.csvFile',
  'crm.ciWorkflow.csvImport',
  'crm.ciWorkflow.decisionNote',
  'crm.ciWorkflow.decisionNotePlaceholder',
  'crm.ciWorkflow.emptyQueue',
  'crm.ciWorkflow.excludedFromReport',
  'crm.ciWorkflow.groupBy',
  'crm.ciWorkflow.importBatches',
  'crm.ciWorkflow.importedSkuItems',
  'crm.ciWorkflow.items',
  'crm.ciWorkflow.itemsNotProvided',
  'crm.ciWorkflow.managementApprovalsOnly',
  'crm.ciWorkflow.managementPairingOnly',
  'crm.ciWorkflow.monthlyOrderCounts',
  'crm.ciWorkflow.monthlyOrderValue',
  'crm.ciWorkflow.monthlyTrend',
  'crm.ciWorkflow.needsReview',
  'crm.ciWorkflow.newApprovedLink',
  'crm.ciWorkflow.noCompletedContacts',
  'crm.ciWorkflow.noData',
  'crm.ciWorkflow.noImportsYet',
  'crm.ciWorkflow.noOrders',
  'crm.ciWorkflow.noOrdersYet',
  'crm.ciWorkflow.note',
  'crm.ciWorkflow.nothingToReview',
  'crm.ciWorkflow.openContacts',
  'crm.ciWorkflow.orderChartData',
  'crm.ciWorkflow.ordersToResolve',
  'crm.ciWorkflow.overdue',
  'crm.ciWorkflow.pairingReason',
  'crm.ciWorkflow.period',
  'crm.ciWorkflow.planNotePlaceholder',
  'crm.ciWorkflow.recordVisit',
  'crm.ciWorkflow.recordedOrderValue',
  'crm.ciWorkflow.recordedOrders',
  'crm.ciWorkflow.responsibleSalesperson',
  'crm.ciWorkflow.salesAtAGlance',
  'crm.ciWorkflow.salesperson',
  'crm.ciWorkflow.sampleFiles',
  'crm.ciWorkflow.searchClient',
  'crm.ciWorkflow.searchOrder',
  'crm.ciWorkflow.searchOrderPlaceholder',
  'crm.ciWorkflow.selectClient',
  'crm.ciWorkflow.show',
  'crm.ciWorkflow.source',
  'crm.ciWorkflow.sourceCustomerId',
  'crm.ciWorkflow.sourceSystem',
  'crm.ciWorkflow.status',
  'crm.ciWorkflow.targetClient',
  'crm.ciWorkflow.today',
  'crm.ciWorkflow.uncertainClient',
  'crm.ciWorkflow.unpaired',
  'crm.ciWorkflow.within14Days',
];
const clientVisitKeys = [
  'crm.ciClientsVisits.clients.active',
  'crm.ciClientsVisits.clients.assignedSalesperson',
  'crm.ciClientsVisits.clients.assignedToMe',
  'crm.ciClientsVisits.clients.cannotDisplay',
  'crm.ciClientsVisits.clients.cardUnavailable',
  'crm.ciClientsVisits.clients.contactedLast30Days',
  'crm.ciClientsVisits.clients.customerRegistry',
  'crm.ciClientsVisits.clients.existingRegistryCustomer',
  'crm.ciClientsVisits.clients.exportDescription',
  'crm.ciClientsVisits.clients.linkedToRegistry',
  'crm.ciClientsVisits.clients.newSalesperson',
  'crm.ciClientsVisits.clients.notFound',
  'crm.ciClientsVisits.clients.recordedOrderValue',
  'crm.ciClientsVisits.clients.recordedOrders',
  'crm.ciClientsVisits.clients.registryIdentity',
  'crm.ciClientsVisits.clients.salespeople',
  'crm.ciClientsVisits.clients.searchLabel',
  'crm.ciClientsVisits.clients.searchPlaceholder',
  'crm.ciClientsVisits.clients.withoutContact',
  'crm.ciClientsVisits.clients.withoutSalesperson',
  'crm.ciClientsVisits.contacts.empty',
  'crm.ciClientsVisits.contacts.primary',
  'crm.ciClientsVisits.contacts.removeFromForm',
  'crm.ciClientsVisits.contacts.roleExample',
  'crm.ciClientsVisits.contacts.rolesExample',
  'crm.ciClientsVisits.contacts.title',
  'crm.ciClientsVisits.fields.address',
  'crm.ciClientsVisits.fields.addressPlaceholder',
  'crm.ciClientsVisits.fields.client',
  'crm.ciClientsVisits.fields.date',
  'crm.ciClientsVisits.fields.dueDate',
  'crm.ciClientsVisits.fields.email',
  'crm.ciClientsVisits.fields.fullName',
  'crm.ciClientsVisits.fields.jobRole',
  'crm.ciClientsVisits.fields.note',
  'crm.ciClientsVisits.fields.period',
  'crm.ciClientsVisits.fields.phone',
  'crm.ciClientsVisits.fields.registrationNumber',
  'crm.ciClientsVisits.fields.salesperson',
  'crm.ciClientsVisits.fields.segment',
  'crm.ciClientsVisits.fields.status',
  'crm.ciClientsVisits.fields.taxId',
  'crm.ciClientsVisits.fields.time',
  'crm.ciClientsVisits.fields.type',
  'crm.ciClientsVisits.fields.website',
  'crm.ciClientsVisits.history.empty',
  'crm.ciClientsVisits.visits.addNextStepToMyPlan',
  'crm.ciClientsVisits.visits.addNextStepToPlan',
  'crm.ciClientsVisits.visits.clientPlaceholder',
  'crm.ciClientsVisits.visits.contactOnDate',
  'crm.ciClientsVisits.visits.contactsLast30Days',
  'crm.ciClientsVisits.visits.correctRecord',
  'crm.ciClientsVisits.visits.correctedRecords',
  'crm.ciClientsVisits.visits.correctionExample',
  'crm.ciClientsVisits.visits.correctionReason',
  'crm.ciClientsVisits.visits.empty',
  'crm.ciClientsVisits.visits.inPersonLast30Days',
  'crm.ciClientsVisits.visits.lastContact',
  'crm.ciClientsVisits.visits.lastContactAnyType',
  'crm.ciClientsVisits.visits.lastVisit',
  'crm.ciClientsVisits.visits.nextPlannedContact',
  'crm.ciClientsVisits.visits.nextStep',
  'crm.ciClientsVisits.visits.recordVisit',
  'crm.ciClientsVisits.visits.recordedContacts',
  'crm.ciClientsVisits.visits.responsibleSalesperson',
  'crm.ciClientsVisits.visits.result',
  'crm.ciClientsVisits.visits.searchLabel',
  'crm.ciClientsVisits.visits.searchPlaceholder',
];

const Probe = ({
  keys,
  labels,
}: {
  readonly keys: readonly string[];
  readonly labels: { key: string; translated: string }[];
}) => {
  const { t } = useModernI18n();
  labels.push(...keys.map((key) => ({ key, translated: t(key) })));
  return createElement('pre', null, labels.map(({ translated }) => translated).join('|'));
};

it.effect.each([
  { area: 'workflow', keys: workflowKeys, language: 'cs' },
  { area: 'workflow', keys: workflowKeys, language: 'en' },
  { area: 'clients and visits', keys: clientVisitKeys, language: 'cs' },
  { area: 'clients and visits', keys: clientVisitKeys, language: 'en' },
])('$area labels resolve through the $language CRM namespace instead of showing raw keys', ({ keys, language }) =>
  Effect.gen(function* localizedLabels() {
    const host = yield* Effect.promise(() => getI18nInstance());
    yield* Effect.promise(() =>
      host.init({
        defaultNS: 'translation',
        fallbackLng: false,
        initImmediate: false,
        lng: language,
        ns: ['translation'],
        resources: { cs: { translation: { hostOnly: 'host' } }, en: { translation: { hostOnly: 'host' } } },
      }),
    );
    const translated: { key: string; translated: string }[] = [];
    const html = renderToStaticMarkup(
      jsx(ModernI18nProvider, {
        children: jsx(FederatedI18nBoundary, {
          children: jsx(Probe, { keys, labels: translated }),
          defaultNamespace: 'crm',
          fallbackLanguage: language,
          resources: crmI18nResources,
          supportedLanguages: ['cs', 'en'],
        }),
        value: { i18nInstance: host, language, languages: ['cs', 'en'] },
      }),
    );
    expect(html).not.toBe('<pre></pre>');
    expect(translated.map(({ key }) => key)).toEqual(keys);
    for (const { key, translated: label } of translated) {
      expect(label, key).not.toBe(key);
      expect(label.trim(), key).not.toBe('');
    }
    expect(host.t('hostOnly')).toBe('host');
  }),
);
