import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest, test } from 'effect-rstest';
import { createInstance } from 'i18next';
import type { ReactNode } from 'react';

import cs from '../../locales/cs/shell.json';
import en from '../../locales/en/shell.json';
import {
  AccessAdminForbiddenProblemSchema,
  AccessAdminUnavailableProblemSchema,
  ExplainAccessResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import type { ExplainAccessResponse } from '../../shared/access-admin-api.ts';
import {
  checkWhySearch,
  decodeWhySearch,
  loadWhyPageModel,
  loadWhySubjects,
  mergeWhySubjects,
  whyDecisionView,
  whySearchFromRequest,
} from '../../src/routes/[lang]/access/why/why-page-model.ts';
import { WhyResult, WhySubjectPicker, WhyView } from '../../src/routes/access-admin/why/why-view.tsx';
import {
  completeWhyCheck,
  emptyWhySearch,
  hiddenWhySubjects,
  whyReasonKey,
} from '../../src/routes/access-admin/why/why-view-model.ts';
import type { WhySearchDraft, WhySubjectOptions } from '../../src/routes/access-admin/why/why-view-model.ts';
import { AuthenticationUnavailableProblemSchema, CurrentSessionSchema } from '../../shared/browser-api.ts';
import { adaSelectingCompany, adaSignedIn, makeShellBff, signedInShellReads } from '../support/shell-bff-double.ts';
import type { ShellBffScript } from '../support/shell-bff-double.ts';
import { ShellI18n, shellLocaleCopy } from '../support/shell-i18n.tsx';
import type { ShellLanguage } from '../support/shell-i18n.tsx';

/** The language a test selects before rendering. */
interface SelectedLanguage {
  value: ShellLanguage;
}
const locale: SelectedLanguage = { value: 'en' };
const copies = { cs: shellLocaleCopy('cs'), en: shellLocaleCopy('en') };
/** The Shell's real i18n context, in whichever language the test selected before rendering. */
const ShellCopy = ({ children }: { readonly children: ReactNode }) => (
  <ShellI18n translations={copies[locale.value]}>{children}</ShellI18n>
);
const renderCopy = (ui: Parameters<typeof render>[0]) => render(ui, { wrapper: ShellCopy });
const i18n = createInstance();
await i18n.init({
  fallbackLng: false,
  interpolation: { escapeValue: false },
  lng: 'en',
  resources: { cs: { translation: cs }, en: { translation: en } },
});

const noop = () => {};
const query: WhySearchDraft = {
  ...emptyWhySearch,
  capabilityKey: 'commerce.order.order.read',
  currency: 'CZK',
  minor: '12500',
  recordKey: 'order-1',
  targetModule: 'commerce.order',
};
const outcomeKeys = { ALLOWED: 'allowed', DENIED: 'denied', NEEDS_APPROVAL: 'needsApproval' } as const;
const outcomeReasons = {
  ALLOWED: 'allow.granted',
  DENIED: 'deny.insufficient_grant',
  NEEDS_APPROVAL: 'approval.required',
} as const;
const response = (
  outcome: ExplainAccessResponse['outcome'] = 'ALLOWED',
  authorityMetadata: ExplainAccessResponse['authorityMetadata'] = 'withheld',
): ExplainAccessResponse =>
  Schema.decodeUnknownSync(ExplainAccessResponseSchema)({
    authority: [],
    authorityMetadata,
    grantableBy: [],
    outcome,
    reasonCodes: [outcomeReasons[outcome]],
  });

/**
 * The Shell BFF of Ada signed in with her company selected: explanations answer ALLOWED and the
 * governed people list refuses, unless a test scripts otherwise.
 */
const whyBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    ...signedInShellReads(adaSignedIn),
    explainAccess: () => Effect.succeed(response()),
    listAccessPeople: () =>
      Effect.fail(
        Schema.decodeUnknownSync(AccessAdminForbiddenProblemSchema)({
          _tag: 'AccessAdminForbidden',
          detail: 'redacted',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank',
        }),
      ),
    ...overrides,
  });
const explanations = (bff: ReturnType<typeof whyBff>) =>
  bff.requests.filter((received) => received.endpoint === 'explainAccess').map((received) => received.body);
const peopleReads = (bff: ReturnType<typeof whyBff>) =>
  bff.requests.filter((received) => received.endpoint === 'listAccessPeople').map((received) => received.body);

beforeEach(() => {
  locale.value = 'en';
});
afterEach(cleanup);

for (const language of ['en', 'cs'] as const) {
  test(`renders four distinct outcomes with localized text in ${language}`, () => {
    locale.value = language;
    for (const outcome of ['ALLOWED', 'DENIED', 'NEEDS_APPROVAL'] as const) {
      renderCopy(<WhyResult onRetry={noop} result={whyDecisionView(response(outcome), query)} />);
      expect(
        screen.getByText(i18n.getFixedT(language)(`shell.accessAdmin.outcome.${outcomeKeys[outcome]}`)),
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: i18n.getFixedT(language)('shell.accessAdmin.common.retry') }),
      ).toBeNull();
      expect(document.body.textContent).not.toContain('shell.accessAdmin');
      cleanup();
    }
    renderCopy(<WhyResult onRetry={noop} result={{ state: 'unavailable' }} />);
    expect(screen.getByText(i18n.getFixedT(language)('shell.accessAdmin.outcome.unavailable'))).toBeTruthy();
    expect(
      screen.getByRole('button', { name: i18n.getFixedT(language)('shell.accessAdmin.common.retry') }),
    ).toBeTruthy();
    expect(screen.queryByText(i18n.getFixedT(language)('shell.accessAdmin.outcome.denied'))).toBeNull();
  });
}

test('projects withheld metadata to no people or roles, even from an inconsistent response', () => {
  const detailed = Schema.decodeUnknownSync(ExplainAccessResponseSchema)({
    ...response(),
    authority: [
      {
        capabilityKey: query.capabilityKey,
        mode: 'run',
        roleId: '10000000-0000-4000-8000-000000000001',
        roleName: 'Secret role',
        selector: 'all',
      },
    ],
    grantableBy: [{ displayName: 'Secret administrator', principalId: '20000000-0000-4000-8000-000000000001' }],
  });
  renderCopy(<WhyResult onRetry={noop} result={whyDecisionView(detailed, query)} />);
  expect(document.body.textContent).not.toContain('Secret');
  expect(screen.queryByRole('region', { name: en.shell.accessAdmin.why.grantableBy })).toBeNull();
  cleanup();
  renderCopy(
    <WhyResult onRetry={noop} result={whyDecisionView({ ...detailed, authorityMetadata: 'included' }, query)} />,
  );
  expect(screen.getByText('Secret role')).toBeTruthy();
  expect(screen.getByText('Secret administrator')).toBeTruthy();
});

it.effect('keeps metadata loading failure separate from the actual decision and permits retry', () =>
  Effect.gen(function* metadataRetry() {
    const retry = rstest.fn<() => void>();
    renderCopy(<WhyResult onRetry={retry} result={whyDecisionView(response('ALLOWED', 'unavailable'), query)} />);
    expect(screen.getByText(en.shell.accessAdmin.outcome.allowed)).toBeTruthy();
    expect(screen.getByText(en.shell.accessAdmin.why.authorityUnavailable)).toBeTruthy();
    yield* Effect.promise(() =>
      userEvent.setup().click(screen.getByRole('button', { name: en.shell.accessAdmin.common.retry })),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  }),
);

test('names the roles that admit the decision while the people who could grant it stay unknown', () => {
  const unavailable = Schema.decodeUnknownSync(ExplainAccessResponseSchema)({
    ...response('ALLOWED', 'unavailable'),
    authority: [
      {
        capabilityKey: query.capabilityKey,
        mode: 'run',
        roleId: '10000000-0000-4000-8000-000000000001',
        roleName: 'Úpravy produktů z ERP',
        selector: 'all',
      },
    ],
  });
  renderCopy(<WhyResult onRetry={noop} result={whyDecisionView(unavailable, query)} />);
  expect(screen.getByRole('region', { name: en.shell.accessAdmin.why.authority }).textContent).toContain(
    'Úpravy produktů z ERP',
  );
  expect(screen.queryByRole('region', { name: en.shell.accessAdmin.why.grantableBy })).toBeNull();
  expect(screen.getByText(en.shell.accessAdmin.why.authorityUnavailable)).toBeTruthy();
});

test('never renders raw unknown reason codes or diagnostics', () => {
  expect(whyReasonKey('private.db.failure user@example.test')).toBe('shell.accessAdmin.why.unknownReason');
  expect(whyReasonKey('deny.insufficient_grant')).toBe('shell.accessAdmin.reason.deny.insufficient_grant');
  for (const basis of ['owner', 'access_admin', 'access_admin_any', 'delegation']) {
    expect(whyReasonKey(`structural.${basis}`)).toBe(`shell.accessAdmin.reason.structural.${basis}`);
  }
});

test('request access remains disabled', () => {
  renderCopy(<WhyView draft={query} onCheck={noop} onRetry={noop} pending={false} result={{ state: 'idle' }} />);
  const request = screen.getByRole('button', { name: en.shell.accessAdmin.why.requestAccess });
  expect(request.hasAttribute('disabled')).toBe(true);
  expect(request.getAttribute('aria-describedby')).toBe('why-request-unavailable');
  expect(screen.getByText(en.shell.accessAdmin.why.requestAccessUnavailable)).toBeTruthy();
});

test('pending checks hide the previous decision and authority metadata', () => {
  renderCopy(
    <WhyView draft={query} onCheck={noop} onRetry={noop} pending result={whyDecisionView(response(), query)} />,
  );
  expect(screen.queryByText(en.shell.accessAdmin.outcome.allowed)).toBeNull();
  expect(screen.getByRole('button', { name: en.shell.accessAdmin.common.loading }).hasAttribute('disabled')).toBe(true);
});

it.effect('submits a bounded exact context with no administrator or subject flags', () =>
  Effect.gen(function* submitContext() {
    const check = rstest.fn<(draft: WhySearchDraft) => void>();
    renderCopy(<WhyView draft={query} onCheck={check} onRetry={noop} pending={false} result={{ state: 'idle' }} />);
    yield* Effect.promise(() =>
      userEvent.setup().click(screen.getByRole('button', { name: en.shell.accessAdmin.why.submit })),
    );
    expect(check).toHaveBeenCalledWith(query);
  }),
);

it.effect(
  'refuses partial records, partial amounts, unsafe integers and unsupported modes before calling the BFF',
  () => {
    const bff = whyBff();
    return Effect.gen(function* invalidContexts() {
      for (const invalid of [
        { ...query, targetModule: '' },
        { ...query, recordKey: '' },
        { ...query, currency: '' },
        { ...query, minor: '' },
        { ...query, minor: '-1' },
        { ...query, minor: '1.5' },
        { ...query, minor: '9007199254740992' },
        { ...query, mode: 'approve' },
        { ...query, companyId: 'not-a-uuid' },
      ]) {
        expect(Option.isNone(decodeWhySearch(invalid))).toBe(true);
        expect(yield* checkWhySearch(invalid)).toEqual({ state: 'invalid' });
      }
      expect(bff.requests).toEqual([]);
      expect(Option.isSome(decodeWhySearch({ ...emptyWhySearch, capabilityKey: query.capabilityKey }))).toBe(true);
      expect(Option.isSome(decodeWhySearch({ ...query, minor: '0' }))).toBe(true);
    }).pipe(Effect.provide(bff.layer));
  },
);

it.effect('maps a 503 to unavailable and 403 surface refusal to forbidden, without retaining an old result', () =>
  Effect.gen(function* transportFailures() {
    const unavailable = whyBff({
      explainAccess: () =>
        Effect.fail(
          Schema.decodeUnknownSync(AccessAdminUnavailableProblemSchema)({
            _tag: 'AccessAdminUnavailable',
            detail: 'redacted',
            retryable: true,
            status: 503,
            title: 'Unavailable',
            type: 'about:blank',
          }),
        ),
    });
    expect(yield* checkWhySearch(query).pipe(Effect.provide(unavailable.layer))).toEqual({ state: 'unavailable' });
    const forbidden = whyBff({
      explainAccess: () =>
        Effect.fail(
          Schema.decodeUnknownSync(AccessAdminForbiddenProblemSchema)({
            _tag: 'AccessAdminForbidden',
            detail: 'redacted',
            status: 403,
            title: 'Forbidden',
            type: 'about:blank',
          }),
        ),
    });
    expect(yield* checkWhySearch(query).pipe(Effect.provide(forbidden.layer))).toEqual({ state: 'forbidden' });
  }),
);

it.effect(
  'loads contextual explanations without a selected company and never substitutes the selected company into tenant scope',
  () =>
    Effect.gen(function* tenantContext() {
      const bff = whyBff(signedInShellReads(adaSelectingCompany));
      const model = yield* loadWhyPageModel(
        new Request(`https://example.test/en/access/why?capabilityKey=${query.capabilityKey}`),
      ).pipe(Effect.provide(bff.layer));
      expect(model.shell).toMatchObject({ contextState: 'selection_required', state: 'authenticated' });
      expect(model.result.state).toBe('decision');
      expect(explanations(bff)).toEqual([
        {
          capabilityKey: query.capabilityKey,
          mode: 'run',
          scope: { kind: 'tenant' },
        },
      ]);
    }),
);

it.effect('never requests an explanation for an anonymous or unavailable session', () =>
  Effect.gen(function* unauthenticatedContexts() {
    const anonymous = whyBff({
      currentSession: () => Effect.succeed(Schema.decodeUnknownSync(CurrentSessionSchema)({ state: 'anonymous' })),
    });
    const unavailable = whyBff({
      currentSession: () =>
        Effect.fail(
          Schema.decodeUnknownSync(AuthenticationUnavailableProblemSchema)({
            _tag: 'AuthenticationUnavailableProblem',
            detail: 'redacted',
            status: 503,
            title: 'Unavailable',
            type: 'about:blank',
          }),
        ),
    });
    for (const [state, bff] of [
      ['anonymous', anonymous],
      ['unavailable', unavailable],
    ] as const) {
      const model = yield* loadWhyPageModel(
        new Request(`https://example.test/en/access/why?capabilityKey=${query.capabilityKey}`),
      ).pipe(Effect.provide(bff.layer));
      expect(model.shell.state).toBe(state);
      expect(explanations(bff)).toEqual([]);
    }
  }),
);

test('context URL cannot supply a decision, authority metadata, tenant or acting person', () => {
  const draft = Option.getOrThrow(
    whySearchFromRequest(
      new Request(
        `https://example.test/en/access/why?capabilityKey=${query.capabilityKey}&mode=approve&outcome=ALLOWED&administrator=true&principalId=someone-else&tenantId=other`,
      ),
    ),
  );
  expect(draft.mode).toBe('approve');
  expect(Option.isNone(decodeWhySearch(draft))).toBe(true);
  expect(Object.keys(draft).toSorted()).toEqual(Object.keys(emptyWhySearch).toSorted());
});

const personId = '20000000-0000-4000-8000-000000000001';
const peopleResponse = () =>
  Schema.decodeUnknownSync(ListAccessPeopleResponseSchema)({
    items: [
      {
        assignments: [],
        delegations: [],
        displayName: 'Ada Lovelace',
        memberships: [],
        ownership: { administersScopes: [], soleAdministratorScopes: [] },
        principalId: personId,
        suspended: false,
        teams: [],
      },
    ],
    nextCursor: 'next-page',
    revision: 'revision-1',
  });

it.effect('hides the person picker on a governed list denial and does not guess administrator status', () =>
  Effect.gen(function* forbiddenPicker() {
    const options = yield* loadWhySubjects().pipe(Effect.provide(whyBff().layer));
    expect(options).toEqual({ state: 'hidden' });
    renderCopy(<WhySubjectPicker options={options} pending={false} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(en.shell.accessAdmin.why.subjectPickerLabel)).toBeNull();
  }),
);

test('unbacked person lookup shows unavailability, not an enabled picker or fake directory', () => {
  renderCopy(<WhySubjectPicker options={{ state: 'unavailable' }} pending={false} />);
  expect(screen.getByText(en.shell.accessAdmin.why.subjectPickerUnavailable)).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it.effect('admin picker uses only governed tenant members and loads another page only on explicit request', () =>
  Effect.gen(function* memberPicker() {
    const bff = whyBff({ listAccessPeople: () => Effect.succeed(peopleResponse()) });
    const options = yield* loadWhySubjects().pipe(Effect.provide(bff.layer));
    const more = rstest.fn<() => void>();
    renderCopy(
      <WhyView
        draft={query}
        onCheck={noop}
        onMorePeople={more}
        onRetry={noop}
        pending={false}
        result={{ state: 'idle' }}
        subjects={options}
      />,
    );
    expect(screen.getByRole('combobox', { name: en.shell.accessAdmin.why.subjectPickerLabel })).toBeTruthy();
    expect(peopleReads(bff)).toEqual([{ limit: 100 }]);
    expect(more).not.toHaveBeenCalled();
    yield* Effect.promise(() =>
      userEvent.setup().click(screen.getByRole('button', { name: en.shell.accessAdmin.why.morePeople })),
    );
    expect(more).toHaveBeenCalledTimes(1);
    yield* loadWhySubjects(undefined, 'next-page').pipe(Effect.provide(bff.layer));
    expect(peopleReads(bff).at(-1)).toEqual({ cursor: 'next-page', limit: 100 });
  }),
);

it.effect('selects a tenant member by keyboard and preserves the entered context after submit', () =>
  Effect.gen(function* selectSubject() {
    const bff = whyBff({ listAccessPeople: () => Effect.succeed(peopleResponse()) });
    const subjects = yield* loadWhySubjects().pipe(Effect.provide(bff.layer));
    const check = rstest.fn<(draft: WhySearchDraft) => void>();
    renderCopy(
      <WhyView
        draft={query}
        onCheck={check}
        onRetry={noop}
        pending={false}
        result={{ state: 'idle' }}
        subjects={subjects}
      />,
    );
    const user = userEvent.setup();
    const picker = screen.getByRole('combobox', { name: en.shell.accessAdmin.why.subjectPickerLabel });
    picker.focus();
    yield* Effect.promise(() => user.keyboard('{ArrowDown}{ArrowDown}{Enter}'));
    expect(picker.textContent).toContain('Ada Lovelace');
    yield* Effect.promise(() =>
      user.clear(screen.getByLabelText(en.shell.accessAdmin.why.capabilityKey, { exact: false })),
    );
    yield* Effect.promise(() =>
      user.type(
        screen.getByLabelText(en.shell.accessAdmin.why.capabilityKey, { exact: false }),
        'commerce.order.order.edit',
      ),
    );
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: en.shell.accessAdmin.why.submit })));
    expect(check).toHaveBeenCalledWith({ ...query, capabilityKey: 'commerce.order.order.edit', subject: personId });
    expect(screen.getByDisplayValue('commerce.order.order.edit')).toBeTruthy();
  }),
);

it.effect('binds admin checks to a returned person id and rejects a fabricated or unavailable subject', () =>
  Effect.gen(function* boundSubject() {
    const bff = whyBff({ listAccessPeople: () => Effect.succeed(peopleResponse()) });
    const subjects = yield* loadWhySubjects().pipe(Effect.provide(bff.layer));
    const result = yield* checkWhySearch({ ...query, subject: personId }, undefined, subjects).pipe(
      Effect.provide(bff.layer),
    );
    expect(explanations(bff)).toEqual([expect.objectContaining({ subjectPrincipalId: personId })]);
    expect(result.state).toBe('decision');
    renderCopy(<WhyResult onRetry={noop} result={result} />);
    expect(screen.getByText(en.shell.accessAdmin.why.checkingPerson.replace('{{name}}', 'Ada Lovelace'))).toBeTruthy();
    const refusedBff = whyBff();
    const refusedCheck = (subject: string, options: typeof subjects) =>
      checkWhySearch({ ...query, subject }, undefined, options).pipe(Effect.provide(refusedBff.layer));
    expect(yield* refusedCheck('20000000-0000-4000-8000-000000000099', subjects)).toEqual({ state: 'invalid' });
    expect(yield* refusedCheck(personId, { state: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(yield* refusedCheck(personId, { state: 'hidden' })).toEqual({ state: 'forbidden' });
    expect(refusedBff.requests).toEqual([]);
  }),
);

test('a subject-question 403 clears the selection and keeps the picker hidden until a fresh page admission', () => {
  const previous = { draft: query, result: { state: 'idle' as const }, subjectsDenied: false };
  const refused = completeWhyCheck(previous, { ...query, subject: personId }, { state: 'forbidden' });
  expect(refused.draft.subject).toBe('');
  expect(refused.subjectsDenied).toBe(true);
  renderCopy(
    <WhyView
      draft={refused.draft}
      onCheck={noop}
      onRetry={noop}
      pending={false}
      result={refused.result}
      subjects={hiddenWhySubjects}
    />,
  );
  expect(screen.queryByRole('combobox', { name: en.shell.accessAdmin.why.subjectPickerLabel })).toBeNull();
  expect(document.body.textContent).not.toContain('Ada Lovelace');
  expect(completeWhyCheck(refused, query, whyDecisionView(response(), query)).subjectsDenied).toBe(true);
  expect(completeWhyCheck(previous, query, { state: 'forbidden' }).subjectsDenied).toBe(false);
});

test('does not merge people from different list revisions or retain names after a denial', () => {
  const previous = {
    nextCursor: 'next',
    people: [{ label: 'Old member', value: personId }],
    revision: 'r1',
    state: 'ready' as const,
  };
  const next = {
    nextCursor: null,
    people: [{ label: 'New member', value: '20000000-0000-4000-8000-000000000002' }],
    revision: 'r2',
    state: 'ready' as const,
  };
  expect(mergeWhySubjects(previous, next)).toEqual(next);
  expect(mergeWhySubjects(previous, { state: 'hidden' })).toEqual({ state: 'hidden' });
  expect(mergeWhySubjects(previous, { ...next, revision: 'r1' })).toMatchObject({
    people: [...previous.people, ...next.people],
  });
});

/** The Why view as a person sees it for a given picker state, reporting checks to `check`. */
const checkingView = (check: (draft: WhySearchDraft) => void, options: WhySubjectOptions) => (
  <WhyView draft={query} onCheck={check} onRetry={noop} pending={false} result={{ state: 'idle' }} subjects={options} />
);

it.effect('a picked person a new people list no longer offers must be chosen again before a check', () =>
  Effect.gen(function* withdrawnSubject() {
    const bff = whyBff({ listAccessPeople: () => Effect.succeed(peopleResponse()) });
    const subjects = yield* loadWhySubjects().pipe(Effect.provide(bff.layer));
    const check = rstest.fn<(draft: WhySearchDraft) => void>();
    const view = (options: WhySubjectOptions) => checkingView(check, options);
    const rendered = renderCopy(view(subjects));
    const user = userEvent.setup();
    const picker = screen.getByRole('combobox', { name: en.shell.accessAdmin.why.subjectPickerLabel });
    picker.focus();
    yield* Effect.promise(() => user.keyboard('{ArrowDown}{ArrowDown}{Enter}'));
    expect(picker.textContent).toContain('Ada Lovelace');
    rendered.rerender(
      view({
        nextCursor: null,
        people: [{ label: 'Grace Hopper', value: '20000000-0000-4000-8000-000000000002' }],
        revision: 'r2',
        state: 'ready',
      }),
    );
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: en.shell.accessAdmin.why.submit })));
    expect(yield* Effect.promise(() => screen.findByText(en.shell.accessAdmin.why.subjectWithdrawn))).toBeTruthy();
    expect(picker.getAttribute('aria-invalid')).toBe('true');
    expect(check).not.toHaveBeenCalled();
  }),
);
it.effect('refuses a picked person once the picker is unavailable and lets the person check their own access', () =>
  Effect.gen(function* unavailablePicker() {
    const check = rstest.fn<(draft: WhySearchDraft) => void>();
    const subjects = {
      nextCursor: 'next',
      people: [{ label: 'Ada Lovelace', value: '20000000-0000-4000-8000-000000000001' }],
      revision: 'r1',
      state: 'ready',
    } as const;
    const view = (options: WhySubjectOptions) => checkingView(check, options);
    const rendered = renderCopy(view(subjects));
    const user = userEvent.setup();
    const picker = screen.getByRole('combobox', { name: en.shell.accessAdmin.why.subjectPickerLabel });
    picker.focus();
    yield* Effect.promise(() => user.keyboard('{ArrowDown}{ArrowDown}{Enter}'));
    rendered.rerender(view({ state: 'unavailable' }));
    expect(screen.getByText(en.shell.accessAdmin.why.subjectWithdrawn)).toBeTruthy();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: en.shell.accessAdmin.why.submit })));
    expect(check).not.toHaveBeenCalled();
    yield* Effect.promise(() =>
      user.click(screen.getByRole('button', { name: en.shell.accessAdmin.why.currentPersonChoice })),
    );
    expect(screen.queryByText(en.shell.accessAdmin.why.subjectWithdrawn)).toBeNull();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: en.shell.accessAdmin.why.submit })));
    expect(check).toHaveBeenCalledWith({ ...query, subject: '' });
  }),
);

it.effect('Check without a capability key asks for one and keeps the previous result', () =>
  Effect.gen(function* missingCapability() {
    const check = rstest.fn<(draft: WhySearchDraft) => void>();
    renderCopy(
      <WhyView
        draft={{ ...query, capabilityKey: '' }}
        onCheck={check}
        onRetry={noop}
        pending={false}
        result={whyDecisionView(response(), query)}
      />,
    );
    const user = userEvent.setup();
    const capabilityKey = screen.getByLabelText(en.shell.accessAdmin.why.capabilityKey, { exact: false });
    yield* Effect.promise(() => user.type(capabilityKey, '   '));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: en.shell.accessAdmin.why.submit })));
    expect(yield* Effect.promise(() => screen.findByText(en.shell.accessAdmin.why.capabilityKeyRequired))).toBeTruthy();
    expect(capabilityKey.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(en.shell.accessAdmin.outcome.allowed)).toBeTruthy();
    expect(check).not.toHaveBeenCalled();
    yield* Effect.promise(() => user.type(capabilityKey, 'commerce.order.order.read'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: en.shell.accessAdmin.why.submit })));
    expect(check).toHaveBeenCalledWith(query);
  }),
);
