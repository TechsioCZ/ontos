import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Redacted } from "effect";
import { STAGE_CUSTOMER_EMAIL } from "../../../scripts/demo/prepare-stage-customer.mts";
import { DEFAULT_PASSWORD } from "../../../scripts/ops/stage-demo-verify.mjs";

// Only CI may exercise the existing operator-prepared stage customer.
assert.equal(process.env.CI, "true", "Run this browser proof on the CI runner only");
assert.equal(process.env.AKROS_TEST_BASE_URL, "https://ontos-stage-akros.bleeding.dev");
const base = new URL(process.env.AKROS_TEST_BASE_URL);
assert.ok(process.env.RUNNER_TEMP, "The CI runner must own the screenshot directory");
const runnerTemp = resolve(process.env.RUNNER_TEMP);
const evidence = resolve(process.env.AKROS_EVIDENCE_DIR ?? join(runnerTemp, "newsletter-consent"));
const evidenceRelative = relative(runnerTemp, evidence);
assert.ok(
  evidenceRelative &&
    evidenceRelative !== ".." &&
    !evidenceRelative.startsWith("../") &&
    !isAbsolute(evidenceRelative),
  "Newsletter screenshots must stay inside the runner temp",
);
assert.ok(process.env.E2E_PLAYWRIGHT_MODULE, "Resolve the existing CI Playwright module first");
const playwright = await import(pathToFileURL(process.env.E2E_PLAYWRIGHT_MODULE).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
assert.ok(chromium, "The existing CI Playwright module must expose Chromium");
const url = new URL("/api/ontos/account/consent", base).href;
const headers = { origin: base.origin };
let browser;
let context;
let authenticated = false;
let phase = "browser startup";
const notice = {
  language: "cs",
  noticeVersionId: "demo-newsletter.cs.v1",
  wording:
    "Souhlasím se zasíláním novinek a obchodních nabídek AKROS na svůj kontaktní e-mail. Souhlas je dobrovolný, není podmínkou nákupu a mohu jej kdykoli odvolat v části Můj účet. Odvolání neovlivní zákonnost předchozího zpracování.",
};
const fresh = async () => {
  const response = await context.request.get(url);
  assert.equal(response.status(), 200, "Native Commerce must provide current consent");
  assert.equal(response.headers()["cache-control"], "no-store");
  const { consent } = await response.json();
  assert.ok(["ABSENT", "GRANTED", "WITHDRAWN"].includes(consent.decision));
  assert.ok(Number.isSafeInteger(consent.revision) && consent.revision >= 0);
  assert.deepEqual(
    consent.notice,
    notice,
    "Commerce must return the exact fixed Czech demo notice",
  );
  return consent;
};
try {
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  phase = "anonymous access and real login";
  assert.equal((await context.request.get(url)).status(), 401);
  assert.equal(
    (
      await context.request.post(url, {
        headers: { origin: "https://other.example" },
        data: {},
      })
    ).status(),
    403,
  );
  await page.goto(new URL("/prihlaseni", base).href, { waitUntil: "domcontentloaded" });
  await page.locator("#login-email").fill(STAGE_CUSTOMER_EMAIL);
  await page.locator("#login-password").fill(Redacted.value(DEFAULT_PASSWORD));
  const [login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/ontos/account" &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Přihlásit se", exact: true }).click(),
  ]);
  authenticated = login.status() === 200;
  assert.equal(login.status(), 200);
  assert.equal((await login.json()).outcome, "SESSION_CREATED");
  const checkbox = page.getByRole("checkbox", {
    name: "Souhlasím se zasíláním newsletteru e-mailem",
    exact: true,
  });
  await checkbox.waitFor();
  const before = await fresh();
  assert.equal(await checkbox.isChecked(), before.decision === "GRANTED");
  assert.ok(await page.getByText(before.notice.wording, { exact: true }).isVisible());
  const choose = async (decision) => {
    const previous = await fresh();
    assert.notEqual(previous.decision, decision, "The UI must make an explicit state change");
    await checkbox.focus();
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) => response.url() === url && response.request().method() === "POST",
      ),
      checkbox.press("Space"),
    ]);
    assert.equal(response.status(), 200, "Native Commerce must commit the requested choice");
    const input = response.request().postDataJSON();
    assert.deepEqual(Object.keys(input).sort(), [
      "decision",
      "expectedRevision",
      "noticeAcknowledged",
      "noticeVersionId",
      "requestId",
    ]);
    assert.equal(input.decision, decision);
    assert.equal(input.expectedRevision, previous.revision);
    assert.equal(input.noticeVersionId, previous.notice.noticeVersionId);
    assert.match(
      input.requestId,
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
    );
    assert.equal(input.noticeAcknowledged, decision === "GRANTED");
    const committed = (await response.json()).consent;
    assert.equal(committed.decision, decision);
    assert.equal(committed.revision, previous.revision + 1);
    assert.deepEqual(committed.notice, previous.notice);
    await page.getByRole("status").filter({ hasText: "Volba byla uložena v OntOS." }).waitFor();
    assert.equal(await checkbox.isChecked(), decision === "GRANTED");
    assert.deepEqual(await fresh(), committed, "POST must return the committed Commerce state");
    return { input, committed };
  };
  // A previous CI run may already have granted consent. Explicitly withdraw before granting again.
  phase = "explicit UI grant";
  if (before.decision === "GRANTED") await choose("WITHDRAWN");
  const { input: grant, committed: granted } = await choose("GRANTED");
  phase = "current replay and authority stripping";
  const replay = await context.request.post(url, { headers, data: grant });
  assert.equal(replay.status(), 200, "The unchanged latest request must replay without mutation");
  assert.deepEqual((await replay.json()).consent, granted);
  assert.deepEqual(await fresh(), granted);
  const forgedIdentity = await context.request.post(url, {
    headers,
    data: {
      ...grant,
      partyId: randomUUID(),
      tenantId: randomUUID(),
      legalEntityId: randomUUID(),
      actorPrincipalId: randomUUID(),
      providerSubjectId: "browser-selected-subject",
      sessionRef: "browser-selected-session",
      credentialRef: "browser-selected-credential",
      scope: { scopeRef: "browser-selected-scope" },
      proof: { kind: "browser-selected-proof" },
    },
  });
  assert.equal(
    forgedIdentity.status(),
    200,
    "The storefront must strip browser-selected authority",
  );
  assert.deepEqual((await forgedIdentity.json()).consent, granted);
  phase = "conflicting payload, invented notice and cross-origin refusal";
  const changed = await context.request.post(url, {
    headers,
    data: { ...grant, decision: "WITHDRAWN" },
  });
  assert.equal(changed.status(), 409, "A latest request UUID cannot authorize changed input");
  const versionForgery = await context.request.post(url, {
    headers,
    data: {
      ...grant,
      expectedRevision: granted.revision,
      requestId: randomUUID(),
      noticeVersionId: randomUUID(),
    },
  });
  assert.equal(versionForgery.status(), 409, "A browser cannot invent a demo notice version");
  const staleRevision = await context.request.post(url, {
    headers,
    data: { ...grant, requestId: randomUUID() },
  });
  assert.equal(staleRevision.status(), 409, "A new request must use the current revision");
  const crossOrigin = await context.request.post(url, {
    headers: { origin: "https://other.example" },
    data: grant,
  });
  assert.equal(crossOrigin.status(), 403);
  assert.deepEqual(await fresh(), granted);
  phase = "grant reload and screenshot";
  await page.reload({ waitUntil: "domcontentloaded" });
  await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), true, "Grant must survive a native GET and reload");
  await page.locator("section[aria-labelledby='newsletter-consent-heading']").screenshot({
    path: join(evidence, "newsletter-granted.png"),
  });
  phase = "explicit UI withdrawal and old grant replay";
  const { input: withdrawal, committed: withdrawn } = await choose("WITHDRAWN");
  assert.notEqual(withdrawal.requestId, grant.requestId);
  const oldGrant = await context.request.post(url, { headers, data: grant });
  assert.equal(oldGrant.status(), 409, "An old grant retry must never undo a later withdrawal");
  assert.deepEqual(await fresh(), withdrawn);
  phase = "withdrawal reload and screenshot";
  await page.reload({ waitUntil: "domcontentloaded" });
  await checkbox.waitFor();
  assert.equal(
    await checkbox.isChecked(),
    false,
    "Withdrawal must survive a native GET and reload",
  );
  assert.ok(await page.getByText("Stav v OntOS: souhlas odvolán.", { exact: true }).isVisible());
  assert.deepEqual(await fresh(), withdrawn);
  await page.locator("section[aria-labelledby='newsletter-consent-heading']").screenshot({
    path: join(evidence, "newsletter-withdrawn.png"),
  });
  phase = "logout and no signup intent";
  const [logout] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/ontos/account" &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Odhlásit se", exact: true }).click(),
  ]);
  assert.equal(logout.status(), 200);
  authenticated = false;
  await page.waitForURL(new URL("/prihlaseni", base).href);
  assert.equal((await context.request.get(url)).status(), 401);
  assert.equal(
    (
      await context.request.post(url, { headers, data: { ...grant, requestId: randomUUID() } })
    ).status(),
    401,
  );
  await page.goto(new URL("/registrace", base).href, { waitUntil: "domcontentloaded" });
  await page.locator("#register-email").waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /newsletter/i }).count(),
    0,
    "No newsletter intent is collected before identity verification",
  );
  console.log(
    "Real newsletter grant, revision conflicts, replay, authority stripping, persisted withdrawal and no signup intent passed.",
  );
} catch {
  // Playwright errors can contain filled input values. Never log raw errors, headers or credentials.
  console.error(`Newsletter proof failed during ${phase}.`);
  process.exitCode = 1;
} finally {
  try {
    // A failed assertion after a committed grant must not leave the shared fixture subscribed.
    if (authenticated) {
      const current = await fresh();
      if (current.decision !== "WITHDRAWN") {
        const cleanup = await context.request.post(url, {
          headers,
          data: {
            decision: "WITHDRAWN",
            noticeAcknowledged: false,
            noticeVersionId: current.notice.noticeVersionId,
            expectedRevision: current.revision,
            requestId: randomUUID(),
          },
        });
        assert.equal(cleanup.status(), 200);
      }
      assert.equal((await fresh()).decision, "WITHDRAWN");
    }
  } catch {
    console.error("Newsletter fixture withdrawal cleanup failed.");
    process.exitCode = 1;
  } finally {
    try {
      await context?.close();
    } catch {
      console.error("Newsletter browser context cleanup failed.");
      process.exitCode = 1;
    } finally {
      try {
        await browser?.close();
      } catch {
        console.error("Newsletter browser cleanup failed.");
        process.exitCode = 1;
      }
    }
  }
}
