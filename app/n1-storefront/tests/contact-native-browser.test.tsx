import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@modern-js/bff-effect/effect-edge";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@rstest/core";
import { build } from "esbuild";
import { Effect, Layer, ManagedRuntime } from "effect";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { getDictionary } from "../src/i18n";
import { decodeInquiry, InquiryForbidden, InquiryUnavailable } from "../src/ontos/inquiry";
import type { Inquiry } from "../src/ontos/inquiry";
import { inquiryGuardKey } from "../src/features/inquiry-guard";
import { ownerServer } from "./support/owner-server";

const d = getDictionary("cs");
const requests: Inquiry[] = [];
const serverErrors: unknown[] = [];
const browserErrors: string[] = [];
let outcome: "forbidden" | "unavailable" = "forbidden";
const startOwner = (application: Parameters<typeof ownerServer>[0]) =>
  ManagedRuntime.make(ownerServer(application, {}));
let network: ReturnType<typeof startOwner>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let origin: string;

// A real browser is necessary: happy-dom's navigator.locks is null, so replacing it would hide
// the storage/lock admission that ContactView must pass before its actual generated HTTP client.
beforeAll(async () => {
  const bundle = await build({
    bundle: true,
    define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
        import { ToastProvider } from "@techsio/ui-kit/molecules/toast";
        import { ContactView } from "./src/features/contact-view";
        import { RequiredLabelProvider } from "./src/features/form-controls";
        import { getDictionary } from "./src/i18n";
        const d = getDictionary("cs");
        createRoot(document.getElementById("contact-root")).render(
          <PathParamsContext.Provider value={{ locale: "cs" }}>
            <RequiredLabelProvider requiredLabel={d.requiredLabel}>
              <ToastProvider><ContactView dictionary={d} /></ToastProvider>
            </RequiredLabelProvider>
          </PathParamsContext.Provider>
        );`,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error("Expected the real ContactView browser bundle");
  }
  const submit = Effect.gen(function* answerInquiry() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const inquiry = yield* request.json.pipe(Effect.flatMap(decodeInquiry));
    requests.push(inquiry);
    const details = {
      detail: "The inquiry was refused before writing.",
      title: "Inquiry submission",
      type: "urn:n1:inquiry",
    };
    const problem =
      outcome === "forbidden"
        ? InquiryForbidden.make({ ...details, status: 403 })
        : InquiryUnavailable.make({ ...details, status: 503 });
    return HttpServerResponse.jsonUnsafe(problem, {
      contentType: "application/problem+json",
      status: problem.status,
    });
  }).pipe(
    Effect.orDie,
    Effect.tapDefect((cause) =>
      Effect.sync(() => {
        serverErrors.push(cause);
      }),
    ),
  );
  const application = Layer.mergeAll(
    HttpRouter.add("POST", "/api/inquiries", submit),
    HttpRouter.add(
      "GET",
      "/contact.js",
      Effect.succeed(HttpServerResponse.text(script, { contentType: "text/javascript" })),
    ),
    HttpRouter.add(
      "GET",
      "/",
      Effect.succeed(
        HttpServerResponse.html(
          '<!doctype html><div id="contact-root"></div><script src="/contact.js"></script>',
        ),
      ),
    ),
  );
  network = startOwner(application);
  await network.runPromise(Effect.void);
  const configuredOrigin = process.env.ONTOS_SHELL_URL;
  if (configuredOrigin === undefined) {
    throw new Error("Expected the scoped owner server origin");
  }
  origin = configuredOrigin;
  browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await network?.dispose();
});

// Native lock release and an idle network precede two rendered frames: neither pending storage
// admission nor a late client/React continuation can satisfy an absence or exact-count assertion.
const settled = async () => {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(async () => {
    const locks = await navigator.locks.query();
    return locks.held?.length === 0 && locks.pending?.length === 0;
  });
  await page.evaluate(async () => {
    const first = Promise.withResolvers<number>();
    requestAnimationFrame((time) => {
      first.resolve(time);
    });
    await first.promise;
    const second = Promise.withResolvers<number>();
    requestAnimationFrame((time) => {
      second.resolve(time);
    });
    await second.promise;
  });
};
const input = (name: string) => page.locator(`input[name="${name}"]`);
const message = () => page.locator('textarea[name="message"]');
const status = () => page.locator("#contact-form-status");
const fillValid = async () => {
  await input("name").fill("Jan Novák");
  await input("email").fill("qa@example.com");
  await message().fill("Prosím o radu.");
};

beforeEach(async () => {
  requests.length = 0;
  serverErrors.length = 0;
  browserErrors.length = 0;
  outcome = "forbidden";
  context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(3000);
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
  });
  await page.goto(origin);
  await page.locator("fieldset:not([disabled])").waitFor();
  await settled();
});
afterEach(async () => {
  await context?.close();
  expect(serverErrors).toEqual([]);
  expect(browserErrors).toEqual([]);
});

describe("ContactView native controls and edit transitions", () => {
  it("rejects a whitespace-only name and accepts Jan Novák", async () => {
    await input("name").fill("   ");
    expect(await input("name").evaluate((node: HTMLInputElement) => node.checkValidity())).toBe(
      false,
    );
    await input("name").fill("Jan Novák");
    expect(await input("name").evaluate((node: HTMLInputElement) => node.checkValidity())).toBe(
      true,
    );
  });

  it("rejects qa@example and accepts qa@example.com", async () => {
    await input("email").fill("qa@example");
    expect(await input("email").evaluate((node: HTMLInputElement) => node.checkValidity())).toBe(
      false,
    );
    await input("email").fill("qa@example.com");
    expect(await input("email").evaluate((node: HTMLInputElement) => node.checkValidity())).toBe(
      true,
    );
  });

  it("cancels native invalid handling and focuses the first invalid input or textarea", async () => {
    const submitInvalid = async () => {
      const cancelled = await page.locator("form").evaluate((form: HTMLFormElement) => {
        const events: boolean[] = [];
        const observe = (event: Event) => {
          events.push(event.defaultPrevented);
        };
        form.addEventListener("invalid", observe, true);
        form.requestSubmit();
        form.removeEventListener("invalid", observe, true);
        return events;
      });
      await settled();
      expect(cancelled.length).toBeGreaterThan(0);
      expect(cancelled.every(Boolean)).toBe(true);
    };
    await submitInvalid();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("contact-name");
    await input("name").fill("Jan Novák");
    await input("email").fill("qa@example.com");
    await submitInvalid();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("contact-message");
    expect(requests).toHaveLength(0);
  });

  it("sets localized native validity for whitespace message and clears it after correction", async () => {
    await message().fill("   ");
    expect(
      await message().evaluate((node: HTMLTextAreaElement) => ({
        customError: node.validity.customError,
        message: node.validationMessage,
        valid: node.checkValidity(),
      })),
    ).toEqual({ customError: true, message: d.contact.messageInvalid, valid: false });
    await message().fill("Prosím o radu.");
    expect(
      await message().evaluate((node: HTMLTextAreaElement) => ({
        customError: node.validity.customError,
        message: node.validationMessage,
        valid: node.checkValidity(),
      })),
    ).toEqual({ customError: false, message: "", valid: true });
  });

  it("shows invalid email feedback and clears that field feedback on edit", async () => {
    await fillValid();
    await input("email").fill("qa@example");
    await page.getByRole("button", { exact: true, name: d.contact.send }).click();
    await page.locator('#contact-email[aria-invalid="true"]').waitFor();
    expect(await page.locator("form").textContent()).toContain(d.auth.errors.email);
    await input("email").fill("qa@example.com");
    await settled();
    expect(await input("email").getAttribute("aria-invalid")).not.toBe("true");
    expect(await page.locator("form").textContent()).not.toContain(d.auth.errors.email);
    expect(requests).toHaveLength(0);
  });

  it("clears a local invalid inquiry status when a contact field is edited", async () => {
    await fillValid();
    // DOM-set/autofilled overlength values do not acquire native tooLong; the real decoder
    // must still reject them before HTTP. No validity method or submission function is replaced.
    await input("phone").evaluate((node: HTMLInputElement) => {
      node.value = "1".repeat(41);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      await page.locator("form").evaluate((form: HTMLFormElement) => form.checkValidity()),
    ).toBe(true);
    await page.getByRole("button", { exact: true, name: d.contact.send }).click();
    await status().waitFor();
    expect(await status().textContent()).toBe(d.contact.invalid);
    await settled();
    expect(requests).toHaveLength(0);
    await input("email").fill("corrected@example.com");
    await settled();
    expect(await status().count()).toBe(0);
    expect(await page.locator("fieldset").getAttribute("aria-describedby")).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it.each(["forbidden", "unavailable"] as const)(
    "preserves the %s inquiry outcome after an email edit",
    async (protectedOutcome) => {
      outcome = protectedOutcome;
      await fillValid();
      const response = page.waitForResponse(
        (answer) => new URL(answer.url()).pathname === "/api/inquiries",
      );
      await page.getByRole("button", { exact: true, name: d.contact.send }).click();
      const answer = await response;
      await answer.finished();
      await status().waitFor();
      const feedback =
        protectedOutcome === "forbidden" ? d.contact.forbidden : d.contact.formUnavailable;
      expect(await status().textContent()).toBe(feedback);
      await settled();
      expect(requests).toEqual([
        expect.objectContaining({
          email: "qa@example.com",
          locale: "cs",
          message: "Prosím o radu.",
          name: "Jan Novák",
          phone: "",
        }),
      ]);
      expect(await page.evaluate((key) => localStorage.getItem(key), inquiryGuardKey)).toBeNull();
      expect(await input("email").isEnabled()).toBe(true);
      await input("email").fill("corrected@example.com");
      await settled();
      expect(await input("email").inputValue()).toBe("corrected@example.com");
      expect(await status().textContent()).toBe(feedback);
      expect(requests).toHaveLength(1);
    },
  );
});
