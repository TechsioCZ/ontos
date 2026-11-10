// @rstest-environment happy-dom
// The terms panel on the agreements page while the agreements reload in the background (a live change, the 20 s
// freshness window, a settled write). The store reads `pending` during such a reload; the open panel must stay
// mounted: typed input, its unsaved status and the leave question survive, a save goes out against the revision the
// draft was read at, and a draft with nothing typed takes the reloaded contract. Found on stage: the panel unmounted
// and came back with the server value, so 'Odpovědná osoba' lost what the person typed.
import { saveLabelsFor } from '@app/admin-ui';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { agreementCustomerData, agreements } from '../../src/routes/[lang]/smlouvy/agreements-data.ts';
import { RecordsPage } from '../../src/routes/[lang]/smlouvy/page.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

const mocks = rstest.hoisted(() => ({
  apply: rstest.fn(),
  customer: rstest.fn(),
  customers: rstest.fn(),
  records: rstest.fn(),
}));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.apply }));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: mocks.customer,
  listCustomers: mocks.customers,
}));
rstest.mock('../../src/routes/[lang]/smlouvy/rental-reference-access.ts', () => ({
  rentalReferenceAccess: Effect.succeed(false),
}));
rstest.mock('@app/facility-operations/ui/record-discussion', () => ({ RecordDiscussion: () => null }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => {},
  useRouterState: () => '',
}));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

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

const owner = 'contract-terms-owner';
const notice = 'contract-terms-notice';
const editTerms = 'legal-agreements.terms.edit';
const close = 'legal-agreements.detail.close';

/** Lets running reads and saves take a step, then flushes React's updates. */
const settle: Effect.Effect<void> = Effect.promise(() => browserRuntime.runPromise(Effect.yieldNow)).pipe(
  Effect.andThen(
    Effect.sync(() => {
      act(constVoid);
    }),
  ),
);
/** Runs `step` inside React's act, then lets what it started settle. */
const acted = (step: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    act(() => {
      step();
    });
  }).pipe(Effect.andThen(settle));
/** Lets the page work until `condition` holds; fails the test when it never does. */
const waitUntil = (condition: () => boolean, attempt = 0): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (condition() || attempt >= 400) {
      return Effect.sync(() => {
        expect(condition()).toBe(true);
      });
    }
    return settle.pipe(Effect.andThen(waitUntil(condition, attempt + 1)));
  });

const roots: { readonly container: HTMLElement; readonly root: Root }[] = [];
const render = (props: ModulePageProps) =>
  acted(() => {
    const [existing] = roots;
    if (existing === undefined) {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      roots.push({ container, root });
      root.render(<RecordsPage {...props} />);
    } else {
      existing.root.render(<RecordsPage {...props} />);
    }
  });

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);
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
const text = () => document.body.textContent ?? '';
const type = (id: string, typed: string) =>
  acted(() => {
    const input = Option.getOrThrow(maybeField(id));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
const click = (name: string) => acted(() => button(name).click());

/** Opens the page on `resourceId` with the agreements at revision 7 and opens its terms panel. */
const openTerms = (resourceId: string) =>
  Effect.gen(function* open() {
    yield* render(propsFor(resourceId));
    yield* waitUntil(() => buttons(editTerms).length === 1);
    yield* click(editTerms);
    yield* waitUntil(() => Option.isSome(maybeField(owner)));
  });

/** A background reload of the agreements that answers once `gate` opens, with someone else's notice period. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    mocks.records.mockReturnValue(Deferred.await(gate));
    yield* acted(() => agreements.invalidate());
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.records.mockReset();
  mocks.records.mockImplementation(() => Effect.succeed(recordsAt(7, 'server-notice')));
  mocks.customers.mockReset();
  mocks.customers.mockReturnValue(Effect.succeed([]));
  mocks.customer.mockReset();
  mocks.customer.mockReturnValue(Effect.never);
  mocks.apply.mockReset();
  mocks.apply.mockReturnValue(Effect.succeed({ resourceRef: contractRefOf(firstId), revision: 9 }));
  agreements.invalidate();
  agreementCustomerData.invalidate();
});

afterEach(() => {
  for (const { container, root } of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  rstest.unstubAllGlobals();
});

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
      yield* waitUntil(() => mocks.records.mock.calls.length >= 2 && text().includes('someone-else-notice'));
      expect(value(owner)).toBe('typed-person');
      // A dirty draft keeps its whole input, not just the typed field.
      expect(value(notice)).toBe('server-notice');
      expect(text()).toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(false);

      yield* click(close);
      expect(buttons(labels.stay)).toHaveLength(1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(value(owner)).toBe('typed-person');

      mocks.records.mockImplementation(() => Effect.succeed(recordsAt(8, 'someone-else-notice')));
      yield* click(labels.save);
      yield* waitUntil(() => mocks.apply.mock.calls.length > 0);
      expect(mocks.apply.mock.calls[0]?.[0]).toMatchObject({
        command: { _tag: 'SetContractTerms', responsiblePerson: 'typed-person' },
        expectedRevision: 7,
      });
    }),
  );

  it.live('a draft with nothing typed takes the reloaded contract', () =>
    Effect.gen(function* cleanFollows() {
      yield* openTerms(firstId);
      expect(value(notice)).toBe('server-notice');
      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      expect(value(notice)).toBe('server-notice');
      yield* Deferred.succeed(gate, recordsAt(8, 'someone-else-notice'));
      yield* waitUntil(() => value(notice) === 'someone-else-notice');
      expect(text()).not.toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(true);
    }),
  );

  it.live('another contract never shows the draft typed for this one', () =>
    Effect.gen(function* otherContract() {
      yield* openTerms(firstId);
      yield* type(owner, 'typed-person');
      yield* render(propsFor(secondId));
      expect(Option.isNone(maybeField(owner))).toBe(true);
      yield* waitUntil(() => buttons(editTerms).length === 1);
      yield* click(editTerms);
      yield* waitUntil(() => Option.isSome(maybeField(owner)));
      expect(value(owner)).toBe('second-person');
      expect(text()).not.toContain('typed-person');
    }),
  );

  it.live('the manual signature form on the same page keeps its typed signer too', () =>
    Effect.gen(function* signatureSurvives() {
      yield* render(propsFor(secondId));
      yield* waitUntil(() => Option.isSome(maybeField('contract-signedBy')));
      yield* type('contract-signedBy', 'typed-signer');
      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      expect(value('contract-signedBy')).toBe('typed-signer');
      yield* Deferred.succeed(gate, recordsAt(8, 'someone-else-notice'));
      yield* waitUntil(() => mocks.records.mock.calls.length >= 2 && Option.isSome(maybeField('contract-signedBy')));
      expect(value('contract-signedBy')).toBe('typed-signer');
      expect(text()).toContain(labels.unsaved);
    }),
  );
});
