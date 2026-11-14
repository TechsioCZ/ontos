import { cleanup, render, screen } from '@testing-library/react';
import type { CoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import type { ShellSearchResult } from '../../../shared/browser-api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../../shared/browser-api.ts';
import type { ShellSearchResultLinkComponent } from '../../../src/routes/shell-search-result-row.tsx';
import { ShellSearchResultRow } from '../../../src/routes/shell-search-result-row.tsx';
import type { ShellSearchPresentationIndex } from '../../../src/routes/shell-search-resource-types.ts';
import { shellSearchPresentationIndex } from '../../../src/routes/shell-search-resource-types.ts';

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
const compositionRevision = 'a'.repeat(64);
const partyRef = {
  moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
  resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000301'),
  resourceType: 'party.registry.party',
  tenantId,
};
const counterpartyId = '00000000-0000-4000-8000-000000000302';

/** A hit shaped exactly like the counterparty rows the Shell shows, so the badge joins the title in the same order. */
const counterparty = (title: string): ShellSearchResult => ({
  currentRoles: ['CUSTOMER'],
  kind: 'counterparty',
  legalEntity: { legalEntityId, tenantId },
  party: { archived: false, matchedViaAlias: false, ref: partyRef, title },
  ref: {
    ...partyRef,
    resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(counterpartyId),
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

/** The owner's declared record binding: the counterparty opens its own customers page by its path ID. */
const counterpartyEntry: CoreSearchPresentationEntry = {
  ownerModuleId: 'party.registry',
  presentation: {
    family: { icon: 'icon-[mdi--file-outline]', key: 'companies', label: { cs: 'Firmy', en: 'Companies' }, order: 10 },
    group: {
      icon: 'icon-[mdi--file-outline]',
      key: 'counterparty',
      label: { cs: 'Protiúčty', en: 'Counterparties' },
      order: 10,
    },
    record: {
      pageKey: 'customers',
      selector: { idEncoding: 'native', idFormat: 'opaque', kind: 'path', parameterName: 'id' },
    },
    scope: 'company',
  },
  resourceType: 'party.registry.counterparty',
  searchKey: 'party.registry.search.counterparty',
};

const indexFor = (revision: string): ShellSearchPresentationIndex | undefined =>
  shellSearchPresentationIndex(
    {
      business: { compositionRevision: revision, entries: [counterpartyEntry], schemaVersion: '1' },
      pages: [
        {
          ownerModuleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
          pageKey: 'customers',
          routePath: '/prodej/zakaznici/:id',
        },
      ],
    },
    compositionRevision,
  );

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

it('names a row exactly as the visible title when a match splits a word and adds the type label', () => {
  render(<ShellSearchResultRow query="dvor" result={counterparty('Jana Dvořáková')} ResultLink={ResultLink} />);

  // The highlight still splits "Dvoř|áková" in the DOM; the accessible name is the record title, not the split text.
  const link = screen.getByRole('link', { name: 'Jana Dvořáková Customer' });
  expect(link.tagName).toBe('A');
  expect(link.querySelector('mark')?.textContent).toBe('Dvoř');
  expect(link.textContent).toBe('Jana DvořákováCustomer');
  expect(screen.queryByRole('link', { name: /Dvoř áková/u })).toBeNull();
});

it('names a decomposed Unicode title whole when the match covers a combining mark', () => {
  const title = 'Jana Dvořáková';
  render(<ShellSearchResultRow query="dvor" result={counterparty(title)} ResultLink={ResultLink} />);

  const link = screen.getByRole('link', { name: `${title} Customer` });
  expect(link.querySelector('mark')?.textContent).toBe('Dvoř');
  expect(link.textContent).toBe(`${title}Customer`);
});

it('names a row from the same context line and badges it shows, in order', () => {
  render(
    <ShellSearchResultRow
      presentation={{ subtitle: 'Prague', typeLabel: 'Customers and suppliers' }}
      query="dvor"
      result={counterparty('Jana Dvořáková')}
      ResultLink={ResultLink}
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
    />,
  );

  const link = screen.getByRole('link', { name: 'Jana Dvořáková Customer' });
  expect(link.dataset['searchSuggestion']).toBe('');
  expect(link.getAttribute('tabindex')).toBe('-1');
  expect(link.querySelector('mark')).toBeNull();
});

it('opens the record at its owner page from the current presentation index', () => {
  render(
    <ShellSearchResultRow
      index={indexFor(compositionRevision)}
      query="dvor"
      result={counterparty('Jana Dvořáková')}
      ResultLink={ResultLink}
    />,
  );

  expect(screen.getByRole('link', { name: 'Jana Dvořáková Customer' }).getAttribute('href')).toBe(
    `/en/prodej/zakaznici/${counterpartyId}`,
  );
});

it('falls back to the Shell record page when the inventory was captured for another revision', () => {
  render(
    <ShellSearchResultRow
      index={indexFor('b'.repeat(64))}
      query="dvor"
      result={counterparty('Jana Dvořáková')}
      ResultLink={ResultLink}
    />,
  );

  expect(indexFor('b'.repeat(64))).toBeUndefined();
  expect(screen.getByRole('link', { name: 'Jana Dvořáková Customer' }).getAttribute('href')).toBe(
    `/en/resources/party.registry/party.registry.counterparty/${counterpartyId}`,
  );
});
