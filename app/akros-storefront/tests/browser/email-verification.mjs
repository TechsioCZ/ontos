import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Requires the genuine local realm, enrollment continuation, dispatcher and Mailpit.
const base = new URL(process.env.AKROS_TEST_BASE_URL ?? "http://localhost:3070");
const mailpit = new URL(process.env.AKROS_MAILPIT_URL ?? "http://localhost:8026");
for (const url of [base, mailpit]) {
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname), "Run against local services only");
}
const email = process.env.AKROS_CUSTOMER_EMAIL;
const password = process.env.AKROS_CUSTOMER_PASSWORD;
assert.ok(email && password, "Supply a new AKROS_CUSTOMER_EMAIL and AKROS_CUSTOMER_PASSWORD");
const { openTab } = await import(
  process.env.AKROS_SHARED_BROWSER_CLIENT ??
    "/Volumes/TraceDecayKingston/techsio-demo/shared-browser/client.mjs"
);
const tab = await openTab({ viewport: { width: 1440, height: 1000 } });
try {
  const { page, context } = tab;
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  const verifyPath = "/commerce-customer-context-api/api/portal-auth/verify-email";
  await page.goto(new URL(`${verifyPath}?token=not-a-real-token`, base).href);
  assert.equal(new URL(page.url()).pathname, "/overeni-emailu");
  assert.equal(new URL(page.url()).searchParams.get("stav"), "neplatne");
  assert.ok(
    await page.getByRole("heading", { name: "E-mail nebyl ověřen", exact: true }).isVisible(),
  );
  assert.equal(
    await page.getByRole("link", { name: "Přejít k přihlášení" }).getAttribute("href"),
    "/prihlaseni",
  );
  await page.goto(new URL("/registrace", base).href, { waitUntil: "domcontentloaded" });
  await page.locator("#register-first-name").fill("Ověření");
  await page.locator("#register-last-name").fill("Zákazníka");
  await page.locator("#register-email").fill(email);
  await page.locator("#register-phone").fill("+420777123456");
  await page.locator("#register-password").fill(password);
  await page.locator("#register-password-confirm").fill(password);
  const terms = page.getByRole("checkbox", { name: /Souhlasím s obchodními podmínkami/ });
  await terms.focus();
  await terms.press("Space");
  assert.equal(
    await terms.isChecked(),
    true,
    "Terms must be checked through the real keyboard interaction",
  );
  const registrationResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ontos/account" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Vytvořit účet", exact: true }).click();
  const registration = await registrationResponse;
  assert.equal(registration.status(), 200, "Real enrollment must accept registration");
  assert.equal((await registration.json()).outcome, "ENROLLMENT_STARTED");
  await page.getByRole("status").filter({ hasText: "Registrace byla přijata" }).waitFor();
  const search = new URL("/api/v1/search", mailpit);
  search.searchParams.set("query", `to:${email}`);
  async function nextVerificationMessage(excludeIds = new Set()) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const list = await fetch(search).then((response) => response.json());
      for (const message of list.messages) {
        if (excludeIds.has(message.ID)) continue;
        const mail = await fetch(new URL(`/api/v1/message/${message.ID}`, mailpit)).then(
          (response) => response.json(),
        );
        const content = `${mail.Text ?? ""}\n${mail.HTML ?? ""}`.replaceAll("&amp;", "&");
        const link = content.match(
          /https?:\/\/[^\s"<>]+\/commerce-customer-context-api\/api\/portal-auth\/verify-email\?[^\s"<>]+/u,
        )?.[0];
        if (link) {
          const url = new URL(link);
          assert.equal(url.origin, base.origin, "The realm must generate the storefront origin");
          assert.equal(url.pathname, verifyPath);
          assert.ok(url.searchParams.get("token"), "Generated link must carry a token");
          return { id: message.ID, url };
        }
      }
      await delay(1000);
    }
    throw new Error("Mailpit did not receive the real generated verification email");
  }
  const originalMessage = await nextVerificationMessage();
  await page.goto(new URL("/prihlaseni", base).href, { waitUntil: "domcontentloaded" });
  await page.locator("#verification-resend-email").fill(email);
  const resendResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ontos/account" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Poslat ověřovací e-mail znovu", exact: true }).click();
  const resend = await resendResponse;
  assert.equal(resend.status(), 200, "The real owner must accept verification resend");
  assert.deepEqual(await resend.json(), { outcome: "EMAIL_VERIFICATION_STARTED" });
  await page
    .getByRole("status")
    .filter({ hasText: "Pokud účet s tímto e-mailem čeká na ověření" })
    .waitFor();
  const resentMessage = await nextVerificationMessage(new Set([originalMessage.id]));
  const verificationUrl = resentMessage.url;
  // Do not let navigation errors echo the real one-time token in a Playwright call log.
  const followLink = async () => {
    try {
      await page.goto(verificationUrl.href, { waitUntil: "domcontentloaded" });
    } catch {
      throw new Error("The generated verification link did not reach the storefront landing");
    }
  };
  await followLink();
  const landing = new URL(page.url());
  assert.equal(landing.pathname, "/overeni-emailu");
  assert.equal(landing.searchParams.get("stav"), "overeno");
  assert.equal(landing.searchParams.has("token"), false);
  assert.ok(
    await page.getByRole("heading", { name: "E-mail byl ověřen", exact: true }).isVisible(),
  );
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name.endsWith("session_token")),
    false,
    "Email verification must not grant a session",
  );
  await followLink();
  assert.equal(
    new URL(page.url()).searchParams.get("stav"),
    "neplatne",
    "A consumed token must be refused",
  );
  await page.getByRole("link", { name: "Přejít k přihlášení" }).click();
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  const loginResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ontos/account" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Přihlásit se", exact: true }).click();
  const login = await loginResponse;
  assert.equal(login.status(), 200, "The verified customer must be able to sign in");
  assert.equal((await login.json()).outcome, "SESSION_CREATED");
  await page.locator("#account-email").waitFor();
  assert.equal(await page.locator("#account-email").inputValue(), email);
  console.log(
    "Real Mailpit verification: registration, native resend and second delivered link, Czech success/invalid/replay landing, no granted session and customer login passed.",
  );
} finally {
  await tab.close();
}
