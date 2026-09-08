// expect-count: 3
/** B4 evidence: the generator-facing definition API fixes a six-parameter positional shape. */
export const defineRead = <InputSchema, ResultSchema>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema>,
  handler: ReadHandler<InputSchema, ResultSchema>,
  serviceFactory: ReadServiceFactory,
  permissionTargetResolver: ReadPermissionTargetResolver,
  resultPermissionTargetResolver?: ReadResultPermissionTargetResolver,
  executablePolicies: readonly string[] = [],
) => ({
  descriptor,
  executablePolicies,
  handler,
  permissionTargetResolver,
  resultPermissionTargetResolver,
  serviceFactory,
});

/** The port declaration is where the positional shape is actually fixed. */
export interface ReadRegistry {
  readonly defineRead: (
    descriptor: unknown,
    handler: unknown,
    serviceFactory: unknown,
    permissionTargetResolver: unknown,
  ) => unknown;
  createReadPort(descriptor: unknown, handler: unknown, policies: readonly unknown[]): unknown;
  /** Allowed: within the limit. */
  defineReadPolicy(owner: string, policy: unknown): unknown;
}

/** Allowed: a `this` parameter is a type annotation, not a collaborator. */
export function makeBoundReader(this: ReadRegistry, descriptor: unknown, handler: unknown) {
  return this.createReadPort(descriptor, handler, []);
}
