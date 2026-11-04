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
 * One destination of the composed Shell navigation, as the Shell already receives it: the owner module, the module's
 * navigation section and the destination's canonical path. The Shell names no business module and no record type here.
 */
export interface ShellSearchNavigationItem {
  readonly groupKey: string;
  readonly href?: string | undefined;
  readonly moduleId: string;
}

/**
 * What the composed navigation proves about this document: the destinations every composed module declares and the
 * navigation section it places them in. A record presentation applies only when this evidence names the hit's owner
 * and the destination the presentation opens; anything short of that opens the generic Shell record page. The
 * composition also carries the record destinations its owner pages declare, keyed by the exact owner and type.
 */
export interface ShellSearchPresentationContext {
  readonly hrefs: ReadonlyMap<string, readonly string[]>;
  readonly recordDestinations: ReadonlyMap<string, readonly ShellSearchRecordDestination[]>;
  readonly sections: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * One owner page that opens a record type, as the composition carries it: the route template and the single parameter
 * that selects the record. The Shell never derives a destination from a type name; it looks up this exact pair.
 */
export interface ShellSearchRecordDestination {
  readonly idParameter: string;
  readonly moduleId: string;
  readonly resourceType: string;
  readonly routePath: string;
}

/** `shell.navigation.finance` is the navigation section `finance`. */
const navigationSection = (groupKey: string): string => groupKey.replace(/^shell\.navigation\./u, '');

const recordDestinationKey = (moduleId: string, resourceType: string): string => `${moduleId}\u0000${resourceType}`;

export const shellSearchPresentationContext = (
  navigation: readonly ShellSearchNavigationItem[],
  recordDestinations: readonly ShellSearchRecordDestination[] = [],
): ShellSearchPresentationContext => {
  const sections = new Map<string, ReadonlySet<string>>();
  const hrefs = new Map<string, readonly string[]>();
  for (const { groupKey, href, moduleId } of navigation) {
    sections.set(moduleId, new Set([...(sections.get(moduleId) ?? []), navigationSection(groupKey)]));
    if (href !== undefined) {
      hrefs.set(moduleId, [...(hrefs.get(moduleId) ?? []), href]);
    }
  }
  const destinations = new Map<string, readonly ShellSearchRecordDestination[]>();
  for (const destination of recordDestinations) {
    const key = recordDestinationKey(destination.moduleId, destination.resourceType);
    destinations.set(key, [...(destinations.get(key) ?? []), destination]);
  }
  return { hrefs, recordDestinations: destinations, sections };
};

/**
 * The owner page that opens one record, with the owner's resource ID either as the `$id` path segment or as one
 * query parameter. A query target without `to` opens the owner's own agenda destination, resolved from navigation.
 * An owner target names no Shell path at all: the page comes from the destination the owner page declared.
 */
type RecordRoute =
  | { readonly kind: 'path'; readonly to: string }
  | { readonly kind: 'owner' }
  | { readonly kind: 'query'; readonly param: string; readonly to?: string | undefined };

type ResolvedRecordRoute =
  | { readonly kind: 'path'; readonly to: string }
  | { readonly idParameter: string; readonly kind: 'owner'; readonly to: string }
  | { readonly kind: 'query'; readonly param: string; readonly to: string };

/**
 * Presentation of one record type name: the last segment of `ref.resourceType`. The name is owner-relative, so it
 * applies only to the module that namespaces the type; a navigation section settles a name that several owners share
 * (a facility document and a finance document are both `document`). The destination it opens must be a destination
 * that module itself declares in the composed navigation, so a name alone never claims another owner's page.
 */
interface ResourceTypePresentation {
  readonly agendas?: readonly string[] | undefined;
  /**
   * Last segment of the owner navigation destination that lists these records. Its `href` is the agreed agenda page,
   * so the Shell never repeats an owner route.
   */
  readonly agendaSuffix?: string | undefined;
  readonly group: ShellSearchGroupKey;
  readonly idFormat?: 'uuid' | undefined;
  readonly idScope?: 'company' | undefined;
  /**
   * The record type of a Shell platform page: the Shell's own page lists these records, so that destination is the
   * Shell's route and no module declares it. This names the module that publishes the type.
   */
  readonly platformOwnerModuleId?: string | undefined;
  readonly record?: RecordRoute | undefined;
  /** Navigation section of the owning module, when several modules register the same record type name. */
  readonly section?: string | undefined;
}

interface ResolvedPresentation {
  readonly agendas: readonly string[] | undefined;
  readonly group: ShellSearchGroupKey;
  readonly idFormat: 'uuid' | undefined;
  readonly idScope: 'company' | undefined;
  readonly record: ResolvedRecordRoute | undefined;
}

const query = (param: string, to?: string): RecordRoute =>
  to === undefined ? { kind: 'query', param } : { kind: 'query', param, to };
const path = (to: string): RecordRoute => ({ kind: 'path', to });
const financeAgenda = '/finance';
const propertyAgenda = '/nemovitosti';
/** A company-qualified record of the owner's own agenda page. */
const companyAgenda = (to: string, param: string, group: ShellSearchGroupKey): ResourceTypePresentation => ({
  agendas: [to],
  group,
  idScope: 'company',
  record: query(param, to),
});

/**
 * Record presentations by the record type name the owner publishes. Adding a searchable type is one entry; leave out
 * `record` until the owner has a page that opens that record, so the hit opens the Shell record page.
 */
const resourceTypes = new Map<string, readonly ResourceTypePresentation[]>([
  [
    'asset',
    [
      { group: 'asset', record: query('resourceId', propertyAgenda), section: 'real-estate' },
      { ...companyAgenda('/provoz/majetek', 'asset', 'asset'), section: 'facility' },
    ],
  ],
  ['client', [{ agendaSuffix: 'klienti', group: 'crmClient', record: query('klient'), section: 'sales' }]],
  ['contact', [{ agendaSuffix: 'klienti', group: 'crmContact', record: query('osoba'), section: 'sales' }]],
  ['contract', [{ group: 'contract', record: query('resourceId', '/smlouvy') }]],
  ['counterparty', [{ group: 'counterparty', idFormat: 'uuid', record: path('/prodej/zakaznici/$id') }]],
  ['device', [companyAgenda('/provoz/bezpecnost', 'device', 'device')]],
  [
    'document',
    [
      {
        agendas: [financeAgenda],
        group: 'financeDocument',
        idFormat: 'uuid',
        record: query('documentId', financeAgenda),
        section: 'finance',
      },
      { group: 'legalDocument', section: 'sales' },
      { ...companyAgenda('/provoz/dokumenty', 'doc', 'facilityDocument'), section: 'facility' },
    ],
  ],
  ['invoice', [{ group: 'invoice', record: query('resourceId', financeAgenda) }]],
  ['market', [{ group: 'market', record: path('/prodej/eshopy/trhy/$id') }]],
  ['meter', [companyAgenda('/provoz/meridla', 'meter', 'device')]],
  ['occupancy', [{ group: 'lease', record: query('resourceId', '/najmy') }]],
  ['opportunity', [{ group: 'opportunity', record: query('opportunityId', '/prodej/prilezitosti') }]],
  ['order', [{ group: 'order', idScope: 'company', record: query('orderId', '/prodej/objednavky') }]],
  // The Party identity page is the owner's own record destination; the Shell names no Party path or ID class here.
  ['party', [{ group: 'party', idFormat: 'uuid', record: { kind: 'owner' } }]],
  [
    'person',
    [
      {
        agendas: ['/sprava/lide-a-role'],
        group: 'person',
        platformOwnerModuleId: 'core.identity',
        record: query('person', '/sprava/lide-a-role'),
      },
    ],
  ],
  ['product', [{ group: 'product', idScope: 'company', record: path('/provoz/produkty/$id') }]],
  ['property', [{ group: 'property', record: query('resourceId', propertyAgenda) }]],
  ['task', [{ group: 'task', record: query('resourceId', '/ukoly') }]],
  ['unit', [{ group: 'unit', record: query('resourceId', propertyAgenda) }]],
]);

interface SearchRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

/** The parts of a search hit that presentation reads; a full Shell hit is accepted as is. */
export interface ShellSearchGroupInput {
  readonly kind: ShellSearchResult['kind'];
  readonly ref: SearchRef;
}

/**
 * The one destination of the owner module's own navigation that lists this record type, by the agreed route suffix.
 * No destination, or several of them, proves nothing: an owner navigation that does not answer exactly never picks a
 * page for the hit.
 */
const agendaHrefOf = (
  presentation: ResourceTypePresentation,
  ref: SearchRef,
  context: ShellSearchPresentationContext,
): string | undefined => {
  const suffix = presentation.agendaSuffix;
  if (suffix === undefined) {
    return undefined;
  }
  const matches = (context.hrefs.get(ref.moduleId) ?? []).filter((href) => href.split('/').at(-1) === suffix);
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * The composition proves this destination belongs to the hit's owner: the Shell's own platform page for a platform
 * record type, otherwise a destination the owner module itself declares (the destination, or the page its record page
 * opens under).
 */
const destinationIsComposed = (
  presentation: ResourceTypePresentation,
  ref: SearchRef,
  context: ShellSearchPresentationContext,
  destination: string,
): boolean => {
  // The Shell's own platform page needs no module to declare it; the Shell owns that route.
  if (presentation.platformOwnerModuleId !== undefined) {
    return true;
  }
  return (context.hrefs.get(ref.moduleId) ?? []).some(
    (href) => destination === href || destination.startsWith(`${href}/`),
  );
};

/**
 * The owner page's route template with its one declared parameter replaced by the Shell's `$id` segment. A template
 * that does not carry exactly the declared parameter proves nothing, so the hit keeps the generic Shell record page.
 */
const ownerRecordRoute = (
  destination: ShellSearchRecordDestination,
): Extract<ResolvedRecordRoute, { readonly kind: 'owner' }> | undefined => {
  const segments = destination.routePath.slice(1).split('/');
  const parameters = segments.flatMap((segment, index) =>
    segment.startsWith(':') ? [{ index, name: segment.slice(1) }] : [],
  );
  const [parameter] = parameters;
  if (parameters.length !== 1 || parameter === undefined || parameter.name !== destination.idParameter) {
    return undefined;
  }
  return {
    idParameter: destination.idParameter,
    kind: 'owner',
    to: `/${segments.map((segment, index) => (index === parameter.index ? '$id' : segment)).join('/')}`,
  };
};

const recordOf = (
  presentation: ResourceTypePresentation,
  ref: SearchRef,
  context: ShellSearchPresentationContext,
  agenda: string | undefined,
): ResolvedRecordRoute | undefined => {
  const route = presentation.record;
  if (route === undefined) {
    return undefined;
  }
  if (route.kind === 'path') {
    return destinationIsComposed(presentation, ref, context, route.to) ? route : undefined;
  }
  if (route.kind === 'owner') {
    // Only the exact pair the owner page declared for this hit is evidence; several entries prove nothing.
    const destinations = context.recordDestinations.get(recordDestinationKey(ref.moduleId, ref.resourceType)) ?? [];
    const [destination] = destinations;
    return destinations.length === 1 && destination !== undefined ? ownerRecordRoute(destination) : undefined;
  }
  const to = route.to ?? agenda;
  return to === undefined || !destinationIsComposed(presentation, ref, context, to)
    ? undefined
    : { kind: 'query', param: route.param, to };
};

const agendasOf = (
  presentation: ResourceTypePresentation,
  agenda: string | undefined,
): readonly string[] | undefined => {
  if (presentation.agendaSuffix === undefined) {
    return presentation.agendas;
  }
  return agenda === undefined ? undefined : [agenda];
};

/**
 * The presentation of a hit, only while the document's composition proves it. The hit's module must be a module of
 * this document (a Shell platform record type names its publisher explicitly), it must namespace the resource type,
 * a shared record type name must match the module's own navigation section, and the destination the presentation
 * opens must be that module's own composed destination. A hit any of that does not prove stays under "other records"
 * and opens the generic Shell record page.
 */
const presentationOf = (
  ref: SearchRef,
  context: ShellSearchPresentationContext | undefined,
): ResolvedPresentation | undefined => {
  if (context === undefined) {
    return undefined;
  }
  const prefix = `${ref.moduleId}.`;
  if (!ref.resourceType.startsWith(prefix) || ref.resourceType.length === prefix.length) {
    return undefined;
  }
  const candidates = resourceTypes.get(ref.resourceType.slice(prefix.length));
  const sections = context.sections.get(ref.moduleId);
  if (candidates === undefined) {
    return undefined;
  }
  const matches = candidates.filter(
    ({ platformOwnerModuleId, section }) =>
      (platformOwnerModuleId === undefined || platformOwnerModuleId === ref.moduleId) &&
      (section === undefined || sections?.has(section) === true),
  );
  const [presentation] = matches;
  if (presentation === undefined || matches.length > 1) {
    return undefined;
  }
  // A business module has to be a module of this document; only the Shell's own platform record type names its
  // publisher without one.
  if (presentation.platformOwnerModuleId === undefined && sections === undefined) {
    return undefined;
  }
  const agenda = agendaHrefOf(presentation, ref, context);
  const record = recordOf(presentation, ref, context, agenda);
  // A named record page is part of the presentation: when the composition does not prove it, the type is not proven.
  if (presentation.record !== undefined && record === undefined) {
    return undefined;
  }
  return {
    agendas: agendasOf(presentation, agenda),
    group: presentation.group,
    idFormat: presentation.idFormat,
    idScope: presentation.idScope,
    record,
  };
};

const shellSearchGroups = new Set<string>(ShellSearchGroupKeySchema.literals);

export const shellSearchGroupOf = (
  result: ShellSearchGroupInput,
  context?: ShellSearchPresentationContext,
): ShellSearchGroupKey => {
  if (result.kind === 'counterparty' || result.kind === 'party') {
    return result.kind;
  }
  return presentationOf(result.ref, context)?.group ?? 'resource';
};

/**
 * The exact `resourceTypes` request filter for the Shell groups the caller offers, from the types the answer really
 * contains in registry order. `undefined` means the groups cannot be described by a complete type list: the catch-all
 * `resource` group also covers owner types the Shell does not name, and an unknown group has no list at all. An empty
 * list means the selected groups hold no registered type; the caller omits the request field separately when the
 * whole family is empty.
 */
export const shellSearchResourceTypesForGroups = (
  groups: readonly ShellSearchGroupKey[],
  results: readonly ShellSearchGroupInput[],
  context?: ShellSearchPresentationContext,
): readonly string[] | undefined => {
  if (groups.some((group) => !shellSearchGroups.has(group)) || groups.includes('resource')) {
    return undefined;
  }
  const selected = new Set(groups);
  const types: string[] = [];
  const seen = new Set<string>();
  for (const group of shellSearchGroupOrder) {
    if (!selected.has(group)) {
      continue;
    }
    for (const { kind, ref } of results) {
      if (!seen.has(ref.resourceType) && shellSearchGroupOf({ kind, ref }, context) === group) {
        seen.add(ref.resourceType);
        types.push(ref.resourceType);
      }
    }
  }
  return types;
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
export const recordAgendaPaths = (
  ref: SearchRef,
  context?: ShellSearchPresentationContext,
): readonly string[] | undefined => presentationOf(ref, context)?.agendas;

const nativeRecordId = Schema.is(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)));
const uuidRecordId = Schema.is(Schema.String.check(Schema.isUUID()));
const validRecordId = (presentation: ResolvedPresentation, id: string): string | undefined =>
  nativeRecordId(id) && (presentation.idFormat !== 'uuid' || uuidRecordId(id)) ? id : undefined;

/**
 * The ID the owner page selects the record by. A company-qualified ID yields its local part only when it is qualified
 * with the trusted selected company the result carries; any other company, a missing company or an empty local part
 * yields nothing, so the hit never opens a record page of another company.
 */
const recordIdOf = (
  presentation: ResolvedPresentation,
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
  context?: ShellSearchPresentationContext,
): ShellOwnerRecordTarget | undefined => {
  const presentation = presentationOf(ref, context);
  const record = presentation?.record;
  if (presentation === undefined || record === undefined) {
    return undefined;
  }
  const id = recordIdOf(presentation, ref, selectedLegalEntityId);
  if (id === undefined) {
    return undefined;
  }
  return record.kind === 'query'
    ? { search: { [record.param]: id }, to: record.to }
    : { params: { id }, to: record.to };
};

export const shellSearchLinkTarget = (
  ref: SearchRef,
  title: string,
  selectedLegalEntityId: string | undefined,
  context?: ShellSearchPresentationContext,
): ShellSearchLinkTarget =>
  ownerRecordTarget(ref, selectedLegalEntityId, context) ?? {
    params: { moduleId: ref.moduleId, resourceId: ref.resourceId, resourceType: ref.resourceType },
    state: searchHitState(title),
    to: '/resources/$moduleId/$resourceType/$resourceId',
  };

/** Where a search hit opens; a generic owner hit carries its trusted selected company. */
export const shellSearchResultTarget = (
  result: ShellSearchResult,
  context?: ShellSearchPresentationContext,
): ShellSearchLinkTarget =>
  shellSearchLinkTarget(
    result.ref,
    result.title,
    result.kind === 'resource' ? result.selectedLegalEntityId : undefined,
    context,
  );
