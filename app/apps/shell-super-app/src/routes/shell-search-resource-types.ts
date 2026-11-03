import type { IconType } from '@techsio/ui-kit/atoms/icon';
import { Schema } from 'effect';

import type { ShellSearchResult } from '../../shared/api.ts';
import { searchHitState } from './search-hit-state.ts';

/**
 * Search groups in display order, translated below `shell.search.groups`. A result joins the group of its owner's
 * resource type; a type the Shell does not know yet stays visible under "other records".
 */
export const ShellSearchGroupKeySchema = Schema.Literals([
  'counterparty',
  'party',
  'person',
  'crmClient',
  'crmContact',
  'opportunity',
  'product',
  'sku',
  'order',
  'task',
  'invoice',
  'financeDocument',
  'contract',
  'legalDocument',
  'property',
  'unit',
  'lease',
  'asset',
  'device',
  'facilityDocument',
  'market',
  'resource',
]);
export type ShellSearchGroupKey = typeof ShellSearchGroupKeySchema.Type;

export const shellSearchGroupOrder: readonly ShellSearchGroupKey[] = ShellSearchGroupKeySchema.literals;

export const shellSearchGroupIcon = {
  asset: 'icon-[mdi--toolbox-outline]',
  contract: 'icon-[mdi--file-sign]',
  counterparty: 'icon-[mdi--handshake-outline]',
  crmClient: 'icon-[mdi--account-tie-outline]',
  crmContact: 'icon-[mdi--card-account-phone-outline]',
  device: 'icon-[mdi--gauge]',
  facilityDocument: 'icon-[mdi--folder-file-outline]',
  financeDocument: 'icon-[mdi--file-document-multiple-outline]',
  invoice: 'icon-[mdi--receipt-text-outline]',
  lease: 'icon-[mdi--key-chain-variant]',
  legalDocument: 'icon-[mdi--file-document-outline]',
  market: 'icon-[mdi--earth]',
  opportunity: 'icon-[mdi--briefcase-outline]',
  order: 'icon-[mdi--cart-outline]',
  party: 'icon-[mdi--card-account-details-outline]',
  person: 'icon-[mdi--account-multiple-outline]',
  product: 'icon-[mdi--package-variant-closed]',
  property: 'icon-[mdi--office-building-outline]',
  resource: 'icon-[mdi--file-outline]',
  sku: 'icon-[mdi--barcode]',
  task: 'icon-[mdi--checkbox-marked-circle-outline]',
  unit: 'icon-[mdi--door]',
} as const satisfies Readonly<Record<ShellSearchGroupKey, IconType>>;

/**
 * The owner page that opens one record, with the owner's resource ID either as the `$id` path segment or as one
 * query parameter. Only pages that really select a record by that ID belong here.
 */
type RecordRoute =
  | { readonly kind: 'path'; readonly to: string }
  | { readonly kind: 'query'; readonly param: string; readonly to: string };

interface ResourceTypePresentation {
  /**
   * Canonical paths of the agendas that list these records, for the Shell record page when there is no record page.
   * Without it the page offers every agenda of the owning module.
   */
  readonly agendas?: readonly string[];
  readonly group: ShellSearchGroupKey;
  readonly idFormat?: 'uuid';
  /**
   * `company`: the owner qualifies its record ID with the company (`<legalEntityId>.<local ID>`) while its page
   * selects by the local ID. Absent: the page selects by the resource ID as is.
   */
  readonly idScope?: 'company';
  readonly moduleId: string;
  readonly record?: RecordRoute;
}

const query = (to: string, param = 'resourceId'): RecordRoute => ({ kind: 'query', param, to });
const portfolio = { moduleId: 'property.portfolio', record: query('/nemovitosti') } as const;
const facility = (to: string, param: string, group: ShellSearchGroupKey): ResourceTypePresentation => ({
  agendas: [to],
  group,
  idScope: 'company',
  moduleId: 'facility.operations',
  record: query(to, param),
});

/**
 * Registered owner resource types the Shell names, by `ref.resourceType`. Adding a searchable type is one entry;
 * leave out `record` until the owner has a page that opens that record, so the hit opens the Shell record page.
 */
const resourceTypes = new Map<string, ResourceTypePresentation>([
  // A person of the company is a Core identity record; the Shell's own people administration lists them, and the
  // Shell offers it only to people who may open it.
  [
    'core.identity.person',
    {
      agendas: ['/sprava/lide-a-role'],
      group: 'person',
      moduleId: 'core.identity',
      record: query('/sprava/lide-a-role', 'person'),
    },
  ],
  [
    'party.registry.counterparty',
    {
      group: 'counterparty',
      idFormat: 'uuid',
      moduleId: 'party.registry',
      record: { kind: 'path', to: '/prodej/zakaznici/$id' },
    },
  ],
  [
    'party.registry.party',
    {
      group: 'party',
      idFormat: 'uuid',
      moduleId: 'party.registry',
      record: { kind: 'path', to: '/prodej/strany/$id' },
    },
  ],
  ['demo.crm.client', { group: 'crmClient', moduleId: 'demo.crm', record: query('/crm/klienti', 'klient') }],
  ['demo.crm.contact', { group: 'crmContact', moduleId: 'demo.crm', record: query('/crm/klienti', 'osoba') }],
  [
    'demo.sales-pipeline.opportunity',
    { group: 'opportunity', moduleId: 'demo.sales-pipeline', record: query('/prodej/prilezitosti', 'opportunityId') },
  ],
  [
    'demo.merchandise.product',
    {
      group: 'product',
      idScope: 'company',
      moduleId: 'demo.merchandise',
      record: { kind: 'path', to: '/provoz/produkty/$id' },
    },
  ],
  [
    'demo.merchandise.order',
    {
      group: 'order',
      idScope: 'company',
      moduleId: 'demo.merchandise',
      record: query('/prodej/objednavky', 'orderId'),
    },
  ],
  ['work.tasks.task', { group: 'task', moduleId: 'work.tasks', record: query('/ukoly') }],
  ['finance.billing.invoice', { group: 'invoice', moduleId: 'finance.billing', record: query('/finance') }],
  [
    'finance.billing.document',
    {
      agendas: ['/finance'],
      group: 'financeDocument',
      idFormat: 'uuid',
      moduleId: 'finance.billing',
      record: query('/finance', 'documentId'),
    },
  ],
  ['legal.agreements.contract', { group: 'contract', moduleId: 'legal.agreements', record: query('/smlouvy') }],
  ['legal.agreements.document', { group: 'legalDocument', moduleId: 'legal.agreements' }],
  ['property.portfolio.property', { ...portfolio, group: 'property' }],
  ['property.portfolio.unit', { ...portfolio, group: 'unit' }],
  ['property.portfolio.asset', { ...portfolio, group: 'asset' }],
  ['facility.operations.asset', facility('/provoz/majetek', 'asset', 'asset')],
  ['facility.operations.device', facility('/provoz/bezpecnost', 'device', 'device')],
  ['facility.operations.meter', facility('/provoz/meridla', 'meter', 'device')],
  ['facility.operations.document', facility('/provoz/dokumenty', 'doc', 'facilityDocument')],
  ['property.leasing.occupancy', { group: 'lease', moduleId: 'property.leasing', record: query('/najmy') }],
  [
    'commerce.market-catalog.market',
    {
      group: 'market',
      moduleId: 'commerce.market-catalog',
      record: { kind: 'path', to: '/prodej/eshopy/trhy/$id' },
    },
  ],
]);

interface SearchRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

/** A presentation applies only when the hit comes from the module that owns the type. */
const presentationOf = (ref: SearchRef): ResourceTypePresentation | undefined => {
  const presentation = resourceTypes.get(ref.resourceType);
  return presentation?.moduleId === ref.moduleId ? presentation : undefined;
};

const shellSearchGroups = new Set<string>(ShellSearchGroupKeySchema.literals);

/**
 * The exact `resourceTypes` request filter for the Shell groups the caller offers, in registry order. `undefined`
 * means the groups cannot be described by a complete type list: the catch-all `resource` group also covers owner
 * types the Shell does not name, and an unknown group has no list at all. An empty list means the selected groups
 * hold no registered type; the caller omits the request field separately when the whole family is empty.
 */
export const shellSearchResourceTypesForGroups = (
  groups: readonly ShellSearchGroupKey[],
): readonly string[] | undefined => {
  if (groups.some((group) => !shellSearchGroups.has(group)) || groups.includes('resource')) {
    return undefined;
  }
  const selected = new Set(groups);
  return [...resourceTypes].flatMap(([resourceType, presentation]) =>
    selected.has(presentation.group) ? [resourceType] : [],
  );
};

export const shellSearchGroupOf = (result: Pick<ShellSearchResult, 'kind' | 'ref'>): ShellSearchGroupKey => {
  if (result.kind === 'counterparty' || result.kind === 'party') {
    return result.kind;
  }
  return presentationOf(result.ref)?.group ?? 'resource';
};

export type ShellOwnerRecordTarget =
  | {
      readonly params: { readonly id: string };
      readonly to: string;
    }
  | {
      readonly search: Readonly<Record<string, string>>;
      readonly to: string;
    };

/** Props for the Shell route link that opens a hit: the owner's record page, else the Shell record page. */
export type ShellSearchLinkTarget =
  | ShellOwnerRecordTarget
  | {
      readonly params: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
      readonly state: ReturnType<typeof searchHitState>;
      readonly to: '/resources/$moduleId/$resourceType/$resourceId';
    };

/** Agendas listing this record when the type names them; otherwise the owning module's agendas apply. */
export const recordAgendaPaths = (ref: SearchRef): readonly string[] | undefined => presentationOf(ref)?.agendas;

const nativeRecordId = Schema.is(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)));
const uuidRecordId = Schema.is(Schema.String.check(Schema.isUUID()));
const validRecordId = (presentation: ResourceTypePresentation, id: string): string | undefined =>
  nativeRecordId(id) && (presentation.idFormat !== 'uuid' || uuidRecordId(id)) ? id : undefined;

/**
 * The ID the owner page selects the record by. A company-qualified ID yields its local part only when it is qualified
 * with the trusted selected company the result carries; any other company, a missing company or an empty local part
 * yields nothing, so the hit never opens a record page of another company.
 */
const recordIdOf = (
  presentation: ResourceTypePresentation,
  ref: SearchRef,
  selectedLegalEntityId: string | undefined,
): string | undefined => {
  if (presentation.idScope === undefined) {
    return validRecordId(presentation, ref.resourceId);
  }
  if (selectedLegalEntityId === undefined || selectedLegalEntityId.length === 0) {
    return undefined;
  }
  const prefix = `${selectedLegalEntityId}.`;
  const localId = ref.resourceId.startsWith(prefix) ? ref.resourceId.slice(prefix.length) : '';
  return validRecordId(presentation, localId);
};

/**
 * The owner page that opens this record, when the owner has one. `selectedLegalEntityId` is the trusted selected
 * company of the result (or of the current Shell context); company-qualified records need it.
 */
export const ownerRecordTarget = (
  ref: SearchRef,
  selectedLegalEntityId: string | undefined,
): ShellOwnerRecordTarget | undefined => {
  const presentation = presentationOf(ref);
  const record = presentation?.record;
  if (presentation === undefined || record === undefined) {
    return undefined;
  }
  const id = recordIdOf(presentation, ref, selectedLegalEntityId);
  if (id === undefined) {
    return undefined;
  }
  return record.kind === 'path' ? { params: { id }, to: record.to } : { search: { [record.param]: id }, to: record.to };
};

export const shellSearchLinkTarget = (
  ref: SearchRef,
  title: string,
  selectedLegalEntityId: string | undefined,
): ShellSearchLinkTarget =>
  ownerRecordTarget(ref, selectedLegalEntityId) ?? {
    params: { moduleId: ref.moduleId, resourceId: ref.resourceId, resourceType: ref.resourceType },
    state: searchHitState(title),
    to: '/resources/$moduleId/$resourceType/$resourceId',
  };

/** Where a search hit opens; a generic owner hit carries its trusted selected company. */
export const shellSearchResultTarget = (result: ShellSearchResult): ShellSearchLinkTarget =>
  shellSearchLinkTarget(
    result.ref,
    result.title,
    result.kind === 'resource' ? result.selectedLegalEntityId : undefined,
  );
