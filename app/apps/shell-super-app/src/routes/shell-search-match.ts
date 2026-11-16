import { Option, Predicate, Schema } from 'effect';

import type { ShellSearchResult } from '../../shared/browser-api.ts';
import { shellSearchFamilies, shellSearchFamiliesInOrder } from './shell-search-resource-types.ts';
import type { ShellSearchFamilyPresentation, ShellSearchPresentationIndex } from './shell-search-resource-types.ts';

/**
 * Presentation helpers shared by the header palette and the full results page: a Unicode-exact title highlight, the
 * record families a person can narrow the search by, and the at most two badges a result row may show.
 *
 * Everything here is pure and describes only what the Shell already received. It never re-orders hits, never counts
 * them, and never invents a match reason: relevance order and match evidence stay with the owning search provider.
 */

/** Combining marks removed by the owner search normalizer, so "Dvořáková" and "dvorakova" are the same match. */
const combiningMarks = /\p{M}+/gu;

/** One run of the title. `start` is its UTF-16 offset in the title, so runs always reassemble it exactly. */
export interface ShellSearchTitleSegment {
  readonly matched: boolean;
  readonly start: number;
  readonly text: string;
}

export interface ShellSearchMatchRange {
  readonly end: number;
  readonly start: number;
}

/**
 * The title folded exactly as Core folds search text: decompose, remove combining marks, compose, then lowercase the
 * whole string. Lowercasing the whole string (not one code point at a time) keeps Greek final sigma context-sensitive.
 */
const normalizeCoreSearchText = (value: string): string =>
  value.normalize('NFKD').replaceAll(combiningMarks, '').normalize('NFKC').toLocaleLowerCase('und');

/** Grapheme clusters keep a base character and its combining marks together, including at the end of a title. */
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/**
 * The title with every folded UTF-16 unit traced back to the grapheme cluster it came from. The folded text is the
 * whole-string Core normalization; the cluster lengths only provide the mapping. That way a match on the base of
 * "i" + combining acute highlights the whole grapheme, a ligature match widens to its own character, and surrogate
 * pairs keep their original offsets.
 */
interface FoldedText {
  readonly ends: readonly number[];
  readonly folded: string;
  readonly starts: readonly number[];
}

const foldText = (value: string): FoldedText => {
  const folded = normalizeCoreSearchText(value);
  const clusters = [...graphemeSegmenter.segment(value)];
  const ends: number[] = [];
  const starts: number[] = [];
  let cursor = 0;
  for (const { index, segment } of clusters) {
    const width = normalizeCoreSearchText(segment).length;
    const clusterEnd = index + segment.length;
    for (let unit = 0; unit < width && cursor < folded.length; unit += 1) {
      starts.push(index);
      ends.push(clusterEnd);
      cursor += 1;
    }
  }
  if (cursor === folded.length) {
    return { ends, folded, starts };
  }
  // A context-sensitive case expansion changed the length. Keep every remaining unit highlightable as the whole title
  // rather than mapping a folded character to a record character it did not come from.
  while (starts.length < folded.length) {
    starts.push(0);
    ends.push(value.length);
  }
  return { ends, folded, starts };
};

/** The search's own tokens in folded form: the person may type several words for one record. */
const queryTokens = (query: string): readonly string[] =>
  foldText(query)
    .folded.split(/\s+/u)
    .filter((token) => token.length > 0);

const mergeRanges = (ranges: readonly ShellSearchMatchRange[]): readonly ShellSearchMatchRange[] => {
  const sorted = ranges.toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: ShellSearchMatchRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) {
        merged.pop();
        merged.push({ end: range.end, start: last.start });
      }
      continue;
    }
    merged.push(range);
  }
  return merged;
};

/**
 * The title ranges a query matches, in title offsets. Only the title is highlighted: a match the owner found in a
 * hidden field must not be pointed at. An empty or unmatched query yields no ranges, so nothing is highlighted.
 */
export const shellSearchTitleMatchRanges = (title: string, query: string): readonly ShellSearchMatchRange[] => {
  const tokens = queryTokens(query);
  if (title.length === 0 || tokens.length === 0) {
    return [];
  }
  const folded = foldText(title);
  const ranges: ShellSearchMatchRange[] = [];
  for (const token of tokens) {
    let index = folded.folded.indexOf(token);
    while (index !== -1) {
      const start = folded.starts[index];
      const end = folded.ends[index + token.length - 1];
      if (start !== undefined && end !== undefined) {
        ranges.push({ end, start });
      }
      // Advance one unit, not the token length, so overlapping matches ("ana" in "banana") are all found.
      index = folded.folded.indexOf(token, index + 1);
    }
  }
  return mergeRanges(ranges);
};

/** The title cut into plain and matched runs for a native `<mark>`, without changing one character of the title. */
export const shellSearchTitleSegments = (title: string, query: string): readonly ShellSearchTitleSegment[] => {
  const ranges = shellSearchTitleMatchRanges(title, query);
  if (ranges.length === 0) {
    return title.length === 0 ? [] : [{ matched: false, start: 0, text: title }];
  }
  const segments: ShellSearchTitleSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ matched: false, start: cursor, text: title.slice(cursor, range.start) });
    }
    segments.push({ matched: true, start: range.start, text: title.slice(range.start, range.end) });
    cursor = range.end;
  }
  const rest = title.slice(cursor);
  if (rest.length > 0) {
    segments.push({ matched: false, start: cursor, text: rest });
  }
  return segments;
};

export interface ShellSearchFamilyAvailability {
  readonly family: ShellSearchFamilyPresentation;
  readonly key: string;
}

export interface ShellSearchFilterPlan {
  readonly availableFamilies: readonly ShellSearchFamilyAvailability[];
  /** Absent omits the field; an empty list is the server's explicit "no type". */
  readonly resourceTypes?: readonly string[];
  readonly selectedFamilies: readonly string[];
}

/**
 * The filter plan for one validated answer inventory. Available families are the families the captured inventory
 * declares for this answer, and the request types are exactly those families' declared resource types — a selection
 * is always a fresh server request, never a filter over an answer already received. A family the inventory does not
 * contain is unresolved: it asks for no type at all instead of broadening the request to every type. A partial answer
 * offers no filter and never guesses a payload.
 */
export const planShellSearchFilters = ({
  index,
  partial,
  requestedFamilies,
}: {
  readonly index: ShellSearchPresentationIndex | undefined;
  readonly partial: boolean;
  readonly requestedFamilies: readonly string[];
}): ShellSearchFilterPlan => {
  const emptyPlan: ShellSearchFilterPlan = { availableFamilies: [], selectedFamilies: [] };
  if (partial) {
    return emptyPlan;
  }
  const availableFamilies = shellSearchFamilies(index).map((family): ShellSearchFamilyAvailability => ({
    family,
    key: family.key,
  }));
  const availableKeys = new Set(availableFamilies.map(({ key }) => key));
  const selectedFamilies = shellSearchFamiliesInOrder(
    requestedFamilies,
    availableFamilies.map(({ family }) => family),
  );
  if (requestedFamilies.length === 0 || selectedFamilies.length === 0) {
    // An unknown-only selection resolves to no owner type; it must not widen to the unfiltered answer.
    const unresolved = requestedFamilies.some((family) => !availableKeys.has(family));
    return unresolved
      ? { availableFamilies, resourceTypes: [], selectedFamilies }
      : { availableFamilies, selectedFamilies: [] };
  }
  if (requestedFamilies.some((family) => !availableKeys.has(family))) {
    return { availableFamilies, resourceTypes: [], selectedFamilies };
  }
  const selected = new Set(selectedFamilies);
  const resourceTypes: string[] = [];
  const seen = new Set<string>();
  for (const { family, key } of availableFamilies) {
    if (!selected.has(key)) {
      continue;
    }
    for (const resourceType of family.resourceTypes) {
      if (!seen.has(resourceType)) {
        seen.add(resourceType);
        resourceTypes.push(resourceType);
      }
    }
  }
  return { availableFamilies, resourceTypes, selectedFamilies };
};

export const toggleShellSearchFamily = (families: readonly string[], family: string): readonly string[] =>
  families.includes(family) ? families.filter((selected) => selected !== family) : [...families, family];

export { shellSearchFamiliesInOrder } from './shell-search-resource-types.ts';

export const MAXIMUM_SHELL_SEARCH_RESULT_BADGES = 2;

export interface ShellSearchResultBadge {
  /** Stable React key. */
  readonly key: string;
  /** An existing `shell.search.*` translation key; the row translates it. */
  readonly labelKey: string;
  readonly tone: 'info' | 'warning';
}

/** The only two generic resource fields the current owner wire approves showing; no prefix or lifecycle inspection. */
export interface ShellSearchResourceFields {
  readonly archived?: boolean;
  readonly subtitle?: string;
}

const approvedResourceSubtitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

interface MutableResourceFields {
  archived?: boolean;
  subtitle?: string;
}

/**
 * Reads only the two approved optional resource presentation fields. They arrive as owner-public data; the Shell never
 * derives prefix, lifecycle, module or resource knowledge from them. A malformed value is simply not shown.
 */
export const shellSearchResourceFields = (result: ShellSearchResult): ShellSearchResourceFields => {
  if (result.kind !== 'resource') {
    return {};
  }
  const fields: MutableResourceFields = {};
  if (Predicate.hasProperty(result, 'archived') && Schema.is(Schema.Boolean)(result.archived)) {
    fields.archived = result.archived;
  }
  if (Predicate.hasProperty(result, 'subtitle')) {
    const decoded = Schema.decodeUnknownOption(approvedResourceSubtitle)(result.subtitle);
    if (Option.isSome(decoded)) {
      fields.subtitle = decoded.value;
    }
  }
  return fields;
};

interface ResultPartyFlags {
  readonly archived: boolean;
  readonly matchedViaAlias: boolean;
}

/** The Party side of a hit: a customer or supplier result carries its Party, a Party hit is its own. */
const partyOf = (result: ShellSearchResult): ResultPartyFlags | undefined => {
  if (result.kind === 'resource') {
    return undefined;
  }
  return result.kind === 'counterparty' ? result.party : result;
};

/**
 * At most two badges per row, in the order that changes what a person does next: something needs reconciling, the
 * record is archived, the hit came through an alias, then the Party's role in the selected company. Every badge is
 * derived from a field the owner already published; nothing is deduced from the query.
 */
export const shellSearchResultBadges = (result: ShellSearchResult): readonly ShellSearchResultBadge[] => {
  const badges: ShellSearchResultBadge[] = [];
  if (result.kind === 'counterparty' && result.collision !== undefined) {
    badges.push({ key: 'reconciliationRequired', labelKey: 'shell.search.reconciliation_required', tone: 'warning' });
  }
  const party = partyOf(result);
  // One archived badge for both the Party flag and the owner-approved generic resource field, with the same wording.
  if (party?.archived === true || shellSearchResourceFields(result).archived === true) {
    badges.push({ key: 'archived', labelKey: 'shell.search.archived', tone: 'warning' });
  }
  if (party?.matchedViaAlias === true) {
    badges.push({ key: 'aliasMatch', labelKey: 'shell.search.alias_match', tone: 'info' });
  }
  if (result.kind === 'counterparty') {
    for (const role of result.currentRoles) {
      badges.push({ key: `role:${role}`, labelKey: `shell.search.roles.${role}`, tone: 'info' });
    }
  }
  return badges.slice(0, MAXIMUM_SHELL_SEARCH_RESULT_BADGES);
};

/** The kind-independent identity of a hit: one row per record, in the order the provider returned them. */
export const shellSearchResultKey = ({ ref }: Pick<ShellSearchResult, 'ref'>): string =>
  `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`;
