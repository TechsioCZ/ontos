// @rstest-environment happy-dom
import { browserNetwork, networkIdle } from "@app/shared-contracts/testing/http-double";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ToastProvider } from "@techsio/ui-kit/molecules/toast";
import { Effect, ManagedRuntime } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { PasswordRecoveryView } from "../src/features/password-recovery-view";
import { getDictionary } from "../src/i18n";
import {
  PasswordRecoveryForbiddenProblem,
  PasswordRecoveryInvalidProblem,
} from "../src/ontos/password-recovery";

const d = getDictionary("cs");
const credential = "corrected-password-123";
const requests: unknown[] = [];
let responseState: "completed" | "invalid" | "forbidden";
const details = {
  detail: "Password recovery could not be completed.",
  title: "Password recovery",
  type: "urn:n1:password-recovery",
};
// Record the raw POST before any schema gate: even a malformed client dispatch must fail suppression checks.
const endpoint = HttpRouter.add(
  "POST",
  "/api/account/password/reset",
  Effect.gen(function* answerReset() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    requests.push(yield* request.json);
    if (responseState === "invalid") {
      return yield* HttpServerResponse.schemaJson(PasswordRecoveryInvalidProblem)(
        PasswordRecoveryInvalidProblem.make({ ...details, state: "invalid", status: 400 }),
        { contentType: "application/problem+json", status: 400 },
      );
    }
    if (responseState === "forbidden") {
      return yield* HttpServerResponse.schemaJson(PasswordRecoveryForbiddenProblem)(
        PasswordRecoveryForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
        { contentType: "application/problem+json", status: 403 },
      );
    }
    return HttpServerResponse.jsonUnsafe({ state: "completed" });
  }).pipe(Effect.orDie),
);
const startNetwork = () => ManagedRuntime.make(browserNetwork(endpoint));
let network: ReturnType<typeof startNetwork>;
let root: Root;
let container: HTMLDivElement;

const input = (name: "newPassword" | "passwordConfirmation") => {
  const control = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (control === null) {
    throw new Error(`Missing password control: ${name}`);
  }
  return control;
};
const form = () => {
  const control = container.querySelector("form");
  if (control === null) {
    throw new Error("Missing password reset form");
  }
  return control;
};
const output = () => container.querySelector("output")?.textContent;
const settled = async () => {
  await act(async () => {
    await network.runPromise(networkIdle);
  });
};
const edit = async (name: "newPassword" | "passwordConfirmation", value: string) => {
  const control = input(name);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.bind(
    control,
  );
  if (setter === undefined) {
    throw new Error("Native input value setter is unavailable");
  }
  await act(async () => {
    setter(value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settled();
};
const submit = async (bypassNative = false) => {
  await act(async () => {
    if (bypassNative) {
      // Exercise the client schema even when a submit reaches React without native constraint validation.
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    } else {
      form().requestSubmit();
    }
  });
  await settled();
};
const fill = async (newPassword: string, confirmation: string) => {
  await edit("newPassword", newPassword);
  await edit("passwordConfirmation", confirmation);
};
const expectOneReset = () =>
  expect(requests).toEqual([{ newPassword: credential, passwordConfirmation: credential }]);
const expectNoMismatch = () =>
  expect(container.textContent).not.toContain(d.auth.errors.passwordConfirmation);

beforeEach(async () => {
  requests.length = 0;
  responseState = "completed";
  network = startNetwork();
  await network.runPromise(Effect.void);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <PasswordRecoveryView dictionary={d} locale="cs" mode="reset" tokenPresent />
      </ToastProvider>,
    );
  });
  await settled();
});
afterEach(async () => {
  await settled();
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await network.dispose();
});

describe("password correction at the real browser HTTP boundary", () => {
  it("focuses a long-password mismatch without POST, then clears confirmation feedback and sends the correction", async () => {
    await fill(credential, "different-password-456");
    await submit();
    expect(input("passwordConfirmation").getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain(d.auth.errors.passwordConfirmation);
    expect(document.activeElement).toBe(input("passwordConfirmation"));
    expect(form().getAttribute("aria-busy")).toBe("false");
    expect(requests).toEqual([]);

    await edit("passwordConfirmation", credential);
    expectNoMismatch();
    expect(input("passwordConfirmation").getAttribute("aria-invalid")).not.toBe("true");
    expect(requests).toEqual([]);
    await submit();
    expectOneReset();
    expect(output()).toBe(d.passwordRecovery.completedNextStep);
  });

  it("rejects equal short passwords locally, then a password edit clears the local result and mismatch feedback before a real reset", async () => {
    await fill("short", "short");
    await submit(true);
    expect(output()).toBe(d.passwordRecovery.states.invalid);
    expect(form().getAttribute("aria-busy")).toBe("false");
    expect(input("newPassword").getAttribute("aria-invalid")).toBe("true");
    expect(requests).toEqual([]);

    // Add local confirmation feedback without editing away the preceding schema failure.
    input("passwordConfirmation").value = "other";
    await submit(true);
    expect(container.textContent).toContain(d.auth.errors.passwordConfirmation);
    expect(output()).toBe(d.passwordRecovery.states.invalid);
    expect(requests).toEqual([]);

    await edit("newPassword", credential);
    expect(output()).toBe("");
    expectNoMismatch();
    expect(input("newPassword").getAttribute("aria-invalid")).not.toBe("true");
    expect(input("passwordConfirmation").getAttribute("aria-invalid")).not.toBe("true");
    expect(requests).toEqual([]);
    await edit("passwordConfirmation", credential);
    await submit();
    expectOneReset();
    expect(output()).toBe(d.passwordRecovery.completedNextStep);
  });

  it.each(["invalid", "forbidden"] as const)(
    "clears local confirmation feedback on a password edit but preserves the server %s result",
    async (state) => {
      responseState = state;
      await fill(credential, credential);
      await submit();
      expectOneReset();
      expect(output()).toBe(d.passwordRecovery.states[state]);
      expect(form().getAttribute("aria-busy")).toBe("false");

      await edit("passwordConfirmation", "different-password-456");
      await submit();
      expect(container.textContent).toContain(d.auth.errors.passwordConfirmation);
      expect(document.activeElement).toBe(input("passwordConfirmation"));
      expectOneReset();

      await edit("newPassword", "edited-password-789");
      expectNoMismatch();
      expect(output()).toBe(d.passwordRecovery.states[state]);
      expect(input("passwordConfirmation").getAttribute("aria-invalid")).toBe(
        state === "invalid" ? "true" : null,
      );
      expectOneReset();
    },
  );
});
