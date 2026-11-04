import { cleanup, render, screen } from '@testing-library/react';
import { Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import type { ShellSearchResult } from '../../../shared/api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../../shared/api.ts';
import type { ShellSearchResultLinkComponent } from '../../../src/routes/shell-search-result-row.tsx';
import { ShellSearchResultRow } from '../../../src/routes/shell-search-result-row.tsx';
import { searchHitState } from '../../../src/routes/search-hit-state.ts';
import {
  shellSearchPresentationContext,
  shellSearchResultTarget,
} from '../../../src/routes/shell-search-resource-types.ts';
import type { ShellSearchLinkTarget } from '../../../src/routes/shell-search-resource-types.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => {
  const translations: ReadonlyMap<string, string> = new Map([
    ['shell.search.archived', 'Archived'],
    ['shell.search.roles.CUSTOMER', 'Customer'],
    ['shell.search.roles.SUPPLIER', 'Supplier'],
  ]);
  return {
    useModernI18n: () => ({ language: 'en', t: (key: string) => translations.get(key) ?? key }),
  };
});

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
const partyRef = {
  moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
  resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000301'),
  resourceType: 'party.registry.party',
  tenantId,
};

/** A hit shaped exactly like the counterparty rows the Shell shows, so the badge joins the title in the same order. */
const counterparty = (title: string): ShellSearchResult => ({
  currentRoles: ['CUSTOMER'],
  kind: 'counterparty',
  legalEntity: { legalEntityId, tenantId },
  party: { archived: false, matchedViaAlias: false, ref: partyRef, title },
  ref: {
    ...partyRef,
    resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000302'),
    resourceType: 'party.registry.counterparty',
  },
  title,
});

/** The smallest route link double: it resolves the canonical target exactly the way the Shell link does. */
const ResultLink: ShellSearchResultLinkComponent = ({
  children,
  params,
  search,
  state: _state,
  to,
  ...anchorProps
}) => {
  let path = to;
  for (const [name, value] of Object.entries(params ?? {})) {
    path = path.replaceAll(`$${name}`, encodeURIComponent(String(value ?? '')));
  }
  const query = new URLSearchParams(
    Object.entries(search ?? {}).map(([name, value]) => [name, String(value)]),
  ).toString();
  const suffix = query === '' ? '' : `?${query}`;
  return (
    <a {...anchorProps} href={`/en${path}${suffix}`}>
      {children}
    </a>
  );
};

/**
 * The composed navigation a loaded Shell document has: the destinations the record types of these tests open. The
 * row receives the target the caller resolved from it; the row itself never guesses one.
 */
const presentation = shellSearchPresentationContext([
  { groupKey: 'shell.navigation.sales', href: '/crm/klienti', moduleId: 'demo.crm' },
  { groupKey: 'shell.navigation.finance', href: '/finance', moduleId: 'finance.billing' },
]);

/** A generic owner hit of a composed module. */
const resourceHit = (moduleId: string, resourceType: string, title: string): ShellSearchResult => ({
  kind: 'resource',
  ref: {
    moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId),
    resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000401'),
    resourceType,
    tenantId,
  },
  selectedLegalEntityId: legalEntityId,
  title,
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

/** A fixed generic target: naming a row must not depend on which owner route its record type happens to open. */
const shellRecordTarget: ShellSearchLinkTarget = {
  params: { moduleId: 'party.registry', resourceId: 'record-1', resourceType: 'party.registry.counterparty' },
  state: searchHitState('Eva Bílá'),
  to: '/resources/$moduleId/$resourceType/$resourceId',
};

it('names a row exactly as the visible title when a match splits a word and adds the type label', () => {
  render(
    <ShellSearchResultRow
      query="dvor"
      result={counterparty('Jana Dvořáková')}
      ResultLink={ResultLink}
      target={shellRecordTarget}
    />,
  );

  // The highlight still splits "Dvoř|áková" in the DOM; the accessible name is the record title, not the split text.
  const link = screen.getByRole('link', { name: 'Jana Dvořáková Customer' });
  expect(link.tagName).toBe('A');
  expect(link.getAttribute('href')).toBe('/en/resources/party.registry/party.registry.counterparty/record-1');
  expect(link.querySelector('mark')?.textContent).toBe('Dvoř');
  expect(link.textContent).toBe('Jana DvořákováCustomer');
  expect(screen.queryByRole('link', { name: /Dvoř áková/u })).toBeNull();
});

it('names a decomposed Unicode title whole when the match covers a combining mark', () => {
  const title = 'Jana Dvor\u030Ca\u0301kova\u0301';
  render(
    <ShellSearchResultRow
      query="dvor"
      result={counterparty(title)}
      ResultLink={ResultLink}
      target={shellRecordTarget}
    />,
  );

  const link = screen.getByRole('link', { name: `${title} Customer` });
  expect(link.querySelector('mark')?.textContent).toBe('Dvor\u030C');
  expect(link.textContent).toBe(`${title}Customer`);
});

it('names a title with an astral character whole when that character is the match', () => {
  const title = '𐐷ana Dvořáková';
  render(
    <ShellSearchResultRow
      query="𐐷ana"
      result={counterparty(title)}
      ResultLink={ResultLink}
      target={shellRecordTarget}
    />,
  );

  const link = screen.getByRole('link', { name: `${title} Customer` });
  expect(link.querySelector('mark')?.textContent).toBe('𐐷ana');
});

it('names a row from the same context line and badges it shows, in order', () => {
  render(
    <ShellSearchResultRow
      presentation={{ subtitle: 'Prague', typeLabel: 'Customers and suppliers' }}
      query="dvor"
      result={counterparty('Jana Dvořáková')}
      ResultLink={ResultLink}
      target={shellRecordTarget}
    />,
  );

  expect(screen.getByRole('link', { name: 'Jana Dvořáková Customers and suppliers Prague Customer' })).toBeTruthy();
});

it('keeps the row-owned name and the caller keyboard attributes on an unhighlighted row', () => {
  render(
    <ShellSearchResultRow
      linkProps={{ 'aria-label': 'caller', 'data-search-suggestion': '', tabIndex: -1 }}
      query=""
      result={counterparty('Jana Dvořáková')}
      ResultLink={ResultLink}
      target={shellRecordTarget}
    />,
  );

  const link = screen.getByRole('link', { name: 'Jana Dvořáková Customer' });
  expect(link.dataset['searchSuggestion']).toBe('');
  expect(link.getAttribute('tabindex')).toBe('-1');
  expect(link.querySelector('mark')).toBeNull();
  expect(link.getAttribute('href')).toBe('/en/resources/party.registry/party.registry.counterparty/record-1');
});

it('opens a CRM record at its exact owner page when the caller threads the composed target', () => {
  const contact = resourceHit('demo.crm', 'demo.crm.contact', 'Jana Dvořáková');
  render(
    <ShellSearchResultRow
      query="dvor"
      result={contact}
      ResultLink={ResultLink}
      target={shellSearchResultTarget(contact, presentation)}
    />,
  );

  expect(screen.getByRole('link', { name: 'Jana Dvořáková' }).getAttribute('href')).toBe(
    `/en/crm/klienti?osoba=${contact.ref.resourceId}`,
  );
});

it('opens a shared document record at its exact owner page when the caller threads the composed target', () => {
  const document = resourceHit('finance.billing', 'finance.billing.document', 'Doklad 2026/14');
  render(
    <ShellSearchResultRow
      query="doklad"
      result={document}
      ResultLink={ResultLink}
      target={shellSearchResultTarget(document, presentation)}
    />,
  );

  expect(screen.getByRole('link', { name: 'Doklad 2026/14' }).getAttribute('href')).toBe(
    `/en/finance?documentId=${document.ref.resourceId}`,
  );
});
