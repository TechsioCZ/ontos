import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Edits a real local customer's Party through the commerce owner, not browser storage.
const base = new URL(process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3070");
assert.ok(["localhost", "127.0.0.1"].includes(base.hostname), "Run against the local demo only");
const email = process.env.AKROS_CUSTOMER_EMAIL;
const password = process.env.AKROS_CUSTOMER_PASSWORD;
assert.ok(
  email && password,
  "Supply a real verified AKROS_CUSTOMER_EMAIL and AKROS_CUSTOMER_PASSWORD",
);
// Shared browser client module (exports `openTab`); machine-specific, so it is configured, never hard-coded.
assert.ok(
  process.env.AKROS_SHARED_BROWSER_CLIENT,
  "Set AKROS_SHARED_BROWSER_CLIENT to the shared browser client module (exports openTab)",
);
const { openTab } = await import(process.env.AKROS_SHARED_BROWSER_CLIENT);
const tab = await openTab({ viewport: { width: 1440, height: 1000 } });
try {
  const { page, context } = tab;
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  const profileUrl = new URL("/api/ontos/account/profile", base).href;
  const headers = { origin: base.origin };
  const anonymous = await context.request.get(profileUrl);
  assert.equal(anonymous.status(), 401, "Anonymous profile reads must be refused");
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
  assert.equal(login.status(), 200, "Real customer sign-in must succeed");
  assert.equal((await login.json()).outcome, "SESSION_CREATED");
  await page.locator("#account-phone").waitFor();
  assert.equal(await page.locator("#account-email").inputValue(), email);
  assert.equal(await page.locator("#account-email").getAttribute("readonly"), "");
  // Password inputs exist only in the separate password-change block, never in the profile form.
  assert.equal(await page.locator('form input[type="password"]').count(), 0);
  assert.equal(await page.locator('#zmena-hesla input[type="password"]').count(), 2);
  const passwordRequests = [];
  page.on("request", (request) => {
    if (request.postData()?.includes("never-persist-me")) passwordRequests.push(request.url());
  });
  await page.getByRole("button", { name: "Změnit heslo", exact: true }).click();
  await page.getByText("Vyplňte nové heslo.", { exact: true }).waitFor();
  await page.locator("#account-password").fill("never-persist-me");
  await page.locator("#account-password-confirmation").fill("different");
  await page.getByRole("button", { name: "Změnit heslo", exact: true }).click();
  await page.getByText("Hesla se neshodují.", { exact: true }).waitFor();
  await page.locator("#account-password-confirmation").fill("never-persist-me");
  await page.locator("#account-password-confirmation").press("Enter");
  // OntOS offers no signed-in password change: the demo form says so and never claims success.
  await page
    .getByText("Změna hesla zatím není připojena k účtu. Ostatní údaje můžete uložit samostatně.", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(passwordRequests, [], "The demo password form must not send the password");
  await page.locator("#account-password").fill("");
  await page.locator("#account-password-confirmation").fill("");
  const beforeResponse = await context.request.get(profileUrl);
  assert.equal(beforeResponse.status(), 200);
  const { profile: before } = await beforeResponse.json();
  const phone = before.phone === "+420777234567" ? "+420777234568" : "+420777234567";
  await page.locator("#account-phone").fill(phone);
  const savedResponse = page.waitForResponse(
    (response) => response.url() === profileUrl && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Uložit změny", exact: true }).click();
  const saved = await savedResponse;
  assert.equal(
    saved.status(),
    200,
    "The owner must confirm persistence, not merely accept a request",
  );
  const result = await saved.json();
  assert.equal(result.outcome, "PROFILE_SAVED");
  assert.equal(result.profile.phone, phone);
  await page.getByRole("status").filter({ hasText: "Údaje byly uloženy" }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("#account-phone").inputValue(), phone);
  const fresh = await context.request.get(profileUrl);
  assert.equal(fresh.status(), 200);
  const { profile } = await fresh.json();
  assert.equal(profile.phone, phone);
  assert.notEqual(
    profile.version,
    before.version,
    "Native persistence must advance the opaque version",
  );
  const stale = await context.request.post(profileUrl, { headers, data: before });
  assert.equal(stale.status(), 409, "A stale native revision must not overwrite newer data");
  const forged = await context.request.post(profileUrl, {
    headers,
    data: {
      ...profile,
      partyId: randomUUID(),
      tenantId: randomUUID(),
      legalEntityId: randomUUID(),
      contactPointRef: { resourceId: randomUUID() },
      email: "forged-login@example.test",
      password: "must-not-become-a-credential",
    },
  });
  assert.equal(
    forged.status(),
    200,
    "The BFF must discard browser identity fields before owner dispatch",
  );
  assert.deepEqual((await forged.json()).profile, profile);
  const account = await context.request.get(new URL("/api/ontos/account", base).href);
  assert.equal(account.status(), 200);
  assert.equal(
    (await account.json()).account.email,
    email,
    "Contact editing must never change login identity",
  );
  const crossOrigin = await context.request.post(profileUrl, {
    headers: { origin: "https://other.example" },
    data: profile,
  });
  assert.equal(crossOrigin.status(), 403);
  const logoutResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ontos/account" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Odhlásit se", exact: true }).click();
  assert.equal((await logoutResponse).status(), 200);
  await page.waitForURL(new URL("/prihlaseni", base).href);
  assert.equal((await context.request.get(profileUrl)).status(), 401);
  console.log(
    "Real profile: login, persisted phone, fresh read/reload, stale conflict, forged identities, cross-origin refusal and logout passed.",
  );
} finally {
  await tab.close();
}
