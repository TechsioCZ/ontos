// @rstest-environment happy-dom
// The stock item edit says how its save ended, as it did before the shared Save: a saved item shows the "saved"
// toast, and a refused save names the agenda's reason instead of the general failure text.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Toaster, ToastProvider } from '@techsio/ui-kit/molecules/toast';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionForbiddenProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { OpsCommandSchema } from '../../shared/agendas.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { PurchasingStateSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingState } from '../../shared/domain/purchasing.ts';
import { ItemPanel } from '../../src/routes/[lang]/provoz/nakupy/stock-tab.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const t = moduleText('cs');
const sent: OpsCommand[] = [];
const saved = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: [], revision: 4 });
const forbidden = Schema.decodeUnknownSync(ApplyCommandActionForbiddenProblemSchema)({
  _tag: 'ApplyCommandActionForbiddenProblem',
  code: 'facility_operations_permission_denied',
  detail: 'The stock item cannot be updated by this principal.',
  status: 403,
  title: 'Forbidden',
  type: 'urn:ontos:test:stock-item-forbidden',
});
let answer: Effect.Effect<typeof saved, typeof forbidden> = Effect.succeed(saved);
const Owner = ApplyCommandActionApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          sent.push(Schema.decodeUnknownSync(OpsCommandSchema)(payload.command));
          return answer;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

const click = (name: string) => acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click());
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const toasts = () =>
  [...document.querySelectorAll('[data-scope="toast"][data-part="title"]')].map((title) => ({
    title: title.textContent,
    type: title.closest<HTMLElement>('[data-scope="toast"][data-part="root"]')?.dataset.type,
  }));

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const audit = {
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
};
const state: PurchasingState = Schema.decodeUnknownSync(PurchasingStateSchema)({
  ...emptyPurchasingState,
  items: [
    {
      ...audit,
      category: 'consumable',
      id: 'item-1',
      leadTimeDays: 7,
      maximum: 50,
      minimum: 10,
      name: 'Filtr G4',
      sku: 'FLT-G4',
      tracking: 'none',
      unit: 'ks',
      warehouseId: 'warehouse-1',
    },
  ],
  warehouses: [{ ...audit, code: 'HS', id: 'warehouse-1', name: 'Hlavní sklad' }],
});

const editName = Effect.gen(function* editName() {
  yield* pinTestDocument;
  yield* mountInRoute(
    <ToastProvider>
      <ItemPanel
        canWrite
        itemId="item-1"
        me={actor}
        onClose={() => {}}
        onOpenOrder={() => {}}
        run={(command) => runCommand(command, 3)}
        state={state}
      />
      <Toaster />
    </ToastProvider>,
    { path: 'provoz/nakupy', url: '/cs/provoz/nakupy' },
  );
  yield* click(t('facility-operations.purchasing.actions.edit'));
  yield* typeInto('#item-edit-name', 'Filtr G4 kapsový');
  yield* click(labels.save);
});

beforeEach(() => {
  sent.length = 0;
  answer = Effect.succeed(saved);
});

afterEach(unmountAll);

describe('stock item edit', () => {
  it.live('a saved item shows the saved toast', () =>
    Effect.gen(function* savedItem() {
      yield* editName;
      yield* waitUntil(() => toasts().length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'StockItemUpdate')).toBe(true);
      expect(toasts()).toEqual([{ title: t('facility-operations.common.saved'), type: 'success' }]);
    }).pipe(Effect.provide(network)),
  );

  it.live('a refused save names the reason', () =>
    Effect.gen(function* refused() {
      answer = Effect.fail(forbidden);
      yield* editName;
      yield* waitUntil(() => text().includes(t('facility-operations.common.errors.forbidden')));
      expect(sent).toHaveLength(1);
      expect(text()).toContain(t('facility-operations.common.errors.forbidden'));
      expect(text()).not.toContain(labels.failed);
      expect(toasts()).toEqual([]);
    }).pipe(Effect.provide(network)),
  );
});
