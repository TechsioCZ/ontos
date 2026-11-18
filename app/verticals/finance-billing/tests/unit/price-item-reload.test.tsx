// @rstest-environment happy-dom
// The price list item editor on the finance page while the ledger reloads in the background (a live change, the 20 s
// freshness window, a settled write). The strict ledger store reads `pending` during such a reload; the open dialog
// must stay mounted: typed input, its unsaved status and the leave question survive and a save sends the typed draft,
// while a draft with nothing typed takes the reloaded item. Before, the price list tab unmounted for the reload and the
// dialog closed with everything typed into it. The plan, accounting and recurring tabs sit behind the same gate.
// The page runs on its real i18n, router and generated clients; the Shell's gateway issuer and the finance owner's
// records and Action endpoints answer in process through their HttpApi contracts. Other owners stay out of the
// composition and are refused as the Shell refuses them.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';

import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { RecordsPage } from '../../src/routes/[lang]/finance/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const name = 'price-name';
const amount = 'price-amount';
const close = moduleText('cs')('finance-billing.financeUi.priceList.close');
const itemId = 'price-item-1';

/** The ledger at `revision` with one price list item; every read is a new object, as a reload returns. */
const ledgerAt = (revision: number, unitPriceMinor: number): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    businessDate: '2026-10-05',
    canWrite: true,
    indicators: {
      costMinor: 0,
      costVarianceMinor: 0,
      draftCount: 0,
      grossOutstandingMinor: 0,
      openIncomingInvoices: 0,
      openInvoices: 0,
      openOutgoingInvoices: 0,
      overdueInvoices: 0,
      payablesOutstandingMinor: 0,
      plannedCostMinor: 0,
      plannedRevenueMinor: 0,
      receivablesOutstandingMinor: 0,
      revenueMinor: 0,
      revenueVarianceMinor: 0,
    },
    referenceDate: '2026-10-05',
    revision,
    state: {
      financialPlanEntries: [],
      invoices: [],
      priceList: [
        {
          active: true,
          id: itemId,
          name: 'server-name',
          unitPriceMinor,
          updatedAt: '2026-10-01T08:00:00Z',
          vatRate: 21,
        },
      ],
    },
  });

const context: ModulePageProps['context'] = {
  legalEntityId: 'company-a',
  principalId: 'accountant-a',
  tenantId: 'a0000000-0000-4000-8000-000000000001',
};

const saved = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ changed: true, revision: 5 });

/** What the finance owner answers the next records read with; each test scripts it. */
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(ledgerAt(3, 10_000));
/** Every records read and command the finance owner received, in order. */
const reads: RecordsRequest[] = [];
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];

const OwnerRecordsApi = RecordsApi.prefix('/finance-billing-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.push(payload);
          return answer;
        }),
      ),
    ),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return saved;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

const button = (label: string): HTMLButtonElement => {
  const [found] = buttons(label);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};
const maybeField = (id: string) => Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`));
const value = (id: string) =>
  maybeField(id).pipe(
    Option.map((input) => input.value),
    Option.getOrUndefined,
  );
const type = (id: string, typed: string) =>
  acted(() => {
    const input = Option.getOrThrow(maybeField(id));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (label: string) => acted(() => button(label).click());

/** Opens the price list tab with the ledger at revision 3 and opens the item's editor. */
const openItem = Effect.gen(function* open() {
  yield* pinTestDocument;
  yield* mountInRoute(<RecordsPage context={context} />, { path: 'finance', url: '/cs/finance?tab=cenik' });
  yield* waitUntil(() => buttons('Upravit server-name').length === 1);
  yield* click('Upravit server-name');
  yield* waitUntil(() => Option.isSome(maybeField(name)));
});

/** Someone else's change of finance data: the ledger reloads, the owner answers once `gate` opens. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    const arrived = yield* Deferred.make<true>();
    answer = Deferred.succeed(arrived, true).pipe(Effect.andThen(Deferred.await(gate)));
    yield* acted(() => {
      window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['finance-billing'] } }));
    });
    yield* Deferred.await(arrived);
    yield* settle;
  });

beforeEach(() => {
  reads.length = 0;
  commands.length = 0;
  answer = Effect.succeed(ledgerAt(3, 10_000));
});

afterEach(unmountAll);

describe('price list item editor across a background reload', () => {
  it.live('keeps typed input, its status and the leave question; Save sends the typed draft', () =>
    Effect.gen(function* typedSurvives() {
      yield* openItem;
      yield* type(name, 'typed-name');
      expect(text()).toContain(labels.unsaved);

      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      // While the ledger reads `pending`, the dialog and the typed value stay on screen.
      expect(value(name)).toBe('typed-name');
      expect(text()).toContain(labels.unsaved);

      // The reload brings a newer revision of the ledger; the item itself is unchanged.
      yield* Deferred.succeed(gate, ledgerAt(4, 10_000));
      yield* waitUntil(() => reads.length >= 2);
      yield* waitUntil(() => buttons(labels.save).length > 0);
      expect(value(name)).toBe('typed-name');
      expect(text()).toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(false);

      yield* click(close);
      yield* waitUntil(() => buttons(labels.stay).length === 1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(value(name)).toBe('typed-name');

      answer = Effect.succeed(ledgerAt(5, 10_000));
      yield* click(labels.save);
      yield* waitUntil(() => commands.length > 0);
      expect(commands[0]).toMatchObject({
        command: { _tag: 'UpsertPriceListItem', id: itemId, name: 'typed-name' },
      });
    }).pipe(Effect.provide(network)),
  );

  it.live('a draft with nothing typed takes the reloaded item', () =>
    Effect.gen(function* cleanFollows() {
      yield* openItem;
      const opened = value(amount);
      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      expect(value(amount)).toBe(opened);
      yield* Deferred.succeed(gate, ledgerAt(4, 25_000));
      yield* waitUntil(() => value(amount) !== opened && value(amount) !== undefined);
      expect(text()).not.toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(true);
    }).pipe(Effect.provide(network)),
  );
});
