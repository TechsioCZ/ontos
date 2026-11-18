// @rstest-environment happy-dom
// The sales quote edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
import { settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { CustomerListApi, CustomerListResponseSchema } from '../../../party-registry/shared/apis/customer-list.ts';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { OpsCommandSchema } from '../../shared/agendas.ts';
import { PurchasingStateSchema, SalesQuoteSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingState, SalesQuote } from '../../shared/domain/purchasing.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { mountInRoute } from '../support/module-ui.ts';
import { SalesQuoteEditPanel } from '../../src/routes/[lang]/provoz/nakupy/sales-tab.tsx';
import {
  agendaAt,
  bodyText,
  changeElsewhere,
  click,
  fieldValue,
  labels,
  toPage,
  typeInto,
} from './draft-base-fixture.ts';
import type { FakeAgenda } from './draft-base-fixture.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const quoteAt = (updatedAt: string, validUntil: string, note: string): SalesQuote =>
  Schema.decodeUnknownSync(SalesQuoteSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    currency: 'CZK',
    customer: { counterpartyId: '44444444-4444-4444-8444-444444444444', name: 'Kavárna Dolce', tenantId },
    date: '2026-10-20',
    id: 'quote-1',
    lines: [
      { description: 'Servis vzduchotechniky', id: 'line-1', quantity: 1, unitPriceMinor: 1_500_000, vatRate: 21 },
    ],
    note,
    number: 'NAB-2026-014',
    status: 'draft',
    updatedAt,
    updatedBy: actor,
    validUntil,
  });
const opened = quoteAt('2026-10-20T08:00:00Z', '2026-11-19', 'Servis do konce měsíce');
const theirs = quoteAt('2026-10-21T09:30:00Z', '2026-11-30', 'Servis do konce měsíce');
const note = '#sales-quote-note';
const validUntil = '#sales-quote-valid';

const stateWith = (quote: SalesQuote): PurchasingState => ({
  ...Schema.decodeUnknownSync(PurchasingStateSchema)(emptyPurchasingState),
  salesQuotes: [quote],
});

// Each page read supplies a runner tied to that read; the real Action client sends it to the owner.
const panelOf = (quote: SalesQuote, revision: number) =>
  createElement(SalesQuoteEditPanel, {
    onClose: toPage,
    onSaved: toPage,
    quoteId: quote.id,
    run: (command) => runCommand(command, revision),
    state: stateWith(quote),
  });

const sentRevisions = (agenda: FakeAgenda) => agenda.applied.map((entry) => entry.expectedRevision);

const partyId = '55555555-5555-4555-8555-555555555555';
const customers = Schema.decodeUnknownSync(CustomerListResponseSchema)({
  items: [
    {
      city: null,
      companyId: null,
      counterpartyId: opened.customer.counterpartyId,
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: opened.customer.counterpartyId,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      createdAt: '2026-10-20T08:00:00.000Z',
      displayName: 'Kavárna Dolce',
      email: null,
      partyId,
      partyRef: {
        moduleId: 'party.registry',
        resourceId: partyId,
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
const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const PartyApi = CustomerListApi.prefix('/party-registry-api');
const networkFor = (agenda: FakeAgenda) =>
  browserNetwork(
    shellGatewayIssuer({
      'facility-operations': '/facility-operations-api',
      'party-registry': '/party-registry-api',
    }).application,
    serveApi(
      PartyApi,
      HttpApiBuilder.group(PartyApi, 'customerList', (group) =>
        group.handle('execute', () => Effect.succeed(customers)),
      ),
    ),
    serveApi(
      OwnerActionApi,
      HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
        group.handle('execute', ({ payload }) =>
          Effect.gen(function* apply() {
            const command = yield* Schema.decodeUnknownEffect(OpsCommandSchema)(payload.command).pipe(Effect.orDie);
            agenda.applied.push({ command, expectedRevision: payload.expectedRevision });
            if (payload.expectedRevision < agenda.recordRevision) {
              return yield* Effect.fail(
                Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
                  _tag: 'ApplyCommandActionConflictProblem',
                  code: 'facility_operations_revision_conflict',
                  detail: 'The quote changed after the draft was opened.',
                  status: 409,
                  title: 'Revision conflict',
                  type: 'https://ontos.test/problems/revision-conflict',
                }),
              );
            }
            agenda.revision += 1;
            agenda.recordRevision = agenda.revision;
            return { entityIds: [], revision: agenda.revision };
          }),
        ),
      ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
    ),
  );

const save = (agenda: FakeAgenda, count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => agenda.applied.length >= count)),
    Effect.andThen(waitUntil(() => bodyText().includes(labels.saved) || bodyText().includes(labels.conflict))),
    Effect.andThen(settle),
  );

const mountPanel = (quote: SalesQuote, revision: number) =>
  mountInRoute(panelOf(quote, revision), {
    path: 'provoz/nakupy',
    url: '/cs/provoz/nakupy',
  }).pipe(Effect.tap(() => waitUntil(() => document.querySelector('[name="sales-customer"]') !== null)));

afterEach(unmountAll);

describe('sales quote edit save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const agenda = agendaAt(3);
      yield* Effect.gen(function* mountedScenario() {
        const panel = yield* mountPanel(opened, 3);
        yield* typeInto(note, 'Servis do pátku');
        changeElsewhere(agenda);
        yield* panel.rerender(panelOf(theirs, 4));
        expect(fieldValue(note)).toBe('Servis do pátku');
        yield* save(agenda, 1);
        expect(sentRevisions(agenda)).toEqual([3]);
        expect(bodyText()).toContain(labels.conflict);
        yield* click(labels.reloadLatest);
        expect(fieldValue(validUntil)).toBe('2026-11-30');
        yield* typeInto(note, 'Servis do pátku');
        yield* save(agenda, 2);
        expect(sentRevisions(agenda)).toEqual([3, 4]);
        expect(bodyText()).toContain(labels.saved);
      }).pipe(Effect.provide(networkFor(agenda)));
    }),
  );

  it.live('a clean draft takes the refresh, with its revision', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const agenda = agendaAt(3);
      yield* Effect.gen(function* mountedScenario() {
        const panel = yield* mountPanel(opened, 3);
        changeElsewhere(agenda);
        yield* panel.rerender(panelOf(theirs, 4));
        expect(fieldValue(validUntil)).toBe('2026-11-30');
        yield* typeInto(note, 'Servis do pátku');
        yield* save(agenda, 1);
        expect(sentRevisions(agenda)).toEqual([4]);
        expect(bodyText()).toContain(labels.saved);
      }).pipe(Effect.provide(networkFor(agenda)));
    }),
  );

  it.live('its own save advances the base, so the next save is not refused', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const agenda = agendaAt(3);
      yield* Effect.gen(function* mountedScenario() {
        const panel = yield* mountPanel(opened, 3);
        yield* typeInto(note, 'Servis do pátku');
        yield* save(agenda, 1);
        // The page re-reads after the save: the record now carries this form's own change.
        yield* panel.rerender(panelOf(quoteAt('2026-10-22T10:00:00Z', '2026-11-19', 'Servis do pátku'), 4));
        yield* typeInto(note, 'Servis do Vánoc');
        yield* save(agenda, 2);
        expect(sentRevisions(agenda)).toEqual([3, 4]);
        expect(bodyText()).toContain(labels.saved);
      }).pipe(Effect.provide(networkFor(agenda)));
    }),
  );
});
