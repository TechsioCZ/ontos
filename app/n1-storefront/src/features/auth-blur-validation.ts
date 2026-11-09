export interface AuthBlurResult<Field extends string> {
  field: Field;
  valid: boolean;
  valueMissing: boolean;
}

/** Keep blur-driven layout changes after the browser resolves a pointer click target. */
export const makeAuthBlurValidation = <Field extends string>() => {
  let pointerActive = false;
  let deferred: AuthBlurResult<Field> | null = null;
  const finish = () => {
    const result = deferred;
    deferred = null;
    pointerActive = false;
    return result;
  };
  return {
    finish,
    start() {
      const result = finish();
      pointerActive = true;
      return result;
    },
    validateOnBlur(result: AuthBlurResult<Field>) {
      if (pointerActive) {
        deferred = result;
        return null;
      }
      return result;
    },
  };
};
