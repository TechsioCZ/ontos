import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Requires a real verified Commerce account, native Privacy setup and migrated receipt owner.
const base = new URL(process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3070");
assert.ok(["localhost", "127.0.0.1"].includes(base.hostname), "Run against the local demo only");
const email = process.env.AKROS_CUSTOMER_EMAIL;
const password = process.env.AKROS_CUSTOMER_PASSWORD;
assert.ok(
  email && password,
  "Supply a real verified AKROS_CUSTOMER_EMAIL and AKROS_CUSTOMER_PASSWORD",
);
const evidence = process.env.AKROS_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const { openTab } = await import(
  process.env.AKROS_SHARED_BROWSER_CLIENT ??
    "/Volumes/TraceDecayKingston/techsio-demo/shared-browser/client.mjs"
);
const tab = await openTab({ viewport: { width: 1440, height: 1200 } });
try {
  const { page, context } = tab;
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  const url = new URL("/api/ontos/account/consent", base).href;
  const headers = { origin: base.origin };
  const fresh = async () => {
    const response = await context.request.get(url);
    assert.equal(response.status(), 200, "The actual owner must provide current consent");
    assert.equal(response.headers()["cache-control"], "no-store");
    const { consent } = await response.json();
    assert.ok(
      consent.notice.wording.trim(),
      "The owner must return actual immutable notice wording",
    );
    assert.match(consent.notice.noticeVersionId, /^[\da-f-]{36}$/i);
    assert.match(consent.notice.purposeVersionId, /^[\da-f-]{36}$/i);
    return consent;
  };
  assert.equal((await context.request.get(url)).status(), 401);
  await page.goto(new URL("/prihlaseni", base).href, { waitUntil: "domcontentloaded" });
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  const loginResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ontos/account" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Přihlásit se", exact: true }).click();
  const login = await loginResponse;
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
    const responsePromise = page.waitForResponse(
      (response) => response.url() === url && response.request().method() === "POST",
    );
    await checkbox.focus();
    await checkbox.press("Space");
    const response = await responsePromise;
    assert.equal(
      response.status(),
      200,
      "Native NoticeProvision and ConsentSelfService must both complete",
    );
    assert.equal((await response.json()).consent.decision, decision);
    await page.getByRole("status").filter({ hasText: "Volba byla uložena v OntOS." }).waitFor();
    assert.equal(await checkbox.isChecked(), decision === "GRANTED");
    return response.request().postDataJSON();
  };
  // Start from an actual ungranted state, never an assumed default.
  if (before.decision === "GRANTED") await choose("WITHDRAWN");
  const grant = await choose("GRANTED");
  assert.equal(grant.noticeAcknowledged, true);
  assert.equal(grant.noticeVersionId, before.notice.noticeVersionId);
  assert.equal(grant.purposeVersionId, before.notice.purposeVersionId);
  const replay = await context.request.post(url, { headers, data: grant });
  assert.equal(
    replay.status(),
    200,
    "An unchanged request retry must resolve the original owner operation",
  );
  const granted = (await replay.json()).consent;
  assert.equal(granted.decision, "GRANTED");
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
    "The BFF must discard browser-selected authority before replaying the real receipt",
  );
  assert.deepEqual((await forgedIdentity.json()).consent, granted);
  const changed = await context.request.post(url, {
    headers,
    data: { ...grant, decision: "WITHDRAWN" },
  });
  assert.equal(
    changed.status(),
    409,
    "A retained receipt UUID must not authorize different authored input",
  );
  const versionForgery = await context.request.post(url, {
    headers,
    data: { ...grant, requestId: randomUUID(), noticeVersionId: randomUUID() },
  });
  assert.equal(
    versionForgery.status(),
    409,
    "A browser cannot invent its own native notice version",
  );
  const crossOrigin = await context.request.post(url, {
    headers: { origin: "https://other.example" },
    data: grant,
  });
  assert.equal(crossOrigin.status(), 403);
  assert.equal((await fresh()).decision, "GRANTED");
  await page.reload({ waitUntil: "domcontentloaded" });
  await checkbox.waitFor();
  assert.equal(
    await checkbox.isChecked(),
    true,
    "Grant must survive a fresh owner read and page reload",
  );
  if (evidence)
    await page.screenshot({ path: join(evidence, "newsletter-granted.png"), fullPage: true });
  const withdrawal = await choose("WITHDRAWN");
  assert.notEqual(withdrawal.requestId, grant.requestId);
  assert.equal((await fresh()).decision, "WITHDRAWN");
  await page.reload({ waitUntil: "domcontentloaded" });
  await checkbox.waitFor();
  assert.equal(
    await checkbox.isChecked(),
    false,
    "Native withdrawal must survive a fresh owner read and page reload",
  );
  assert.ok(await page.getByText("Stav v OntOS: souhlas odvolán.", { exact: true }).isVisible());
  if (evidence)
    await page.screenshot({ path: join(evidence, "newsletter-withdrawn.png"), fullPage: true });
  const logoutResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ontos/account" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  assert.equal((await logoutResponse).status(), 200);
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
    "Real newsletter: exact native notice, grant, replay, forged identity stripping, changed-receipt conflict, forged-version refusal, cross-origin refusal, persisted withdrawal, logout and no signup intent passed.",
  );
} finally {
  await tab.close();
}
