// expect-count: 6
const registrationMarker = Symbol('@app/core-runtime/reads/registration');
const registrationHandler = Symbol('@app/core-runtime/reads/registration/handler');
const registrationFactory = Symbol.for('@app/core-runtime/reads/registration/factory');
const registrationPolicies = Symbol('@app/core-runtime/reads/registration/policies');

export interface ReadPolicy {
  readonly policyKey: string;
}

export interface ReadRegistration<Input, Result, Services> {
  readonly [registrationFactory]: () => Services;
  readonly [registrationHandler]: (input: Input) => Result;
  readonly [registrationMarker]: true;
  readonly [registrationPolicies]: readonly ReadPolicy[];
}

export const registerRead = <Input, Result, Services>(
  handler: (input: Input) => Result,
  serviceFactory: () => Services,
  policies: readonly ReadPolicy[],
): ReadRegistration<Input, Result, Services> =>
  Object.freeze({
    [registrationFactory]: serviceFactory,
    [registrationHandler]: handler,
    [registrationMarker]: true as const,
    [registrationPolicies]: Object.freeze([...policies]),
  });
