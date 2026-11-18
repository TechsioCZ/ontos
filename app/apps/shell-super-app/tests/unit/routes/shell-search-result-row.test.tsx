// @rstest-environment happy-dom

import { settle } from '@app/admin-ui/testing/module-ui';
import { Link } from '@modern-js/plugin-i18n/runtime';
import { cleanup, screen } from '@testing-library/react';
import type { CoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import type { ReactNode } from 'react';

import type { ShellSearchResult } from '../../../shared/browser-api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../../shared/browser-api.ts';
import { ShellSearchResultRow } from '../../../src/routes/shell-search-result-row.tsx';
import type { ShellSearchPresentationIndex } from '../../../src/routes/shell-search-resource-types.ts';
import { shellSearchPresentationIndex } from '../../../src/routes/shell-search-resource-types.ts';
import { shellLocaleCopy } from '../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../support/shell-router.tsx';

const english = shellLocaleCopy('en');
const renderRow = (row: ReactNode) =>
  renderShellRoute(
    makeShellRouter({ page: { component: () => row, path: 'search' }, url: '/en/search' }),
    english,
  ).pipe(Effect.tap(() => settle));

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

afterEach(cleanup);

it.live('names a row exactly as the visible title when a match splits a word and adds the type label', () =>
  Effect.gen(function* highlightedName() {
    yield* renderRow(<ShellSearchResultRow query="dvor" result={counterparty('Jana Dvořáková')} ResultLink={Link} />);

    // The highlight still splits "Dvoř|áková" in the DOM; the accessible name is the record title, not the split text.
    const link = screen.getByRole('link', { name: 'Jana Dvořáková Customer' });
    expect(link.tagName).toBe('A');
    expect(link.querySelector('mark')?.textContent).toBe('Dvoř');
    expect(link.textContent).toBe('Jana DvořákováCustomer');
    expect(screen.queryByRole('link', { name: /Dvoř áková/u })).toBeNull();
  }),
);

it.live('names a decomposed Unicode title whole when the match covers a combining mark', () =>
  Effect.gen(function* decomposedName() {
    const title = 'Jana Dvořáková';
    yield* renderRow(<ShellSearchResultRow query="dvor" result={counterparty(title)} ResultLink={Link} />);

    const link = screen.getByRole('link', { name: `${title} Customer` });
    expect(link.querySelector('mark')?.textContent).toBe('Dvoř');
    expect(link.textContent).toBe(`${title}Customer`);
  }),
);

it.live('names a row from the same context line and badges it shows, in order', () =>
  Effect.gen(function* contextAndBadges() {
    yield* renderRow(
      <ShellSearchResultRow
        presentation={{ subtitle: 'Prague', typeLabel: 'Customers and suppliers' }}
        query="dvor"
        result={counterparty('Jana Dvořáková')}
        ResultLink={Link}
      />,
    );

    expect(screen.getByRole('link', { name: 'Jana Dvořáková Customers and suppliers Prague Customer' })).toBeTruthy();
  }),
);

it.live('keeps the row-owned name and the caller keyboard attributes on an unhighlighted row', () =>
  Effect.gen(function* keyboardAttributes() {
    yield* renderRow(
      <ShellSearchResultRow
        linkProps={{ 'aria-label': 'caller', 'data-search-suggestion': '', tabIndex: -1 }}
        query=""
        result={counterparty('Jana Dvořáková')}
        ResultLink={Link}
      />,
    );

    const link = screen.getByRole('link', { name: 'Jana Dvořáková Customer' });
    expect(link.dataset['searchSuggestion']).toBe('');
    expect(link.getAttribute('tabindex')).toBe('-1');
    expect(link.querySelector('mark')).toBeNull();
  }),
);

it.live('opens the record at its owner page from the current presentation index', () =>
  Effect.gen(function* ownerPage() {
    yield* renderRow(
      <ShellSearchResultRow
        index={indexFor(compositionRevision)}
        query="dvor"
        result={counterparty('Jana Dvořáková')}
        ResultLink={Link}
      />,
    );

    expect(screen.getByRole('link', { name: 'Jana Dvořáková Customer' }).getAttribute('href')).toBe(
      `/en/prodej/zakaznici/${counterpartyId}`,
    );
  }),
);

it.live('falls back to the Shell record page when the inventory was captured for another revision', () =>
  Effect.gen(function* revisionFallback() {
    yield* renderRow(
      <ShellSearchResultRow
        index={indexFor('b'.repeat(64))}
        query="dvor"
        result={counterparty('Jana Dvořáková')}
        ResultLink={Link}
      />,
    );

    expect(indexFor('b'.repeat(64))).toBeUndefined();
    expect(screen.getByRole('link', { name: 'Jana Dvořáková Customer' }).getAttribute('href')).toBe(
      `/en/resources/party.registry/party.registry.counterparty/${counterpartyId}`,
    );
  }),
);
