const runtimeRegistrationBrand: unique symbol = Symbol(
  '@app/core-runtime/modules/runtime-registration',
);

const privateRuntime = new WeakMap<object, { readonly moduleId: string }>();

export interface VerticalRuntimeRegistration<ModuleId extends string = string> {
  readonly moduleId: ModuleId;
  readonly [runtimeRegistrationBrand]: true;
}

export const runtimeOf = (registration: VerticalRuntimeRegistration): string | undefined =>
  privateRuntime.get(registration)?.moduleId;
