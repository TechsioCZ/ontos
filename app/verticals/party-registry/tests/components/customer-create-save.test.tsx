// @rstest-environment happy-dom
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { acted, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiBuilder, HttpApiGroup } from '@modern-js/bff-effect/effect-edge';
import { fireEvent, screen } from '@testing-library/react';
import { Deferred, Effect, Layer, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import { partyCommandSchemaErrorLive } from '../../api/party-command-problems.ts';
import { CounterpartyCustomerOnboardResultSchema } from '../../shared/actions/counterparty-customer-onboard.ts';
import type { CounterpartyCustomerOnboardPayload } from '../../shared/actions/counterparty-customer-onboard.ts';
import { CreatePartyResultSchema } from '../../shared/actions/create-party.ts';
import type { CreatePartyPayloadJsonSchema } from '../../shared/actions/create-party.ts';
import { CustomerListApi } from '../../shared/apis/customer-list.ts';
import { partyRegistryCommandsApi, PartyCommandSchemaErrorMiddleware } from '../../shared/command-api.ts';
import type { CreatedCustomer } from '../../src/api/customers-client.ts';
import { partyRegistryI18nResources } from '../../src/i18n/resources.ts';
import { CustomerCreateDialog } from '../../src/routes/[lang]/prodej/zakaznici/customer-create-dialog.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const KEY = 'party-registry.pages.customers.create';
const copy = moduleText('cs', partyRegistryI18nResources);
const labels = saveLabelsFor('cs');
const tenantId = '11111111-1111-4111-8111-111111111111';
const created = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  displayName: 'Nová firma',
  outcome: 'CREATED',
  partyRef: {
    moduleId: 'party.registry',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'party.registry.party',
    tenantId,
  },
} as const satisfies CreatedCustomer;
const partyCreated = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  decisionRef: {
    moduleId: 'party.registry',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'party.registry.party-match-decision',
    tenantId,
  },
  outcome: created.outcome,
  partyRef: created.partyRef,
});
const onboarded = Schema.decodeUnknownSync(CounterpartyCustomerOnboardResultSchema)({
  counterpartyCreated: true,
  counterpartyRef: created.counterpartyRef,
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  partyRef: created.partyRef,
  rolePeriodCreated: true,
  rolePeriodRef: {
    moduleId: 'party.registry',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'party.registry.counterparty-role-period',
    tenantId,
  },
  roleType: 'CUSTOMER',
  validFrom: '2026-10-15T10:00:00.000Z',
  validTo: null,
});

const { endpoints } = partyRegistryCommandsApi.groups.partyCommands;
const OwnerCommands = HttpApi.make('CustomerCreateCommands')
  .add(
    HttpApiGroup.make('partyCommands')
      .add(endpoints.createParty)
      .add(endpoints.counterpartyCustomerOnboard)
      .middleware(PartyCommandSchemaErrorMiddleware),
  )
  .prefix('/party-registry-api');
const OwnerReads = CustomerListApi.prefix('/party-registry-api');
const partyRequests: (typeof CreatePartyPayloadJsonSchema.Type)[] = [];
const onboardRequests: CounterpartyCustomerOnboardPayload[] = [];
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    OwnerCommands,
    HttpApiBuilder.group(OwnerCommands, 'partyCommands', (group) =>
      group
        .handle('createParty', ({ payload }) =>
          Effect.sync(() => {
            partyRequests.push(payload);
            return partyCreated;
          }),
        )
        .handle('counterpartyCustomerOnboard', ({ payload }) =>
          Effect.sync(() => {
            onboardRequests.push(payload);
            return onboarded;
          }),
        ),
    ).pipe(Layer.provide(partyCommandSchemaErrorLive)),
  ),
  serveApi(
    OwnerReads,
    HttpApiBuilder.group(OwnerReads, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
);

const field = (id: string) => {
  const element = document.querySelector<HTMLInputElement>(`#${id}`);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element;
};
const type = (id: string, value: string) =>
  acted(() => {
    fireEvent.change(field(id), { target: { value } });
  });
const button = (name: string) => screen.getByRole('button', { name });
/** The button with this text, when the confirmation has opened (it opens after a short animation). */
const findButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text);

const renderDialog = () =>
  Effect.gen(function* renderCustomerDialog() {
    const completed = yield* Deferred.make<null>();
    const createdCustomers: null[] = [];
    const openChanges: boolean[] = [];
    yield* mountInRoute(
      <CustomerCreateDialog
        existing={[]}
        onCreated={() => {
          createdCustomers.push(null);
          Deferred.doneUnsafe(completed, Effect.succeed(null));
        }}
        onOpenChange={(open) => {
          openChanges.push(open);
        }}
        onWriteRefused={constVoid}
        open
      />,
      { path: 'prodej/zakaznici', resources: partyRegistryI18nResources, url: '/cs/prodej/zakaznici' },
    );
    return { completed, createdCustomers, openChanges };
  });

beforeEach(() => {
  partyRequests.length = 0;
  onboardRequests.length = 0;
});
afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('customer create save', (suite) => {
  suite.effect('typing only changes the draft and writes nothing', () =>
    Effect.gen(function* typingChangesOnlyDraft() {
      yield* pinTestDocument;
      yield* renderDialog();
      yield* type('customer-name', 'Nová firma');
      yield* type('customer-email', 'obchod@example.test');
      expect(partyRequests).toEqual([]);
      expect(onboardRequests).toEqual([]);
      expect(button(labels.save).hasAttribute('disabled')).toBe(false);
    }),
  );

  suite.effect('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredCopyIsCzech() {
      yield* pinTestDocument;
      yield* renderDialog();
      const label = document.querySelector<HTMLLabelElement>('label[for="customer-name"]');
      expect(label?.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
    }),
  );

  suite.effect('Uložit writes exactly once', () =>
    Effect.gen(function* saveOnce() {
      yield* pinTestDocument;
      const { completed, createdCustomers } = yield* renderDialog();
      yield* type('customer-name', 'Nová firma');
      yield* acted(() => {
        fireEvent.click(button(labels.save));
      });
      yield* Deferred.await(completed);
      yield* settle;
      expect(createdCustomers).toHaveLength(1);
      expect(partyRequests).toHaveLength(1);
      expect(onboardRequests).toHaveLength(1);
    }),
  );

  suite.effect('leaving with unsaved input asks first and keeps the form on Zůstat', () =>
    Effect.gen(function* askBeforeLeaving() {
      yield* pinTestDocument;
      const { openChanges } = yield* renderDialog();
      yield* type('customer-name', 'Nová firma');
      yield* acted(() => {
        fireEvent.click(button(copy(`${KEY}.cancel`)));
      });
      yield* waitUntil(() => findButton(labels.stay) !== undefined);
      expect(findButton(labels.stay)).toBeDefined();
      expect(partyRequests).toEqual([]);
      expect(onboardRequests).toEqual([]);
      expect(openChanges).not.toContain(false);
      const stay = findButton(labels.stay);
      if (stay === undefined) {
        throw new Error('missing Zůstat');
      }
      yield* acted(() => {
        fireEvent.click(stay);
      });
      yield* waitUntil(() => findButton(labels.stay) === undefined);
      expect(findButton(labels.stay)).toBeUndefined();
      expect(openChanges).not.toContain(false);
    }),
  );
});
