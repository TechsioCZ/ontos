// @rstest-environment happy-dom
// The terms panel on the agreements page while the agreements reload in the background (a live change, the 20 s
// freshness window, a settled write). The store reads `pending` during such a reload; the open panel must stay
// mounted: typed input, its unsaved status and the leave question survive, a save goes out against the revision the
// draft was read at, and a draft with nothing typed takes the reloaded contract. Found on stage: the panel unmounted
// and came back with the server value, so 'Odpovědná osoba' lost what the person typed.
// The page runs on its real i18n, router and generated clients; the Shell's gateway issuer, the agreements owner's
// records and Action endpoints and Party Registry's customer reads answer in process through their HttpApi contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkQuietExcept,
  networkSteady,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';

import { CounterpartyReadApi } from '../../../party-registry/shared/apis/counterparty-read.ts';
import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { agreementCustomerData, agreements } from '../../src/routes/[lang]/smlouvy/agreements-data.ts';
import { RecordsPage } from '../../src/routes/[lang]/smlouvy/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const tenantId = '20000000-0000-4000-8000-000000000001';
const contractRefOf = (resourceId: string) => ({
  moduleId: 'legal.agreements',
  resourceId,
  resourceType: 'legal.agreements.contract',
  tenantId,
});
const firstId = '40000000-0000-4000-8000-000000000001';
const secondId = '40000000-0000-4000-8000-000000000002';
const contractOf = (
  resourceId: string,
  terms: { readonly noticePeriod: string; readonly responsiblePerson: string },
) => ({
  contractRef: contractRefOf(resourceId),
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '40000000-0000-4000-8000-000000000099',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: null,
  expiringSoon: false,
  hasSuccessorDraft: false,
  isExpired: false,
  kind: 'OTHER',
  lifecycleState: 'DRAFT',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  // The first contract is signed, so its page shows no signature form with a second Uložit.
  signatureState: resourceId === firstId ? 'SIGNED' : 'NOT_SENT',
  startDate: '2026-01-01',
  subject: resourceId,
  supersedesContractRef: null,
  unitRef: null,
  ...terms,
});
/** The agreements at `revision`; every read is a new object, as a reload returns. */
const recordsAt = (revision: number, noticePeriod: string): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    contracts: [
      contractOf(firstId, { noticePeriod, responsiblePerson: 'server-person' }),
      contractOf(secondId, { noticePeriod: 'second-notice', responsiblePerson: 'second-person' }),
    ],
    documents: [],
    revision,
  });

const context = { legalEntityId: 'company-a', principalId: 'lawyer-a', tenantId };
const propsFor = (resourceId: string): ModulePageProps => ({
  context,
  routeParams: {},
  search: `?resourceId=${resourceId}`,
});

const czech = moduleText('cs');
const owner = 'contract-terms-owner';
const notice = 'contract-terms-notice';
const editTerms = czech('legal-agreements.terms.edit');
const close = czech('legal-agreements.detail.close');
const saved = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ resourceRef: contractRefOf(firstId), revision: 9 });

/** What the agreements owner answers the next records read with; each test scripts it. */
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(recordsAt(7, 'server-notice'));
/** Every records read and command the agreements owner received, in order. */
const reads: RecordsRequest[] = [];
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
let counterpartyTraffic = { held: 0 };
const holdCounterparty = (traffic: typeof counterpartyTraffic) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      traffic.held += 1;
    }),
    () => Effect.never,
    () =>
      Effect.sync(() => {
        traffic.held -= 1;
      }),
  );

// Count only the counterparty handler's scoped, deliberately unanswered requests. Stability lets new
// handlers arrive; the exact-count wait below must still finish all records and Action requests.
const quietExceptCounterparties = (heldRecords = 0) =>
  networkSteady.pipe(Effect.andThen(Effect.suspend(() => networkQuietExcept(counterpartyTraffic.held + heldRecords))));

const OwnerRecordsApi = RecordsApi.prefix('/legal-agreements-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/legal-agreements-api');
const CustomersApi = CustomerListApi.prefix('/party-registry-api');
const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'legal-agreements': '/legal-agreements-api', 'party-registry': '/party-registry-api' })
    .application,
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
  serveApi(
    CustomersApi,
    HttpApiBuilder.group(CustomersApi, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
  // The counterparty's name never arrives; the panel does not wait for it.
  serveApi(
    CounterpartyApi,
    HttpApiBuilder.group(CounterpartyApi, 'counterpartyRead', (group) =>
      Effect.sync(() => {
        // Each served network owns its count; finalizers from a previous case retain its old object.
        const traffic = { held: 0 };
        counterpartyTraffic = traffic;
        return group.handle('execute', () => holdCounterparty(traffic));
      }),
    ),
  ),
);

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
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
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
const click = (name: string) => acted(() => button(name).click());

/** Mounts the agreements page on `resourceId` with the agreements at revision 7. */
const render = (resourceId: string) =>
  Effect.gen(function* mount() {
    yield* pinTestDocument;
    return yield* mountInRoute(<RecordsPage {...propsFor(resourceId)} />, {
      path: 'smlouvy',
      url: `/cs/smlouvy?resourceId=${resourceId}`,
    });
  });

/** Opens the page on `resourceId` and opens its terms panel. */
const openTerms = (resourceId: string) =>
  Effect.gen(function* open() {
    const mounted = yield* render(resourceId);
    yield* waitUntil(() => buttons(editTerms).length === 1);
    yield* click(editTerms);
    yield* waitUntil(() => Option.isSome(maybeField(owner)));
    yield* quietExceptCounterparties();
    return mounted;
  });

/** A background reload of the agreements that the owner answers once `gate` opens; resolves once the read arrived. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    const arrived = yield* Deferred.make<true>();
    answer = Deferred.succeed(arrived, true).pipe(Effect.andThen(Deferred.await(gate)));
    yield* acted(() => agreements.invalidate());
    yield* Deferred.await(arrived);
    yield* quietExceptCounterparties(1);
  });

beforeEach(() => {
  reads.length = 0;
  commands.length = 0;
  answer = Effect.succeed(recordsAt(7, 'server-notice'));
  agreements.invalidate();
  agreementCustomerData.invalidate();
});

afterEach(unmountAll);

describe('contract terms panel across a background reload', () => {
  it.live('keeps typed input, its status and the leave question; Save sends it against the old revision', () =>
    Effect.gen(function* typedSurvives() {
      yield* openTerms(firstId);
      yield* type(owner, 'typed-person');
      expect(text()).toContain(labels.unsaved);

      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      // While the agreements read `pending`, the panel and the typed value stay on screen.
      expect(value(owner)).toBe('typed-person');
      expect(text()).toContain(labels.unsaved);

      yield* Deferred.succeed(gate, recordsAt(8, 'someone-else-notice'));
      yield* waitUntil(() => reads.length >= 2 && text().includes('someone-else-notice'));
      yield* quietExceptCounterparties();
      expect(value(owner)).toBe('typed-person');
      // A dirty draft keeps its whole input, not just the typed field.
      expect(value(notice)).toBe('server-notice');
      expect(text()).toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(false);

      yield* click(close);
      yield* waitUntil(() => buttons(labels.stay).length === 1);
      yield* quietExceptCounterparties();
      expect(buttons(labels.stay)).toHaveLength(1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      yield* quietExceptCounterparties();
      expect(value(owner)).toBe('typed-person');

      answer = Effect.succeed(recordsAt(8, 'someone-else-notice'));
      yield* click(labels.save);
      yield* waitUntil(() => commands.length > 0);
      yield* quietExceptCounterparties();
      expect(commands[0]).toMatchObject({
        command: { _tag: 'SetContractTerms', responsiblePerson: 'typed-person' },
        expectedRevision: 7,
      });
    }).pipe(Effect.provide(network)),
  );

  it.live('another contract never shows the draft typed for this one', () =>
    Effect.gen(function* otherContract() {
      const { rerender } = yield* openTerms(firstId);
      yield* type(owner, 'typed-person');
      yield* rerender(<RecordsPage {...propsFor(secondId)} />);
      yield* quietExceptCounterparties();
      expect(Option.isNone(maybeField(owner))).toBe(true);
      yield* waitUntil(() => buttons(editTerms).length === 1);
      yield* click(editTerms);
      yield* waitUntil(() => Option.isSome(maybeField(owner)));
      yield* quietExceptCounterparties();
      expect(value(owner)).toBe('second-person');
      expect(text()).not.toContain('typed-person');
    }).pipe(Effect.provide(network)),
  );
});
