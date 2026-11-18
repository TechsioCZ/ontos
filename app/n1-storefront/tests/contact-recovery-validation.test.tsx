import { afterEach, beforeEach, describe, expect, it, rs } from "effect-rstest";
import { Deferred, Effect, Fiber, Predicate } from "effect";
import type { ComponentProps, ElementType, Key, SetStateAction } from "react";
import actualReact from "react" with { rstest: "importActual" };
import { Fragment, jsx } from "react/jsx-runtime" with { rstest: "importActual" };
import { jsxDEV } from "react/jsx-dev-runtime" with { rstest: "importActual" };
import type { JSXSource } from "react/jsx-dev-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactView } from "../src/features/contact-view";
import { PasswordRecoveryView } from "../src/features/password-recovery-view";
import type { ContactFeedbackState } from "../src/features/action-feedback";
import type { FormInput } from "../src/features/form-controls";
import { getDictionary } from "../src/i18n";
import type { PasswordRecoveryOutcome } from "../src/ontos/password-recovery";

type InvalidContactFields = Partial<Record<"email" | "message" | "name", boolean>>;
type ObservedState =
  | ContactFeedbackState
  | "blocked"
  | "clear"
  | "loading"
  | InvalidContactFields
  | PasswordRecoveryOutcome
  | boolean
  | null;
interface ObservedUpdate {
  initial: ObservedState;
  update: SetStateAction<ObservedState>;
}
interface ControlChangeEvent {
  currentTarget: Pick<HTMLTextAreaElement, "setCustomValidity" | "value">;
}
type CapturedControl = Pick<ComponentProps<typeof FormInput>, "name" | "pattern"> & {
  onChange?: (event: ControlChangeEvent) => void;
  onInvalid?: () => void;
};
interface CapturedFormEvent {
  currentTarget: { querySelector: (selector: string) => { focus: () => void } | null };
  preventDefault: () => void;
}
interface CapturedForm {
  onInvalidCapture?: (event: CapturedFormEvent) => void;
  onSubmit?: (event: CapturedFormEvent) => void;
}

interface RecoveryRuntime {
  fiber: Fiber.Fiber<PasswordRecoveryOutcome> | null;
  program: Effect.Effect<PasswordRecoveryOutcome> | null;
}

const controls = rs.hoisted(() => {
  const response: PasswordRecoveryOutcome = { state: "invalid" };
  const updates: ObservedUpdate[] = [];
  const form: CapturedForm = {};
  const runtime: RecoveryRuntime = { fiber: null, program: null };
  return {
    complete: rs.fn(),
    ...runtime,
    fields: new Map<string, CapturedControl>(),
    form,
    response,
    runFork: rs.fn(),
    updates,
    values: new Map<string, string>(),
  };
});

// Keep the real React dispatcher and state values. The test observes only updates
// from captured handlers; these minimal native-event fixtures are not DOM tests.
rs.mock("react", () => ({
  ...actualReact,
  useState: (initial: ObservedState | (() => ObservedState)) => {
    const [value, setValue] = actualReact.useState(initial);
    return [
      value,
      (update: SetStateAction<ObservedState>) => {
        controls.updates.push({ initial: value, update });
        setValue(update);
      },
    ] as const;
  },
}));
const captureJsx = (type: ElementType, props: CapturedForm, key?: Key) => {
  if (type === "form") {
    controls.form = props;
  }
  return jsx(type, props, key);
};
rs.mock("react/jsx-runtime", () => ({
  Fragment,
  jsx: (...args: Parameters<typeof captureJsx>) => captureJsx(...args),
  jsxs: (...args: Parameters<typeof captureJsx>) => captureJsx(...args),
}));
rs.mock("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV: (
    type: ElementType,
    props: CapturedForm,
    key: Key | undefined,
    isStatic: boolean,
    source?: JSXSource,
  ) => {
    if (type === "form") {
      controls.form = props;
    }
    return jsxDEV(type, props, key, isStatic, source);
  },
}));
rs.mock("next/navigation", () => ({ useParams: () => ({ locale: "cs" }) }));
const captureControl = (props: CapturedControl) => {
  controls.fields.set(String(props.name), props);
  return null;
};
rs.mock("../src/features/form-controls", () => ({
  FormInput: (props: CapturedControl) => captureControl(props),
  FormTextarea: (props: CapturedControl) => captureControl(props),
}));
rs.mock("../src/ontos/portal-client", () => ({
  portalRuntime: {
    runFork: (program: Effect.Effect<PasswordRecoveryOutcome>) => {
      controls.runFork();
      controls.program = program;
      if (controls.fiber === null) {
        throw new Error("The reset test needs a scoped harness fiber");
      }
      return controls.fiber;
    },
  },
}));
rs.mock("../src/ontos/password-recovery-client", () => ({
  completePasswordRecovery: () => {
    controls.complete();
    return Effect.succeed(controls.response);
  },
  requestPasswordRecovery: () => Effect.succeed(controls.response),
}));

const invoke = <E,>(handler: ((event: E) => void) | undefined, event: E) => {
  if (handler === undefined) {
    throw new Error("Expected the rendered form event handler");
  }
  handler(event);
};
const input = (name: string) => {
  const field = controls.fields.get(name);
  if (field === undefined) {
    throw new Error(`Missing rendered field: ${name}`);
  }
  return field;
};
const renderReset = () =>
  renderToStaticMarkup(
    actualReact.createElement(PasswordRecoveryView, {
      dictionary: getDictionary("cs"),
      locale: "cs",
      mode: "reset",
      tokenPresent: true,
    }),
  );
const submitEvent = () => ({
  currentTarget: { querySelector: rs.fn(() => ({ focus: rs.fn() })) },
  preventDefault: rs.fn(),
});
const changeEvent = (value = "") => ({
  currentTarget: { setCustomValidity: rs.fn(), value },
});
const applyUpdate = (update: SetStateAction<ObservedState>, previous: ObservedState) =>
  Predicate.isFunction(update) ? update(previous) : update;
// UI's runtime edge returns a real scoped fiber. Its submitted schema/client
// program is evaluated by it.effect, then delivered to the actual UI observer.
const prepareRuntime = Effect.gen(function* prepareRecoveryRuntime() {
  const response = yield* Deferred.make<PasswordRecoveryOutcome>();
  const fiber = yield* Effect.forkChild(Deferred.await(response));
  controls.fiber = fiber;
  return Effect.gen(function* completeRecoveryRuntime() {
    const { program } = controls;
    if (program === null) {
      throw new Error("The rendered form did not submit its program");
    }
    const outcome = yield* program;
    yield* Deferred.succeed(response, outcome);
    yield* Fiber.join(fiber);
  });
});

beforeEach(() => {
  controls.fields.clear();
  controls.form = {};
  controls.program = null;
  controls.fiber = null;
  controls.values.clear();
  controls.updates.length = 0;
  controls.response = { state: "invalid" };
  rs.clearAllMocks();
  const NativeFormData = FormData;
  rs.stubGlobal(
    "FormData",
    class extends NativeFormData {
      constructor() {
        super();
        for (const [name, value] of controls.values) {
          this.set(name, value);
        }
      }
    },
  );
});
afterEach(() => {
  rs.unstubAllGlobals();
});

describe("contact native validation feedback", () => {
  beforeEach(() => {
    renderToStaticMarkup(
      actualReact.createElement(ContactView, {
        dictionary: getDictionary("cs"),
      }),
    );
  });

  it("rejects whitespace names and dotted-domain omissions before inquiry submission", () => {
    const namePattern = input("name").pattern;
    const emailPattern = input("email").pattern;
    if (namePattern === undefined || emailPattern === undefined) {
      throw new Error("Missing contact native constraints");
    }
    expect(new RegExp(`^(?:${namePattern})$`, "u").test("   ")).toBe(false);
    expect(new RegExp(`^(?:${namePattern})$`, "u").test("Jan Novák")).toBe(true);
    expect(new RegExp(`^(?:${emailPattern})$`, "u").test("qa@example")).toBe(false);
    expect(new RegExp(`^(?:${emailPattern})$`, "u").test("qa@example.com")).toBe(true);
  });

  it("focuses the first invalid native control instead of leaving a generic status", () => {
    const event = submitEvent();
    const focus = rs.fn();
    event.currentTarget.querySelector.mockReturnValue({ focus });
    invoke(controls.form.onInvalidCapture, event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.currentTarget.querySelector).toHaveBeenCalledWith(
      "input:invalid, textarea:invalid",
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects a whitespace-only message and clears its native error after correction", () => {
    const event = changeEvent(" \n ");
    invoke(input("message").onChange, event);
    expect(event.currentTarget.setCustomValidity).toHaveBeenLastCalledWith(
      getDictionary("cs").contact.messageInvalid,
    );
    event.currentTarget.value = "Prosím o radu.";
    invoke(input("message").onChange, event);
    expect(event.currentTarget.setCustomValidity).toHaveBeenLastCalledWith("");
  });

  it("clears corrected field feedback without clearing a protected inquiry outcome", () => {
    const invalid = input("email").onInvalid;
    if (invalid === undefined) {
      throw new Error("Expected email invalid handler");
    }
    invalid();
    invoke(input("email").onChange, changeEvent());
    const fieldUpdates = controls.updates.filter(({ initial }) => Predicate.isObject(initial));
    const [first, second] = fieldUpdates;
    if (first === undefined || second === undefined) {
      throw new Error("Expected invalid and corrected field updates");
    }
    expect(applyUpdate(first.update, {})).toEqual({ email: true });
    expect(applyUpdate(second.update, { email: true })).toEqual({ email: false });
    const localUpdate = controls.updates.find(({ initial }) => initial === "idle");
    if (localUpdate === undefined) {
      throw new Error("Expected local invalid-state editing policy");
    }
    expect(applyUpdate(localUpdate.update, "invalid")).toBe("idle");
    for (const state of ["pending", "sent", "unconfirmed", "forbidden", "unavailable"] as const) {
      expect(applyUpdate(localUpdate.update, state)).toBe(state);
    }
  });
});

describe("password confirmation before owner dispatch", () => {
  it("focuses a mismatch and never dispatches a password reset", () => {
    renderReset();
    controls.values.set("newPassword", "A-long-first-password");
    controls.values.set("passwordConfirmation", "A-long-other-password");
    const event = submitEvent();
    const focus = rs.fn();
    event.currentTarget.querySelector.mockReturnValue({ focus });
    invoke(controls.form.onSubmit, event);
    expect(event.currentTarget.querySelector).toHaveBeenCalledWith(
      'input[name="passwordConfirmation"]',
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(controls.runFork).not.toHaveBeenCalled();
    expect(controls.complete).not.toHaveBeenCalled();
    expect(controls.updates.map(({ update }) => update)).toContain(true);
    controls.updates.length = 0;
    invoke(input("passwordConfirmation").onChange, changeEvent());
    expect(controls.updates.map(({ update }) => update)).toEqual([false]);
  });

  it.effect("clears only a local contract failure after editing, with no password POST", () =>
    Effect.gen(function* localRecoveryValidation() {
      const finish = yield* prepareRuntime;
      renderReset();
      controls.values.set("newPassword", "short");
      controls.values.set("passwordConfirmation", "short");
      invoke(controls.form.onSubmit, submitEvent());
      yield* finish;
      expect(controls.complete).not.toHaveBeenCalled();
      expect(controls.updates.map(({ update }) => update)).toContainEqual({ state: "invalid" });
      controls.updates.length = 0;
      invoke(input("newPassword").onChange, changeEvent());
      expect(controls.updates.map(({ update }) => update)).toEqual([false, null]);
    }),
  );

  it.effect.each(["invalid", "invalid-token", "forbidden", "unconfirmed"] as const)(
    "preserves the server %s outcome when a password field is edited",
    (state) =>
      Effect.gen(function* preserveRecoveryServerOutcome() {
        const finish = yield* prepareRuntime;
        controls.response = { state };
        renderReset();
        controls.values.set("newPassword", "A-long-valid-password");
        controls.values.set("passwordConfirmation", "A-long-valid-password");
        invoke(controls.form.onSubmit, submitEvent());
        yield* finish;
        expect(controls.complete).toHaveBeenCalledOnce();
        controls.updates.length = 0;
        invoke(input("newPassword").onChange, changeEvent());
        expect(controls.updates.map(({ update }) => update)).toEqual([false]);
      }),
  );
});
