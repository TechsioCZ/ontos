import { describe, expect, it } from "@rstest/core";
import { makeAuthBlurValidation } from "../src/features/auth-blur-validation";

describe("auth blur validation during pointer activation", () => {
  const mismatch = { field: "passwordConfirmation", valid: false, valueMissing: false };

  it("validates keyboard and ordinary blur immediately", () => {
    const validation = makeAuthBlurValidation<string>();
    expect(validation.validateOnBlur(mismatch)).toEqual(mismatch);
    expect(validation.finish()).toBeNull();
  });

  it("preserves the pointer target until click before publishing a mismatch", () => {
    const validation = makeAuthBlurValidation<string>();
    validation.start();
    expect(validation.validateOnBlur(mismatch)).toBeNull();
    expect(validation.finish()).toEqual(mismatch);
    expect(validation.finish()).toBeNull();
  });

  it.each(["touch", "pen"])(
    "keeps the %s activation open when pointerleave precedes compatibility-mouse blur",
    (pointerType) => {
      const validation = makeAuthBlurValidation<string>();
      validation.start();
      expect(validation.finishOnPointerLeave(pointerType)).toBeNull();
      expect(validation.validateOnBlur(mismatch)).toBeNull();
      expect(validation.finish()).toEqual(mismatch);
    },
  );

  it.each(["touch", "pen"])(
    "retains deferred validation through %s pointerleave until click",
    (pointerType) => {
      const validation = makeAuthBlurValidation<string>();
      validation.start();
      validation.validateOnBlur(mismatch);
      expect(validation.finishOnPointerLeave(pointerType)).toBeNull();
      expect(validation.finish()).toEqual(mismatch);
    },
  );

  it("finishes a mouse activation when the pointer leaves the form", () => {
    const validation = makeAuthBlurValidation<string>();
    validation.start();
    validation.validateOnBlur(mismatch);
    expect(validation.finishOnPointerLeave("mouse")).toEqual(mismatch);
    expect(validation.validateOnBlur({ ...mismatch, valid: true })).toEqual({
      ...mismatch,
      valid: true,
    });
  });

  it("publishes deferred validation on cancellation and restores immediate blur", () => {
    const validation = makeAuthBlurValidation<string>();
    validation.start();
    validation.validateOnBlur(mismatch);
    expect(validation.finish()).toEqual(mismatch);
    expect(validation.validateOnBlur({ ...mismatch, valid: true })).toEqual({
      ...mismatch,
      valid: true,
    });
  });

  it("does not discard an unfinished validation when another pointer gesture starts", () => {
    const validation = makeAuthBlurValidation<string>();
    validation.start();
    validation.validateOnBlur(mismatch);
    expect(validation.start()).toEqual(mismatch);
    expect(validation.validateOnBlur({ ...mismatch, valueMissing: true })).toBeNull();
    expect(validation.finish()).toEqual({ ...mismatch, valueMissing: true });
  });
});
