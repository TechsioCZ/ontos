// @rstest-environment happy-dom
// A new sales quote is created on the one shared Uložit (the former "Uložit koncept" / "Uložit odeslanou" pair is a
// status field now): one click sends the same command, sent by default, and leaving with typed input asks first.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { CustomerListApi, CustomerListResponseSchema } from '../../../party-registry/shared/apis/customer-list.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { SalesQuoteFormPanel } from '../../src/routes/[lang]/provoz/nakupy/sales-tab.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const copy = { cancel: moduleText('cs')('facility-operations.common.cancel') };
const customerId = '44444444-4444-4444-8444-444444444444';
const tenantId = '70000000-0000-4000-8000-000000000020';
const customers = Schema.decodeUnknownSync(CustomerListResponseSchema)({
  items: [
    {
      city: null,
      companyId: null,
      counterpartyId: customerId,
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: customerId,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      createdAt: '2026-11-04T08:00:00.000Z',
      displayName: 'Kavárna Dolce',
      email: null,
      partyId: 'party-1',
      partyRef: {
        moduleId: 'party.registry',
        resourceId: 'party-1',
        resourceType: 'party.registry.party',
        tenantId,
      },
      partyRevision: 1,
      phone: null,
      status: 'ACTIVE',
      vatId: null,
    },
  ],
});
const created = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: ['created-1'], revision: 2 });
const sent: (typeof ApplyCommandPayloadSchema.Encoded)['command'][] = [];
const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const PartyApi = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'party-registry': '/party-registry-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          sent.push(payload.command);
          return created;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    PartyApi,
    HttpApiBuilder.group(PartyApi, 'customerList', (group) => group.handle('execute', () => Effect.succeed(customers))),
  ),
);

const calls: string[] = [];
const mount = () =>
  mountInRoute(
    <SalesQuoteFormPanel
      onClose={() => {
        calls.push('close');
      }}
      onSaved={() => {
        calls.push('saved');
      }}
      run={(command) => runCommand(command, 1)}
    />,
    { url: '/cs/provoz/nakupy' },
  );
const customersLoaded = () => document.querySelector('select[name="sales-customer"]') !== null;
const click = (name: string) => acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click());
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const field = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const option = (value: string) => document.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
const pick = (name: string, value: string) =>
  Effect.gen(function* pickOption() {
    const select = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)),
    );
    const trigger = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLElement>(`[id="${select.id.replace(/:select$/u, ':trigger')}"]`)),
    );
    yield* acted(() => trigger.click());
    yield* waitUntil(() => option(value) !== null);
    yield* acted(() => Option.getOrThrow(Option.fromNullOr(option(value))).click());
    yield* waitUntil(() => select.value === value);
  });

const saveSent = () => click(labels.save).pipe(Effect.andThen(waitUntil(() => calls.includes('saved'))));

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
});

afterEach(unmountAll);

describe('new sales quote', () => {
  it.live('types the quote, saves once as sent and goes on', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mount();
      yield* waitUntil(customersLoaded);
      yield* pick('sales-customer', customerId);
      yield* typeInto('[id$="-0-description"]', 'Servis vzduchotechniky');
      yield* typeInto('[id$="-0-price"]', '4 500');
      yield* saveSent();
      expect(sent).toEqual([
        expect.objectContaining({
          _tag: 'SalesQuoteCreate',
          lines: [{ description: 'Servis vzduchotechniky', quantity: 1, unitPriceMinor: 450_000, vatRate: 21 }],
          status: 'sent',
        }),
      ]);
      expect(calls).toEqual(['saved']);
    }).pipe(Effect.provide(network)),
  );

  it.live('kept as a draft when the status says so', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mount();
      yield* waitUntil(customersLoaded);
      yield* pick('sales-customer', customerId);
      yield* typeInto('[id$="-0-description"]', 'Servis');
      yield* typeInto('[id$="-0-price"]', '100');
      yield* pick('sales-quote-status', 'draft');
      yield* saveSent();
      expect(sent).toEqual([expect.objectContaining({ _tag: 'SalesQuoteCreate', status: 'draft' })]);
    }).pipe(Effect.provide(network)),
  );

  it.live('Zrušit with typed lines asks; Zahodit změny leaves without sending', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mount();
      yield* typeInto('[id$="-0-description"]', 'Servis');
      yield* click(copy.cancel);
      expect(buttons(labels.discard).length > 0).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['close']);
      expect(sent).toEqual([]);
    }).pipe(Effect.provide(network)),
  );
});
