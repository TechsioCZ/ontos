// @rstest-environment happy-dom
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import type { ReactElement } from 'react';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import { CounterpartyReadApi, CounterpartyReadResponseSchema } from '../../shared/apis/counterparty-read.ts';
import { PartyDetailApi } from '../../shared/apis/party-detail.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';
import { partyRegistryCommandsApi } from '../../shared/command-api.ts';
import type { UpdatePartyPayloadSchema } from '../../shared/command-api.ts';
import { partyCommandSchemaErrorLive } from '../../api/party-command-problems.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { partyRegistryI18nResources } from '../../src/i18n/resources.ts';
import type { CustomerDetailSnapshot } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import { CustomerDetailDialog } from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-dialog.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';
import { expectHumanReadable } from '../support/visible-text.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const instant = '2026-10-15T10:00:00.000Z';
const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: partyId,
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const customer = Schema.decodeSync(CustomerListItemSchema)({
  city: null,
  companyId: null,
  counterpartyId,
  counterpartyRef,
  createdAt: instant,
  displayName: 'Before',
  email: null,
  partyId,
  partyRef,
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
});
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  businessName: 'Before',
  createdAt: instant,
  displayName: 'Before',
  firstName: null,
  lastName: null,
  partyRef,
  partyType: 'ORGANIZATION',
  revision: 1,
  updatedAt: instant,
});
const snapshot: CustomerDetailSnapshot = {
  contacts: { status: 'ready', value: { items: [] } },
  counterparty: Schema.decodeSync(CounterpartyReadResponseSchema)({
    counterpartyRef,
    createdAt: instant,
    currentRoles: [],
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    party: {
      archived: false,
      canonicalPartyRef: partyRef,
      displayName: 'Before',
      partyType: 'ORGANIZATION',
      storedPartyRef: partyRef,
    },
  }),
  identifiers: { status: 'ready', value: { items: [] } },
  identity: {
    status: 'ready',
    value: {
      currentFactAssertions: [],
      party,
      resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
    },
  },
  now: DateTime.makeUnsafe(instant),
};
const closed: boolean[] = [];
const commands: (typeof UpdatePartyPayloadSchema.Encoded)[] = [];
const afterParty = { ...party, displayName: Option.some('After'), revision: 2 };
const OwnerCommand = HttpApi.make('PartyRegistryCommandsApi')
  .add(HttpApiGroup.make('partyCommands').add(partyRegistryCommandsApi.groups.partyCommands.endpoints.updateParty))
  .prefix('/party-registry-api');
const OwnerCounterparty = CounterpartyReadApi.prefix('/party-registry-api');
const OwnerIdentity = PartyDetailApi.prefix('/party-registry-api');
const OwnerContacts = PartyContactPointsApi.prefix('/party-registry-api');
const OwnerIdentifiers = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    OwnerCommand,
    HttpApiBuilder.group(OwnerCommand, 'partyCommands', (g) =>
      g.handle('updateParty', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return afterParty;
        }),
      ),
    ).pipe(Layer.provide(partyCommandSchemaErrorLive)),
  ),
  serveApi(
    OwnerCounterparty,
    HttpApiBuilder.group(OwnerCounterparty, 'counterpartyRead', (g) =>
      g.handle('execute', () => Effect.succeed(snapshot.counterparty)),
    ),
  ),
  serveApi(
    OwnerIdentity,
    HttpApiBuilder.group(OwnerIdentity, 'partyDetail', (g) =>
      g.handle('execute', () =>
        Effect.succeed({
          currentFactAssertions: [],
          party: afterParty,
          resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
        }),
      ),
    ),
  ),
  serveApi(
    OwnerContacts,
    HttpApiBuilder.group(OwnerContacts, 'partyContactPoints', (g) =>
      g.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
  serveApi(
    OwnerIdentifiers,
    HttpApiBuilder.group(OwnerIdentifiers, 'partyOfficialIdentifierHistory', (g) =>
      g.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
);
const copy = moduleText('cs', partyRegistryI18nResources);
const mount = (element: ReactElement) =>
  mountInRoute(element, {
    path: 'prodej/zakaznici',
    resources: partyRegistryI18nResources,
    url: '/cs/prodej/zakaznici',
  });
beforeEach(() => {
  closed.length = 0;
  commands.length = 0;
});
afterEach(unmountAll);
const noop = () => {};
const detailDialog = (value?: CustomerDetailSnapshot) => (
  <CustomerDetailDialog
    customer={customer}
    onOpenChange={(open) => {
      closed.push(open);
    }}
    onRenamed={noop}
    onRetry={noop}
    snapshot={value}
  />
);
const fieldById = <T extends HTMLElement>(id: string) => {
  const element = document.querySelector<T>(`[id="${id}"]`);
  if (element === null) {
    throw new Error(`missing field ${id}`);
  }
  return element;
};
const reasonField = () => fieldById<HTMLInputElement>('customer-reason');
const nameField = () => fieldById<HTMLInputElement>('customer-rename');
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Uložit' });
const fillBasis = () => {
  fireEvent.change(fieldById<HTMLInputElement>('customer-evidence'), { target: { value: 'document:42' } });
  fireEvent.change(reasonField(), { target: { value: 'Reviewed document' } });
};

it.layer(network, { excludeTestServices: true })('customer detail state', (suite) => {
  suite.effect('shows the customer name without exposing party or business-context identifiers', () =>
    Effect.gen(function* readableIdentity() {
      yield* pinTestDocument;
      yield* mount(detailDialog(snapshot));
      expect(screen.getByRole('heading', { name: 'Before' })).toBeTruthy();
      expect(document.body.textContent).not.toContain(partyId);
      expect(document.body.textContent).not.toContain(counterpartyId);
      expectHumanReadable();
    }),
  );

  suite.effect('keeps the typed reason when the same customer snapshot passes through a loading refresh', () =>
    Effect.gen(function* loadingRefresh() {
      yield* pinTestDocument;
      const { rerender } = yield* mount(detailDialog(snapshot));
      yield* acted(() => {
        fireEvent.change(reasonField(), { target: { value: 'Reviewed document' } });
      });
      yield* rerender(detailDialog());
      yield* rerender(detailDialog(snapshot));
      expect(reasonField().value).toBe('Reviewed document');
    }),
  );

  suite.effect('typing and waiting write nothing until the one Save button is pressed', () =>
    Effect.gen(function* explicitSave() {
      yield* pinTestDocument;
      yield* mount(detailDialog(snapshot));
      yield* acted(() => {
        fillBasis();
        fireEvent.change(nameField(), { target: { value: 'After' } });
      });
      yield* Effect.sleep('1 second');
      yield* networkIdle;
      expect(commands).toHaveLength(0);
      expect(saveButton().disabled).toBe(false);
      yield* acted(() => {
        fireEvent.click(saveButton());
      });
      yield* waitUntil(() => commands.length === 1);
      expect(commands).toHaveLength(1);
      yield* waitUntil(() =>
        ['idle', 'saved'].includes(
          document.querySelector<HTMLElement>('[data-save-state]')?.dataset['saveState'] ?? '',
        ),
      );
      expect(['idle', 'saved']).toContain(
        document.querySelector<HTMLElement>('[data-save-state]')?.dataset['saveState'],
      );
      expect(saveButton().disabled).toBe(true);
      yield* networkIdle;
      expect(commands).toHaveLength(1);
    }),
  );

  suite.effect('an empty name leaves Save disabled and writes nothing', () =>
    Effect.gen(function* invalidDraft() {
      yield* pinTestDocument;
      yield* mount(detailDialog(snapshot));
      yield* acted(() => {
        fillBasis();
        fireEvent.change(nameField(), { target: { value: '' } });
      });
      yield* Effect.sleep('1 second');
      expect(saveButton().disabled).toBe(true);
      yield* networkIdle;
      expect(commands).toHaveLength(0);
    }),
  );

  suite.effect('closing with unsaved text asks first and leaving discards without writing', () =>
    Effect.gen(function* leaveAsks() {
      yield* pinTestDocument;
      yield* mount(detailDialog(snapshot));
      yield* acted(() => {
        fillBasis();
        fireEvent.change(nameField(), { target: { value: 'After' } });
        fireEvent.click(screen.getByText(copy('party-registry.pages.customers.detail.cancel'), { selector: 'button' }));
      });
      expect(closed).toHaveLength(0);
      yield* waitUntil(() => screen.queryByRole('button', { name: 'Zůstat' }) !== null);
      expect(screen.getByRole('button', { name: 'Zůstat' })).toBeTruthy();
      yield* acted(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Zahodit změny' }));
      });
      yield* waitUntil(() => closed.length > 0);
      yield* networkIdle;
      expect(closed).toContain(false);
      expect(commands).toHaveLength(0);
    }),
  );

  suite.effect('a route change from the peek panel with unsaved text asks first; Zůstat keeps the draft', () =>
    Effect.gen(function* routeChangeAsks() {
      yield* pinTestDocument;
      const { router } = yield* mount(detailDialog(snapshot));
      // A clean panel lets the real router navigate without a leave question.
      yield* acted(() => {
        router.history.push('/cs/prodej/zakaznici?clean=1');
      });
      yield* waitUntil(() => router.state.location.searchStr === '?clean=1');
      expect(screen.queryByRole('button', { name: 'Zůstat' })).toBeNull();
      yield* acted(() => {
        fillBasis();
        fireEvent.change(nameField(), { target: { value: 'After' } });
      });
      yield* acted(() => {
        router.history.push('/cs/prodej/zakaznici?next=1');
      });
      yield* waitUntil(() => screen.queryByRole('button', { name: 'Zůstat' }) !== null);
      expect(router.state.location.searchStr).toBe('?clean=1');
      expect(screen.getByRole('button', { name: 'Zůstat' })).toBeTruthy();
      yield* acted(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Zůstat' }));
      });
      // Reset resolves the pending navigation and closes its question; proceeding would change the URL.
      expect(screen.queryByRole('button', { name: 'Zůstat' })).toBeNull();
      expect(router.state.location.searchStr).toBe('?clean=1');
      expect(nameField().value).toBe('After');
      yield* networkIdle;
      expect(commands).toHaveLength(0);
    }),
  );
});
