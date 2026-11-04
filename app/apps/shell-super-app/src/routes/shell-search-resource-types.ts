import {
  interpretCoreSearchPresentationEntry,
  interpretCoreSystemSearchPresentation,
} from '@app/core-runtime/search-contract';
import type {
  CoreSearchPresentationEntry,
  CoreShellLabel,
  CoreSystemSearchPresentation,
} from '@app/core-runtime/search-contract';
import type { IconType } from '@techsio/ui-kit/atoms/icon';
import { Result } from 'effect';

import type { ShellSearchPresentationInventory, ShellSearchResult } from '../../shared/api.ts';
import { shellSearchMatchedVariantHasQualifiedRef } from '../../shared/api.ts';
import { searchHitState } from './search-hit-state.ts';

/**
 * Browser-side reading of the presentation inventory the Shell captured for one authorized answer.
 *
 * Nothing here names an owner destination by itself: the only pages a hit may open are the exact pages the
 * inventory carries for its own owner, and the only record IDs are the ones the owner's finite selector declares.
 * A missing, foreign, ambiguous, stale or unresolvable inventory yields no owner destination, so the Shell record
 * page stays the fallback. The inventory never grants access; the owner destination authorizes that record again.
 */

/** The key of the catch-all row group for a genuinely unpresented owner type. */
export const GENERIC_SHELL_SEARCH_GROUP_KEY = 'resource';

/** The exact captured inventory of live owner pages. */
export type ShellSearchPresentationPage = ShellSearchPresentationInventory['pages'][number];

/** The validated presentation inventory of one answer, bound to the revision that captured it. */
export interface ShellSearchPresentationIndex {
  readonly business: readonly CoreSearchPresentationEntry[];
  readonly compositionRevision: string;
  readonly pages: readonly ShellSearchPresentationPage[];
  readonly system: CoreSystemSearchPresentation | undefined;
}

/** A row group as the owner declared it; the generic group carries no owner metadata. */
export interface ShellSearchGroupPresentation {
  readonly icon?: IconType;
  readonly key: string;
  readonly label?: CoreShellLabel;
  readonly order: number;
  readonly resourceTypes: readonly string[];
}

/** A filterable family as the owner declared it, with the groups and exact resource types observed for it. */
export interface ShellSearchFamilyPresentation {
  readonly groups: readonly ShellSearchGroupPresentation[];
  readonly icon: IconType;
  readonly key: string;
  readonly label: CoreShellLabel;
  readonly order: number;
  readonly resourceTypes: readonly string[];
}

const genericGroup: ShellSearchGroupPresentation = {
  key: GENERIC_SHELL_SEARCH_GROUP_KEY,
  order: Number.MAX_SAFE_INTEGER,
  resourceTypes: [],
};

const groupPresentation = (entry: CoreSearchPresentationEntry): ShellSearchGroupPresentation => ({
  icon: entry.presentation.group.icon,
  key: entry.presentation.group.key,
  label: entry.presentation.group.label,
  order: entry.presentation.group.order,
  resourceTypes: [entry.resourceType],
});

/**
 * Accepts only the inventory captured for this exact composition revision. A stale response (a different captured
 * release) is not a presentation inventory: its pages and interpretable leaves belong to another revision.
 */
export const shellSearchPresentationIndex = (
  inventory: ShellSearchPresentationInventory | undefined,
  compositionRevision: string | undefined,
): ShellSearchPresentationIndex | undefined => {
  if (inventory === undefined || compositionRevision === undefined) {
    return undefined;
  }
  if (inventory.business.compositionRevision !== compositionRevision) {
    return undefined;
  }
  return {
    business: inventory.business.entries,
    compositionRevision,
    pages: inventory.pages,
    system: inventory.system,
  };
};

interface SearchRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

/** One exact owner binding; more than one candidate is ambiguous and never becomes a destination. */
const entryOf = (index: ShellSearchPresentationIndex, ref: SearchRef): CoreSearchPresentationEntry | undefined => {
  const entries = index.business.filter(
    (entry) => entry.ownerModuleId === ref.moduleId && entry.resourceType === ref.resourceType,
  );
  return entries.length === 1 ? entries[0] : undefined;
};

/** The separate explicit Core-system branch, never a business page key. */
const systemOf = (index: ShellSearchPresentationIndex, ref: SearchRef): CoreSystemSearchPresentation | undefined => {
  const { system } = index;
  return system !== undefined && system.ownerModuleId === ref.moduleId && system.resourceType === ref.resourceType
    ? system
    : undefined;
};

/** A page resolves only inside the same owner that declared the presentation, never across owners. */
const pageOf = (
  index: ShellSearchPresentationIndex,
  ownerModuleId: string,
  pageKey: string,
): ShellSearchPresentationPage | undefined => {
  const pages = index.pages.filter((page) => page.ownerModuleId === ownerModuleId && page.pageKey === pageKey);
  return pages.length === 1 ? pages[0] : undefined;
};

const routeParameterPattern = /:(?<name>[a-z][A-Za-z0-9]*)/gu;

const routeParameterNames = (routePath: string): readonly string[] =>
  [...routePath.matchAll(routeParameterPattern)].map((match) => match.groups?.['name'] ?? '');

/** The captured owner template in TanStack form: `:documentId` becomes `$documentId`. */
const tanstackRoutePath = (routePath: string): string =>
  routePath.replaceAll(routeParameterPattern, (_match, name: string) => `$${name}`);

export interface ShellSearchNamedTarget {
  readonly agendas?: readonly string[];
  readonly params?: Readonly<Record<string, string>>;
  readonly search?: Readonly<Record<string, string>>;
  readonly to: string;
}

/** Statement-built form of the same target; optional members are added only when the owner declares them. */
interface MutableShellSearchNamedTarget {
  agendas?: readonly string[];
  params?: Record<string, string>;
  search?: Record<string, string>;
  to: string;
}

/** Props for the Shell route link that opens a hit. */
export type ShellSearchLinkTarget =
  | ShellSearchNamedTarget
  | {
      readonly params: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
      readonly state: ReturnType<typeof searchHitState>;
      readonly to: '/resources/$moduleId/$resourceType/$resourceId';
    };

export type ShellOwnerRecordTarget = ShellSearchNamedTarget;

const agendaPaths = (
  index: ShellSearchPresentationIndex,
  entry: CoreSearchPresentationEntry,
): readonly string[] | undefined => {
  const pageKeys = entry.presentation.agendaPageKeys;
  if (pageKeys === undefined || pageKeys.length === 0) {
    return undefined;
  }
  const paths: string[] = [];
  for (const pageKey of pageKeys) {
    const page = pageOf(index, entry.ownerModuleId, pageKey);
    if (page === undefined) {
      // Declared agendas that do not resolve stay empty instead of broadening to every module agenda.
      return [];
    }
    paths.push(tanstackRoutePath(page.routePath));
  }
  return paths;
};

const recordTarget = (
  index: ShellSearchPresentationIndex,
  entry: CoreSearchPresentationEntry,
  subject: { readonly matchedVariantId?: string; readonly recordId: string; readonly selectedLegalEntityId?: string },
): ShellSearchNamedTarget | undefined => {
  const interpreted = interpretCoreSearchPresentationEntry(entry, subject);
  if (Result.isFailure(interpreted)) {
    return undefined;
  }
  const target = interpreted.success;
  const page = pageOf(index, entry.ownerModuleId, target.pageKey);
  if (page === undefined) {
    return undefined;
  }
  const parameterNames = routeParameterNames(page.routePath);
  if (target.selectorKind === 'path') {
    const [parameter] = target.pathParameters;
    if (parameterNames.length !== 1 || parameter === undefined || parameterNames[0] !== parameter.name) {
      return undefined;
    }
  } else if (parameterNames.length !== 0) {
    return undefined;
  }
  const params = Object.fromEntries(target.pathParameters.map(({ name, value }) => [name, value]));
  const search = Object.fromEntries(target.queryParameters.map(({ name, value }) => [name, value]));
  const agendas = agendaPaths(index, entry);
  // The captured template keeps opaque IDs raw; the redirect/link adapter encodes exactly its named values.
  const finalized: MutableShellSearchNamedTarget = {
    to: tanstackRoutePath(page.routePath),
  };
  if (agendas !== undefined) {
    finalized.agendas = agendas;
  }
  if (Object.keys(params).length > 0) {
    finalized.params = params;
  }
  if (Object.keys(search).length > 0) {
    finalized.search = search;
  }
  return finalized;
};

const systemTarget = (index: ShellSearchPresentationIndex, ref: SearchRef): ShellSearchNamedTarget | undefined => {
  const system = systemOf(index, ref);
  if (system === undefined) {
    return undefined;
  }
  const interpreted = interpretCoreSystemSearchPresentation(system, { recordId: ref.resourceId });
  if (Result.isFailure(interpreted)) {
    return undefined;
  }
  const [parameter] = interpreted.success.queryParameters;
  if (parameter === undefined) {
    return undefined;
  }
  // The system branch keeps the full native ID unchanged, including a company-qualified person ID.
  return { search: { [parameter.name]: parameter.value }, to: interpreted.success.navigationPath };
};

const selectedCompanyOf = (result: ShellSearchResult): string | undefined => {
  if (result.kind === 'resource') {
    return result.selectedLegalEntityId;
  }
  return result.kind === 'counterparty' ? result.legalEntity.legalEntityId : undefined;
};

/** The verified variant refines only a destination whose owner declared that exact refinement. */
const refinementOf = (result: ShellSearchResult, entry: CoreSearchPresentationEntry): string | undefined =>
  result.kind === 'resource' &&
  result.matchedVariant !== undefined &&
  entry.presentation.refinement !== undefined &&
  shellSearchMatchedVariantHasQualifiedRef(result)
    ? result.matchedVariant.id
    : undefined;

/** The exact owner destination for a ref; a missing, foreign or ambiguous inventory yields nothing. */
export const ownerRecordTarget = (
  index: ShellSearchPresentationIndex | undefined,
  ref: SearchRef,
  selectedLegalEntityId: string | undefined,
): ShellOwnerRecordTarget | undefined => {
  if (index === undefined) {
    return undefined;
  }
  const entry = entryOf(index, ref);
  if (entry === undefined) {
    return undefined;
  }
  const baseSubject = { recordId: ref.resourceId };
  const subject = selectedLegalEntityId === undefined ? baseSubject : { ...baseSubject, selectedLegalEntityId };
  return recordTarget(index, entry, subject);
};

/**
 * The generic record destination for a ref: the exact business page, the separate Core-system navigation, or no
 * owner redirect at all. A business entry and a system presentation never both own one ref.
 */
export const shellSearchRecordTarget = (
  index: ShellSearchPresentationIndex | undefined,
  ref: SearchRef,
  selectedLegalEntityId: string | undefined,
): ShellSearchNamedTarget | undefined => {
  if (index === undefined) {
    return undefined;
  }
  const entry = entryOf(index, ref);
  const system = systemOf(index, ref);
  if (entry !== undefined && system === undefined) {
    return ownerRecordTarget(index, ref, selectedLegalEntityId);
  }
  return entry === undefined && system !== undefined ? systemTarget(index, ref) : undefined;
};

/** Agendas listing this record when the owner declared them; otherwise the owning module's agendas apply. */
export const recordAgendaPaths = (
  index: ShellSearchPresentationIndex | undefined,
  ref: SearchRef,
): readonly string[] | undefined => {
  if (index === undefined) {
    return undefined;
  }
  const entry = entryOf(index, ref);
  return entry === undefined ? undefined : agendaPaths(index, entry);
};

export const shellSearchLinkTarget = (
  index: ShellSearchPresentationIndex | undefined,
  ref: SearchRef,
  title: string,
  selectedLegalEntityId: string | undefined,
): ShellSearchLinkTarget =>
  shellSearchRecordTarget(index, ref, selectedLegalEntityId) ?? {
    params: { moduleId: ref.moduleId, resourceId: ref.resourceId, resourceType: ref.resourceType },
    state: searchHitState(title),
    to: '/resources/$moduleId/$resourceType/$resourceId',
  };

/** A verified leaf refines only its already-resolved owner destination, never another owner or product. */
export const shellSearchResultTarget = (
  result: ShellSearchResult,
  index: ShellSearchPresentationIndex | undefined,
): ShellSearchLinkTarget => {
  const { ref } = result;
  if (index !== undefined) {
    const entry = entryOf(index, ref);
    const system = systemOf(index, ref);
    if (entry !== undefined && system === undefined) {
      const selectedLegalEntityId = selectedCompanyOf(result);
      const matchedVariantId = refinementOf(result, entry);
      const baseSubject = { recordId: ref.resourceId };
      const withCompany = selectedLegalEntityId === undefined ? baseSubject : { ...baseSubject, selectedLegalEntityId };
      const subject = matchedVariantId === undefined ? withCompany : { ...withCompany, matchedVariantId };
      const target = recordTarget(index, entry, subject);
      if (target !== undefined) {
        return target;
      }
    } else if (entry === undefined && system !== undefined) {
      const target = systemTarget(index, ref);
      if (target !== undefined) {
        return target;
      }
    }
  }
  return {
    params: { moduleId: ref.moduleId, resourceId: ref.resourceId, resourceType: ref.resourceType },
    state: searchHitState(result.title),
    to: '/resources/$moduleId/$resourceType/$resourceId',
  };
};

/** The groups the validated inventory declares, ordered by the owner's declared order. */
export const shellSearchGroups = (
  index: ShellSearchPresentationIndex | undefined,
): readonly ShellSearchGroupPresentation[] => {
  if (index === undefined) {
    return [];
  }
  const groups = new Map<
    string,
    { readonly group: ShellSearchGroupPresentation; readonly resourceTypes: Set<string> }
  >();
  for (const entry of index.business) {
    const observed = groupPresentation(entry);
    const current = groups.get(observed.key);
    if (current === undefined) {
      groups.set(observed.key, { group: observed, resourceTypes: new Set(observed.resourceTypes) });
    } else {
      current.resourceTypes.add(entry.resourceType);
    }
  }
  return [...groups.values()]
    .map(({ group, resourceTypes }) => ({ ...group, resourceTypes: [...resourceTypes] }))
    .toSorted((left, right) => left.order - right.order || left.key.localeCompare(right.key));
};

/** The one group of a hit; a genuinely unpresented type stays in the generic group. */
export const shellSearchGroupOf = (
  result: Pick<ShellSearchResult, 'kind' | 'ref'>,
  index: ShellSearchPresentationIndex | undefined,
): ShellSearchGroupPresentation => {
  if (index === undefined) {
    return genericGroup;
  }
  const entry = entryOf(index, result.ref);
  if (entry !== undefined) {
    return groupPresentation(entry);
  }
  // The separate Core-system branch carries its own declared family/group metadata; it never becomes a business page.
  const system = systemOf(index, result.ref);
  return system === undefined
    ? genericGroup
    : {
        icon: system.group.icon,
        key: system.group.key,
        label: system.group.label,
        order: system.group.order,
        resourceTypes: [system.resourceType],
      };
};

/**
 * The exact `resourceTypes` request filter for the given groups. An unknown or unresolved group contributes no type;
 * the caller decides whether that is an explicit empty request rather than broadening the payload.
 */
export const shellSearchResourceTypesForGroups = (
  index: ShellSearchPresentationIndex | undefined,
  groups: readonly string[],
): readonly string[] => {
  if (index === undefined || groups.length === 0) {
    return [];
  }
  const selected = new Set(groups);
  const resourceTypes: string[] = [];
  const seen = new Set<string>();
  for (const entry of index.business) {
    if (selected.has(entry.presentation.group.key) && !seen.has(entry.resourceType)) {
      seen.add(entry.resourceType);
      resourceTypes.push(entry.resourceType);
    }
  }
  if (index.system !== undefined && selected.has(index.system.group.key) && !seen.has(index.system.resourceType)) {
    resourceTypes.push(index.system.resourceType);
  }
  return resourceTypes;
};

/** The families the validated inventory declares, each with its own groups and exact resource types. */
export const shellSearchFamilies = (
  index: ShellSearchPresentationIndex | undefined,
): readonly ShellSearchFamilyPresentation[] => {
  if (index === undefined) {
    return [];
  }
  const families = new Map<
    string,
    {
      readonly groups: Map<
        string,
        { readonly presentation: ShellSearchGroupPresentation; readonly resourceTypes: Set<string> }
      >;
      readonly icon: IconType;
      readonly key: string;
      readonly label: CoreShellLabel;
      readonly order: number;
    }
  >();
  const metadata = [
    ...index.business.map((entry) => ({ ...entry.presentation, resourceType: entry.resourceType })),
    ...(index.system === undefined
      ? []
      : [{ family: index.system.family, group: index.system.group, resourceType: index.system.resourceType }]),
  ];
  for (const { family, group, resourceType } of metadata) {
    const current = families.get(family.key);
    const target = current ?? {
      groups: new Map<
        string,
        { readonly presentation: ShellSearchGroupPresentation; readonly resourceTypes: Set<string> }
      >(),
      icon: family.icon,
      key: family.key,
      label: family.label,
      order: family.order,
    };
    families.set(family.key, target);
    const observed = target.groups.get(group.key);
    if (observed === undefined) {
      target.groups.set(group.key, {
        presentation: { ...group, resourceTypes: [resourceType] },
        resourceTypes: new Set([resourceType]),
      });
    } else {
      observed.resourceTypes.add(resourceType);
    }
  }
  return [...families.values()]
    .map(({ groups, ...family }) => {
      const orderedGroups = [...groups.values()]
        .map(({ presentation, resourceTypes: groupTypes }) => ({
          ...presentation,
          resourceTypes: [...groupTypes],
        }))
        .toSorted((left, right) => left.order - right.order || left.key.localeCompare(right.key));
      const resourceTypes: string[] = [];
      const seen = new Set<string>();
      for (const group of orderedGroups) {
        for (const resourceType of group.resourceTypes) {
          if (!seen.has(resourceType)) {
            seen.add(resourceType);
            resourceTypes.push(resourceType);
          }
        }
      }
      return { ...family, groups: orderedGroups, resourceTypes };
    })
    .toSorted((left, right) => left.order - right.order || left.key.localeCompare(right.key));
};

/** The given family keys in the inventory's declared order; unknown keys never become a selection. */
export const shellSearchFamiliesInOrder = (
  families: readonly string[],
  available: readonly ShellSearchFamilyPresentation[],
): readonly string[] => {
  const requested = new Set(families);
  const ordered: string[] = [];
  for (const { key } of available) {
    if (requested.has(key)) {
      ordered.push(key);
    }
  }
  return ordered;
};
