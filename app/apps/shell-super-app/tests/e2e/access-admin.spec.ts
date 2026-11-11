import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Effect } from 'effect';

import { createAuthenticationFixture } from './auth-fixture.ts';
import type { AuthenticationFixture } from './auth-fixture.ts';

/*
 * P14 — the access administration surface in the browser (#1343).
 *
 * These are real browser flows against the real Shell and the real gate. They stay red until the
 * lanes that own the pieces land, and each failure names the piece:
 *
 * - P1 publishes the administration navigation and makes it reachable from a tenant context (a
 *   session with no selected company), and seeds that reach for an E2E tenant's owner;
 * - P8–P12 own the five pages, P13 owns the Czech and English copy;
 * - P5/P6 own the human approval and the "Schválit a provést mými právy" execution gate.
 *
 * The proposal these flows act on is created by calling the owner Action with `transport.intent =
 * 'propose'` (O80): this wave has no "Odeslat ke schválení" button, so the inbox only ever shows
 * proposals that an owner Action actually produced.
 */

const administrationPages = {
  approvals: '/access/approvals',
  changes: '/access/changes',
  people: '/access/people',
  roles: '/access/roles',
  why: '/access/why',
} as const;

const administrationPageKeys: readonly (keyof typeof administrationPages)[] = [
  'approvals',
  'changes',
  'people',
  'roles',
  'why',
];

const languages = ['cs', 'en'] as const;

const copy = {
  cs: {
    approvalExecute: 'Schválit a provést mými právy',
    navigation: 'Správa oprávnění',
    pages: {
      approvals: 'Ke schválení',
      changes: 'Novinky v oprávněních',
      people: 'Lidé',
      roles: 'Role',
      why: 'Proč?',
    },
    password: /^Heslo/u,
    signIn: 'Přihlásit se',
    subject: /^Přihlašovací jméno/u,
  },
  en: {
    approvalExecute: 'Approve and execute with my authority',
    navigation: 'Access administration',
    pages: {
      approvals: 'Approvals',
      changes: 'Permission changes',
      people: 'People',
      roles: 'Roles',
      why: 'Why?',
    },
    password: /^Password/u,
    signIn: 'Login',
    subject: /^Login/u,
  },
} as const;

type Language = keyof typeof copy;

const waitForHydratedLogin = async (page: Page, language: Language) => {
  await page.goto(`/${language}/login`);
  await page.waitForFunction(() => {
    const forms = [...document.querySelectorAll<HTMLFormElement>('form')].filter(
      (form) => form.querySelector('input[name="login"]') !== null,
    );
    return forms.some((form) => Object.hasOwn(form.dataset, 'hydrated'));
  });
};

const signIn = async (page: Page, language: Language, credentials: AuthenticationFixture['credentials']) => {
  await waitForHydratedLogin(page, language);
  const labels = copy[language];
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: labels.signIn }) })
    .first();
  await form.getByRole('textbox', { name: labels.subject }).fill(credentials.email);
  await form.getByLabel(labels.password).fill(credentials.password);
  await form.getByRole('button', { name: labels.signIn }).click();
  await expect(page).toHaveURL(new RegExp(`/${language}/?$`, 'u'));
  // The URL changes before the client hands the login screen over to the signed-in frame ("Opening the app…").
  // That hand-off waits on the session's company, composition and context reads, which take seconds on a cold
  // server; the caller's 5 s assertions must measure the rendered frame, not that hand-off.
  await page.locator('input[name="login"]').waitFor({ state: 'detached' });
};

/** The browser person this suite drives: the E2E login fixture's own human, in its own tenant. */
const test = base.extend<Record<never, never>, { authentication: AuthenticationFixture }>({
  authentication: [
    async ({ browserName: _browserName }, use) => {
      await Effect.runPromise(
        Effect.gen(function* useAuthenticationFixture() {
          const fixture = yield* Effect.timeout(createAuthenticationFixture(), '25 seconds');
          yield* Effect.tryPromise(async () => await use(fixture));
        }).pipe(Effect.scoped),
      );
    },
    { scope: 'worker', timeout: 0 },
  ],
});

for (const language of languages) {
  test(`shows the access administration navigation to the person (${language})`, async ({ authentication, page }) => {
    await signIn(page, language, authentication.credentials);
    // The administration surface is tenant work: it is offered before any company is selected (O28).
    const navigation = page.getByRole('navigation', { name: copy[language].navigation });
    await expect(navigation).toBeVisible();
    await Promise.all(
      Object.values(copy[language].pages).map((name) => expect(navigation.getByRole('link', { name })).toHaveCount(1)),
    );
  });
}

for (const language of languages) {
  for (const pageKey of administrationPageKeys) {
    test(`opens the ${pageKey} administration page from a session with no company selected (${language})`, async ({
      authentication,
      page,
    }) => {
      await signIn(page, language, authentication.credentials);
      await page.goto(`/${language}${administrationPages[pageKey]}`);
      await expect(page.getByRole('heading', { name: copy[language].pages[pageKey] })).toBeVisible();
      await expect(page.getByRole('region', { name: copy[language].navigation })).toBeVisible();
    });
  }
}

for (const language of languages) {
  for (const pageKey of administrationPageKeys) {
    test(`never offers an agent management or agent proposal control on ${pageKey} (O67-Q5, ${language})`, async ({
      authentication,
      page,
    }) => {
      await signIn(page, language, authentication.credentials);
      await page.goto(`/${language}${administrationPages[pageKey]}`);
      const agentControls = page.getByRole('button', { name: /agent|proposal|návrh/iu });
      await expect(agentControls).toHaveCount(0);
    });
  }
}

test('keeps approval and execution apart and names whose authority executes', async ({ authentication, page }) => {
  await signIn(page, 'cs', authentication.credentials);
  await page.goto(`/cs${administrationPages.approvals}`);
  await expect(page.getByRole('heading', { name: copy.cs.pages.approvals })).toBeVisible();
  // The inbox lists Core proposals only, and execution is offered only for an approved one, with the
  // approving human's own authority named (O63): a pending proposal never offers execution.
  const execute = page.getByRole('button', { name: copy.cs.approvalExecute });
  const approvedRows = page.getByRole('row').filter({ hasText: /Schváleno/u });
  const approvedCount = await approvedRows.count();
  await (approvedCount === 0 ? expect(execute).toHaveCount(0) : expect(execute.first()).toBeVisible());
});

test('explains one decision and keeps an unavailable engine distinct from a denial', async ({
  authentication,
  page,
}) => {
  await signIn(page, 'en', authentication.credentials);
  await page.goto(`/en${administrationPages.why}`);
  await expect(page.getByRole('heading', { name: copy.en.pages.why })).toBeVisible();
  await page.getByRole('textbox', { name: /Capability key/u }).fill('shell-super-app.access-approvals.list');
  await page.getByRole('button', { name: 'Get the decision' }).click();
  // The answer is one decision with its outcome, or an unavailable engine said in its own words: an
  // engine that cannot answer is never shown as a denial.
  const decision = page.getByRole('region', { name: 'Outcome' });
  const unavailable = page.getByText('Temporary unavailability is not a denial. Try again.');
  await expect(decision.or(unavailable)).toBeVisible();
  await expect(decision.getByText(/^(?:Allowed|Denied|Waiting for approval)$/u).or(unavailable)).toBeVisible();
});
