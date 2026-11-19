// @rstest-environment happy-dom
// The new stay form owns the guest the person chose. A later guest search only offers other parties: whether it omits
// the chosen guest or fails for now, the guest stays chosen and labelled in the real picker, Uložit stays enabled, and
// the save sends the chosen guest's party reference. A failed search says so in the stay form, describes the guest
// picker and leaves the page's own state alone. A newer name of the chosen guest replaces the kept one. When Party
// Registry refuses the read, the form closes with its guest, the loaded records hide and no earlier search answers any
// more. The picker's own clear action, named after the guest it drops, drops the guest and keeps the rest of the form.
// The real page, picker, router and i18n run; the lease owner's records and
// Action, the Property register, the Agreement register and Party Registry's customer list answer in process through
// their HttpApi contracts behind the Shell's gateway issuer.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
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
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';

import { GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import {
  CustomerListApi,
  CustomerListAuthenticationProblemSchema,
  CustomerListForbiddenProblemSchema,
  CustomerListResponseSchema,
  CustomerListUnavailableProblemSchema,
} from '../../../party-registry/shared/apis/customer-list.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { leaseRecords } from '../../src/routes/[lang]/najmy/lease-occupant.ts';
import { RecordsPage } from '../../src/routes/[lang]/najmy/page.tsx';
import { occupancyRef, unitRef } from '../fixtures/occupancy-draft.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const { tenantId } = unitRef;
const context: ModulePageProps['context'] = { legalEntityId: 'company-a', principalId: 'manager-a', tenantId };

const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'property.portfolio.property',
  tenantId,
} as const;
const properties = Schema.decodeUnknownSync(PropertyRecordsSchema)({
  assets: [],
  properties: [
    {
      address: 'Dlouhá 1, Praha',
      code: 'P-1',
      createdAt: '2026-01-01T00:00:00Z',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: '99999999-9999-4999-8999-999999999999',
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      lifecycleState: 'ACTIVE',
      name: 'Dům Dlouhá',
      note: null,
      propertyRef,
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  revision: 1,
  units: [
    {
      capacity: 4,
      code: 'A-1',
      lifecycleState: 'ACTIVE',
      name: 'Apartmán Lípa',
      note: null,
      propertyRef,
      unitKind: null,
      unitRef,
    },
  ],
});

const customer = (displayName: string, partyId: string, counterpartyId: string) => ({
  city: null,
  companyId: null,
  counterpartyId,
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  displayName,
  email: null,
  partyId,
  partyRef: { moduleId: 'party.registry', resourceId: partyId, resourceType: 'party.registry.party', tenantId },
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
});
const novakPartyId = '77777777-7777-4777-8777-777777777771';
const dvorakPartyId = '77777777-7777-4777-8777-777777777772';
const directory = Schema.decodeUnknownSync(CustomerListResponseSchema)({
  items: [
    customer('Jana Nováková', novakPartyId, '66666666-6666-4666-8666-666666666661'),
    customer('Petr Dvořák', dvorakPartyId, '66666666-6666-4666-8666-666666666662'),
  ],
});
/** The same directory a moment later: Jana Nováková is now called Jana Nová. */
const renamedDirectory = Schema.decodeUnknownSync(CustomerListResponseSchema)({
  items: [
    customer('Jana Nová', novakPartyId, '66666666-6666-4666-8666-666666666661'),
    customer('Petr Dvořák', dvorakPartyId, '66666666-6666-4666-8666-666666666662'),
  ],
});
const forbidden = CustomerListForbiddenProblemSchema.make({
  detail: 'The customer list is not allowed for this principal.',
  status: 403,
  title: 'Customer list forbidden',
  type: 'https://ontos.dev/problems/customer-list-forbidden',
});
const signedOut = CustomerListAuthenticationProblemSchema.make({
  detail: 'The session has expired.',
  status: 401,
  title: 'Authentication required',
  type: 'https://ontos.dev/problems/authentication-required',
});
/** The Shell's gateway refusing the Party Registry audience before any request reaches the customer list. */
const gatewayForbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The authenticated principal cannot open this module in the current company.',
  status: GatewayForbiddenProblemSchema.fields.status.literal,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});
/** Whether the Shell's gateway refuses Party Registry; a test switches it on after the pick. */
let gatewayRefusesDirectory = false;
const unavailable = CustomerListUnavailableProblemSchema.make({
  detail: 'The customer list is unavailable.',
  retryable: true,
  status: 503,
  title: 'Customer list unavailable',
  type: 'https://ontos.dev/problems/customer-list-unavailable',
});

const leases = Schema.decodeUnknownSync(RecordsResponseSchema)({ canWrite: true, occupancies: [], revision: 7 });
const created = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ resourceRef: occupancyRef, revision: 8 });

/** What Party Registry's customer list answers next; a test switches it between searches. */
let listAnswer: Effect.Effect<typeof directory, typeof unavailable | typeof forbidden | typeof signedOut> =
  Effect.succeed(directory);
/** A customer-list read that answers `held` waits at the server until the test releases it. */
let heldRelease = Deferred.makeUnsafe<boolean>();
const held = Effect.suspend(() => Deferred.await(heldRelease)).pipe(Effect.as(directory));
const releaseHeld = () => Deferred.doneUnsafe(heldRelease, Effect.succeed(true));
/** Every customer-list read and every command the lease owner received, in order. */
let listReads = 0;
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];

const OwnerRecordsApi = RecordsApi.prefix('/property-leasing-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/property-leasing-api');
const PropertiesApi = PropertyRecordsApi.prefix('/property-portfolio-api');
const AgreementsApi = AgreementsRecordsApi.prefix('/legal-agreements-api');
const CustomersApi = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer(
    {
      'legal-agreements': '/legal-agreements-api',
      'party-registry': '/party-registry-api',
      'property-leasing': '/property-leasing-api',
      'property-portfolio': '/property-portfolio-api',
    },
    (audience) => (gatewayRefusesDirectory && audience === 'party-registry' ? gatewayForbidden : undefined),
  ).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) => group.handle('execute', () => Effect.succeed(leases))),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return created;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    CustomersApi,
    HttpApiBuilder.group(CustomersApi, 'customerList', (group) =>
      group.handle('execute', () =>
        Effect.suspend(() => {
          listReads += 1;
          return listAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    PropertiesApi,
    HttpApiBuilder.group(PropertiesApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(properties)),
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

/** The open stay form; the page shows other buttons with the same names outside it. */
const panel = () => document.querySelector('#booking-guest-query')?.closest('[role="dialog"]') ?? undefined;
const panelButton = (label: string) =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...(panel()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
      ),
    ),
  );
const saveButton = () => panelButton(labels.save);
const searchButton = () => panelButton(czech('property-leasing.demo.search'));

/** The real picker's native select, found through its visible label. */
const pickerSelect = (label: string) =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLSelectElement>('select')].find(
        (candidate) =>
          document.querySelector(`[id="${candidate.getAttribute('aria-labelledby') ?? ''}"]`)?.textContent?.trim() ===
          label,
      ),
    ),
  );
const guestLabel = czech('property-leasing.demo.guest');
/** The guest picker's trigger, the combobox a screen reader announces. */
const guestTrigger = () =>
  document.querySelector(
    `[role="combobox"][aria-labelledby="${pickerSelect(guestLabel).getAttribute('aria-labelledby') ?? ''}"]`,
  );
/** What the guest picker's trigger shows. */
const guestShown = () => guestTrigger()?.textContent?.trim();
/** The texts that describe the guest picker to a screen reader. */
const guestDescriptions = () =>
  (guestTrigger()?.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.querySelector(`[id="${id}"]`)?.textContent?.trim() ?? '');
/** The clear action of the guest picker, by the name a screen reader announces for `name`. */
const clearGuestLabel = (name: string) => czech('property-leasing.demo.clearGuest', { name });

/** Types like a person: React sees a native input event. */
const type = (selector: string, value: string) =>
  acted(() => {
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

/** Waits for the real picker to report the choice in both the native control and visible trigger. */
const pick = (label: string, value: string, shown: string) =>
  acted(() => {
    const select = pickerSelect(label);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }).pipe(
    Effect.andThen(
      Effect.promise(() =>
        rstest.waitFor(async () => {
          await act(async () => {});
          expect(pickerSelect(label).value).toBe(value);
          expect(
            document
              .querySelector(
                `[role="combobox"][aria-labelledby="${pickerSelect(label).getAttribute('aria-labelledby') ?? ''}"]`,
              )
              ?.textContent?.trim(),
          ).toBe(shown);
        }),
      ),
    ),
  );

/** Asks for the guests matching `query` and waits until Party Registry received the read. */
const ask = (query: string) =>
  Effect.gen(function* askGuests() {
    const read = listReads;
    yield* type('#booking-guest-query', query);
    yield* acted(() => searchButton().click());
    yield* waitUntil(() => listReads === read + 1);
  });

/** Searches the guests and waits until the answer arrived and the page took it. */
const search = (query: string) =>
  ask(query).pipe(Effect.andThen(networkIdle), Effect.andThen(waitUntil(() => !searchButton().disabled)));

/** The guests the picker offers, by party id. */
const offered = () => [...pickerSelect(guestLabel).options].map((option) => option.value).filter(Boolean);

/** After a refused read: the form is gone, the page says so and offers a retry, and no stay or lease shows. */
const expectRefused = () => {
  expect(panel()).toBeUndefined();
  expect(text()).toContain(czech('property-leasing.demo.feedback.forbidden'));
  expect(document.querySelector('#booking-guest-query')).toBeNull();
  expect(commands).toEqual([]);
};

/** Opens a new stay form on the mounted page. */
const openStay = Effect.gen(function* openStay() {
  const newStay = czech('property-leasing.demo.newBooking');
  yield* waitUntil(() => buttons(newStay).some((candidate) => !candidate.disabled));
  yield* acted(() =>
    buttons(newStay)
      .find((candidate) => !candidate.disabled)
      ?.click(),
  );
  yield* waitUntil(() => panel() !== undefined);
});

/** Closes the stay form with typed input: the person drops the input when asked. */
const closeStay = Effect.gen(function* closeStay() {
  yield* acted(() => panelButton(czech('property-leasing.demo.close')).click());
  yield* waitUntil(() => buttons(labels.discard).length === 1);
  yield* acted(() => buttons(labels.discard)[0]?.click());
  yield* waitUntil(() => panel() === undefined);
});

/** Opens a new stay, picks the unit, the end date and Jana Nováková from a search. */
const chooseNovakova = Effect.gen(function* chooseNovakova() {
  yield* pinTestDocument;
  yield* mountInRoute(<RecordsPage context={context} />, { path: 'najmy', url: '/cs/najmy' });
  yield* openStay;
  yield* pick(czech('property-leasing.demo.unit'), unitRef.resourceId, 'Apartmán Lípa');
  yield* type('#occupancy-end-date', '2099-12-31');
  // No guest yet: Uložit is held back.
  expect(saveButton().disabled).toBe(true);
  yield* search('Nováková');
  yield* pick(guestLabel, novakPartyId, 'Jana Nováková');
  yield* waitUntil(() => !saveButton().disabled);
  expect(saveButton().disabled).toBe(false);
});

/** The choice as the person sees it: chosen in the native control, labelled in the trigger, Uložit enabled. */
const expectKept = () => {
  expect(pickerSelect(guestLabel).value).toBe(novakPartyId);
  expect(guestShown()).toBe('Jana Nováková');
  expect(saveButton().disabled).toBe(false);
};

beforeEach(() => {
  heldRelease = Deferred.makeUnsafe<boolean>();
  listAnswer = Effect.succeed(directory);
  listReads = 0;
  commands.length = 0;
  gatewayRefusesDirectory = false;
  leaseRecords.invalidate();
});

afterEach(unmountAll);

describe('the guest of a new stay', () => {
  it.live(
    'stays chosen after a search that omits it, and Uložit sends it',
    () =>
      Effect.gen(function* survivesOmission() {
        yield* chooseNovakova;

        yield* search('Dvořák');
        expectKept();
        // Searching and choosing never record anything: only Uložit does.
        expect(commands).toEqual([]);

        yield* acted(() => saveButton().click());
        yield* waitUntil(() => commands.length > 0);
        expect(commands[0]).toMatchObject({
          command: {
            _tag: 'CreateDraft',
            record: {
              guestPartyRef: {
                moduleId: 'party.registry',
                resourceId: novakPartyId,
                resourceType: 'party.registry.party',
                tenantId,
              },
              kind: 'SHORT_STAY',
              unitRef: { resourceId: unitRef.resourceId },
            },
          },
          expectedRevision: 7,
        });
      }).pipe(Effect.provide(network)),
    // Mounts the real lease page, searches twice and saves.
    { timeout: 20_000 },
  );

  it.live(
    'stays chosen after a search that fails for now, which says so in the form and offers no earlier hit',
    () =>
      Effect.gen(function* survivesOutage() {
        yield* chooseNovakova;
        yield* search('Dvořák');
        expect(offered()).toEqual([novakPartyId, dvorakPartyId]);

        listAnswer = Effect.fail(unavailable);
        yield* search('Svoboda');
        expect(panel()?.textContent).toContain(czech('property-leasing.demo.guestSearchUnavailable'));
        expectKept();
        // Dvořák came from the earlier search: only the chosen guest is still offered.
        expect(offered()).toEqual([novakPartyId]);
        expect(commands).toEqual([]);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    'a refused search closes the form with its guest and hides the loaded records',
    () =>
      Effect.gen(function* refusalClears() {
        yield* chooseNovakova;
        yield* search('Dvořák');

        listAnswer = Effect.fail(forbidden);
        yield* ask('Svoboda');
        yield* networkIdle;
        yield* waitUntil(() => panel() === undefined);
        expectRefused();
        expect(buttons(czech('property-leasing.demo.retry')).length).toBe(1);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    'an earlier search that answers after a refusal does not bring the form or its guests back',
    () =>
      Effect.gen(function* noLateAnswer() {
        yield* chooseNovakova;
        listAnswer = held;
        yield* ask('Dvořák');

        listAnswer = Effect.fail(forbidden);
        yield* ask('Svoboda');
        yield* waitUntil(() => panel() === undefined);

        releaseHeld();
        yield* networkIdle;
        expectRefused();
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    "keeps the chosen guest's newer name after a later search omits the guest",
    () =>
      Effect.gen(function* renameSticks() {
        yield* chooseNovakova;
        listAnswer = Effect.succeed(renamedDirectory);
        yield* search('Nová');
        yield* waitUntil(() => guestShown() === 'Jana Nová');

        yield* search('Dvořák');
        expect(pickerSelect(guestLabel).value).toBe(novakPartyId);
        expect(guestShown()).toBe('Jana Nová');
        expect(saveButton().disabled).toBe(false);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    "the picker's clear action drops the guest, holds Uložit back and keeps the rest of the form",
    () =>
      Effect.gen(function* clearsGuest() {
        yield* chooseNovakova;
        yield* type('#stay-note', 'Pozdní příjezd');
        yield* acted(() => panelButton(clearGuestLabel('Jana Nováková')).click());
        yield* waitUntil(
          () =>
            pickerSelect(guestLabel).value === '' &&
            guestShown() === czech('property-leasing.demo.choose') &&
            saveButton().disabled,
        );
        expect(guestShown()).toBe(czech('property-leasing.demo.choose'));
        expect(saveButton().disabled).toBe(true);
        expect(pickerSelect(czech('property-leasing.demo.unit')).value).toBe(unitRef.resourceId);
        expect(document.querySelector<HTMLInputElement>('#occupancy-end-date')?.value).toBe('2099-12-31');
        expect(document.querySelector<HTMLInputElement>('#stay-note')?.value).toBe('Pozdní příjezd');
        expect(document.querySelector<HTMLInputElement>('#booking-guest-query')?.value).toBe('Nováková');
        expect(commands).toEqual([]);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    'picking another guest replaces the kept one',
    () =>
      Effect.gen(function* picksAnother() {
        yield* chooseNovakova;
        yield* search('Dvořák');
        yield* pick(guestLabel, dvorakPartyId, 'Petr Dvořák');
        // Nováková is no longer kept: the picker offers only what the last search found.
        expect([...pickerSelect(guestLabel).options].map((option) => option.value).filter(Boolean)).toEqual([
          dvorakPartyId,
        ]);
        yield* acted(() => saveButton().click());
        yield* waitUntil(() => commands.length > 0);
        expect(commands[0]).toMatchObject({
          command: { record: { guestPartyRef: { resourceId: dvorakPartyId } } },
        });
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );
  it.live(
    "a failed search says so in the stay form, describes the guest picker and leaves the page's state alone",
    () =>
      Effect.gen(function* searchFailureStaysInForm() {
        yield* chooseNovakova;
        const searchFailed = czech('property-leasing.demo.guestSearchUnavailable');
        const pageUnavailable = czech('property-leasing.demo.feedback.unavailable');
        const retry = czech('property-leasing.demo.retry');
        expect(guestDescriptions()).not.toContain(searchFailed);

        listAnswer = Effect.fail(unavailable);
        yield* search('Svoboda');
        expect(panel()?.textContent).toContain(searchFailed);
        expect(guestDescriptions()).toContain(searchFailed);
        // Only the guest search failed: the leases loaded fine, so the page neither reports an outage nor offers a retry.
        expect(text()).not.toContain(pageUnavailable);
        expect(buttons(retry)).toHaveLength(0);

        // The form closes as any form with typed input does; the page stays as its leases loaded.
        yield* closeStay;
        expect(text()).not.toContain(searchFailed);
        expect(text()).not.toContain(pageUnavailable);
        expect(buttons(retry)).toHaveLength(0);
        expect(commands).toEqual([]);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    'the clear action names the guest it drops for a screen reader',
    () =>
      Effect.gen(function* clearNamesGuest() {
        yield* chooseNovakova;
        expect(buttons(clearGuestLabel('Jana Nováková'))).toHaveLength(1);

        yield* search('Dvořák');
        yield* pick(guestLabel, dvorakPartyId, 'Petr Dvořák');
        expect(buttons(clearGuestLabel('Petr Dvořák'))).toHaveLength(1);
        expect(buttons(clearGuestLabel('Jana Nováková'))).toHaveLength(0);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );
  it.live(
    "a refusal by the Shell's gateway closes the form with its guest before Party Registry is asked",
    () =>
      Effect.gen(function* gatewayRefusal() {
        yield* chooseNovakova;
        const reads = listReads;
        gatewayRefusesDirectory = true;
        yield* type('#booking-guest-query', 'Dvořák');
        yield* acted(() => searchButton().click());
        yield* waitUntil(() => panel() === undefined);
        yield* networkIdle;
        expectRefused();
        // The gateway answered alone: the customer list never received this search.
        expect(listReads).toBe(reads);
        expect(buttons(czech('property-leasing.demo.retry')).length).toBe(1);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    'an expired login closes the form with its guest',
    () =>
      Effect.gen(function* expiredLogin() {
        yield* chooseNovakova;
        listAnswer = Effect.fail(signedOut);
        yield* ask('Dvořák');
        yield* waitUntil(() => panel() === undefined);
        yield* networkIdle;
        expect(document.querySelector('#booking-guest-query')).toBeNull();
        expect(text()).not.toContain('Jana Nováková');
        expect(buttons(czech('property-leasing.demo.retry')).length).toBe(1);
        expect(commands).toEqual([]);
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );

  it.live(
    'a search that answers after its stay closed does not fill the next stay',
    () =>
      Effect.gen(function* lateAnswerAfterReopen() {
        yield* chooseNovakova;
        listAnswer = held;
        yield* ask('Dvořák');
        yield* closeStay;
        yield* openStay;

        releaseHeld();
        yield* networkIdle;
        expect(panel()).not.toBeUndefined();
        expect(offered()).toEqual([]);
        expect(pickerSelect(guestLabel).value).toBe('');
        expect(document.querySelector<HTMLInputElement>('#booking-guest-query')?.value).toBe('');
      }).pipe(Effect.provide(network)),
    { timeout: 20_000 },
  );
});
