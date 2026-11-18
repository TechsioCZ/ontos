// @rstest-environment happy-dom
// The rent panel of a lease while the leases reload in the background (a live change, the 20 s freshness window, a
// settled write). The strict lease store reads `pending` during such a reload; the open panel must stay mounted: typed
// input, its unsaved status and the leave question survive, a save goes out against the revision the draft was read
// at, and a draft with nothing typed takes the reloaded rent.
// The page runs on its real i18n, router and generated clients. The Shell's gateway issuer, the lease owner's records
// and Action endpoints and the Property and Agreement registers answer in process through their HttpApi contracts;
// the issuer also hands out the reference credentials every lease command carries.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  RecordsApi as AgreementsRecordsApi,
  RecordsResponseSchema as AgreementsRecordsSchema,
} from '@app/legal-agreements/contracts/records';
import {
  RecordsApi as PropertyRecordsApi,
  RecordsResponseSchema as PropertyRecordsSchema,
} from '@app/property-portfolio/contracts/records';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';

import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { leaseInputOf, leaseRecords } from '../../src/routes/[lang]/najmy/lease-occupant.ts';
import { RecordsPage } from '../../src/routes/[lang]/najmy/page.tsx';
import { leaseDraft, occupancyRef } from '../fixtures/occupancy-draft.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const monthly = 'occupancy-rent-monthly';
const paymentDay = 'occupancy-rent-payment-day';
const editRent = czech('property-leasing.rent.edit');
const close = czech('property-leasing.demo.close');

/** The leases at `revision`; every read is a new object, as a reload returns. */
const recordsAt = (revision: number, day: number): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    canWrite: true,
    occupancies: [{ ...leaseDraft, rentTerms: { ...leaseDraft.rentTerms, paymentDay: day }, state: 'ACTIVE' }],
    revision,
  });
const saved = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ resourceRef: occupancyRef, revision: 9 });

const context: ModulePageProps['context'] = {
  legalEntityId: 'company-a',
  principalId: 'manager-a',
  tenantId: occupancyRef.tenantId,
};

/** What the lease owner answers the next records read with; each test scripts it. */
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(recordsAt(7, 15));
/** Every records read and command the lease owner received, in order. */
const reads: RecordsRequest[] = [];
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];

const OwnerRecordsApi = RecordsApi.prefix('/property-leasing-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/property-leasing-api');
const PropertiesApi = PropertyRecordsApi.prefix('/property-portfolio-api');
const AgreementsApi = AgreementsRecordsApi.prefix('/legal-agreements-api');
const CustomersApi = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
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
    // The tenant directory; an empty customer list leaves the lease without a tenant name.
    HttpApiBuilder.group(CustomersApi, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
  serveApi(
    PropertiesApi,
    HttpApiBuilder.group(PropertiesApi, 'records', (group) =>
      group.handle('execute', () =>
        Effect.succeed(
          Schema.decodeUnknownSync(PropertyRecordsSchema)({ assets: [], properties: [], revision: 1, units: [] }),
        ),
      ),
    ),
  ),
  serveApi(
    AgreementsApi,
    HttpApiBuilder.group(AgreementsApi, 'records', (group) =>
      group.handle('execute', () =>
        Effect.succeed(
          Schema.decodeUnknownSync(AgreementsRecordsSchema)({ contracts: [], documents: [], revision: 1 }),
        ),
      ),
    ),
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
/** A button of the rent panel itself; the lease page shows other forms with their own Uložit. */
const panelButton = (label: string): HTMLButtonElement => {
  const panel = maybeField(monthly).pipe(
    Option.flatMapNullishOr((input) => input.closest('[role="dialog"]')),
    Option.getOrUndefined,
  );
  const found = [...(panel?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};
const clickPanel = (label: string) => acted(() => panelButton(label).click());

/** Opens the lease with the leases at revision 7 and opens its rent panel. */
const openRent = Effect.gen(function* open() {
  yield* pinTestDocument;
  yield* mountInRoute(<RecordsPage context={context} />, {
    path: 'najmy',
    url: `/cs/najmy?resourceId=${occupancyRef.resourceId}`,
  });
  yield* waitUntil(() => buttons(editRent).length === 1 && !button(editRent).disabled);
  yield* click(editRent);
  yield* waitUntil(() => Option.isSome(maybeField(monthly)));
});

/** A background reload of the leases that the owner answers once `gate` opens; resolves once the read arrived. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    const arrived = yield* Deferred.make<true>();
    answer = Deferred.succeed(arrived, true).pipe(Effect.andThen(Deferred.await(gate)));
    yield* acted(() => leaseRecords.invalidate());
    yield* Deferred.await(arrived);
    yield* settle;
  });

beforeEach(() => {
  reads.length = 0;
  commands.length = 0;
  answer = Effect.succeed(recordsAt(7, 15));
  leaseRecords.invalidate();
});

afterEach(unmountAll);

describe('rent panel across a background reload', () => {
  it.live('keeps typed input, its status and the leave question; Save sends it against the old revision', () =>
    Effect.gen(function* typedSurvives() {
      yield* openRent;
      yield* type(monthly, '20000');
      expect(text()).toContain(labels.unsaved);

      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      // While the leases read `pending`, the panel and the typed value stay on screen.
      expect(value(monthly)).toBe('20000');
      expect(text()).toContain(labels.unsaved);

      yield* Deferred.succeed(gate, recordsAt(8, 20));
      yield* waitUntil(() => reads.length >= 2);
      yield* waitUntil(() => leaseRecords.snapshot(leaseInputOf(context)).state === 'ready');
      expect(value(monthly)).toBe('20000');
      // A dirty draft keeps its whole input, not just the typed field.
      expect(value(paymentDay)).toBe('15');
      expect(text()).toContain(labels.unsaved);
      expect(panelButton(labels.save).disabled).toBe(false);

      yield* clickPanel(close);
      yield* waitUntil(() => buttons(labels.stay).length === 1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(value(monthly)).toBe('20000');

      answer = Effect.succeed(recordsAt(8, 20));
      yield* clickPanel(labels.save);
      yield* waitUntil(() => commands.length > 0);
      expect(commands[0]).toMatchObject({
        command: { _tag: 'SetRentTerms', rentTerms: { monthlyRentMinor: 2_000_000, paymentDay: 15 } },
        expectedRevision: 7,
      });
    }).pipe(Effect.provide(network)),
  );
});
