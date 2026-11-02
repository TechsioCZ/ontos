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
  readonly group: ShellSearchGroupKey;
  readonly moduleId: string;
  readonly record?: RecordRoute;
}

const query = (to: string, param = 'resourceId'): RecordRoute => ({ kind: 'query', param, to });
const portfolio = { moduleId: 'property.portfolio', record: query('/nemovitosti') } as const;

/**
 * Registered owner resource types the Shell names, by `ref.resourceType`. Adding a searchable type is one entry;
 * leave out `record` until the owner has a page that opens that record, so the hit opens the Shell record page.
 */
const resourceTypes = new Map<string, ResourceTypePresentation>([
  ['party.registry.counterparty', { group: 'counterparty', moduleId: 'party.registry' }],
  ['party.registry.party', { group: 'party', moduleId: 'party.registry' }],
  ['demo.crm.client', { group: 'crmClient', moduleId: 'demo.crm', record: query('/crm/klienti', 'klient') }],
  ['demo.sales-pipeline.opportunity', { group: 'opportunity', moduleId: 'demo.sales-pipeline' }],
  [
    'demo.merchandise.product',
    { group: 'product', moduleId: 'demo.merchandise', record: { kind: 'path', to: '/provoz/produkty/$id' } },
  ],
  ['work.tasks.task', { group: 'task', moduleId: 'work.tasks', record: query('/ukoly') }],
  ['finance.billing.invoice', { group: 'invoice', moduleId: 'finance.billing', record: query('/finance') }],
  ['legal.agreements.contract', { group: 'contract', moduleId: 'legal.agreements', record: query('/smlouvy') }],
  ['legal.agreements.document', { group: 'legalDocument', moduleId: 'legal.agreements' }],
  ['property.portfolio.property', { ...portfolio, group: 'property' }],
  ['property.portfolio.unit', { ...portfolio, group: 'unit' }],
  ['property.portfolio.asset', { ...portfolio, group: 'asset' }],
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

export const shellSearchGroupOf = (result: Pick<ShellSearchResult, 'kind' | 'ref'>): ShellSearchGroupKey => {
  if (result.kind === 'counterparty' || result.kind === 'party') {
    return result.kind;
  }
  return presentationOf(result.ref)?.group ?? 'resource';
};

/** Props for the Shell route link that opens a hit: the owner's record page, else the Shell record page. */
export type ShellSearchLinkTarget =
  | {
      readonly params: { readonly id: string };
      readonly to: string;
    }
  | {
      readonly search: Readonly<Record<string, string>>;
      readonly to: string;
    }
  | {
      readonly params: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
      readonly state: ReturnType<typeof searchHitState>;
      readonly to: '/resources/$moduleId/$resourceType/$resourceId';
    };

/** The owner page that opens this record, when the owner has one. */
export const ownerRecordTarget = (ref: SearchRef): ShellSearchLinkTarget | undefined => {
  const record = presentationOf(ref)?.record;
  if (record === undefined) {
    return undefined;
  }
  return record.kind === 'path'
    ? { params: { id: ref.resourceId }, to: record.to }
    : { search: { [record.param]: ref.resourceId }, to: record.to };
};

export const shellSearchLinkTarget = (ref: SearchRef, title: string): ShellSearchLinkTarget =>
  ownerRecordTarget(ref) ?? {
    params: { moduleId: ref.moduleId, resourceId: ref.resourceId, resourceType: ref.resourceType },
    state: searchHitState(title),
    to: '/resources/$moduleId/$resourceType/$resourceId',
  };
