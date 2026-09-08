// expect-count: 1
/** Decorated class member: decorator metadata must not hide the positional signature. */
function traced(target: unknown, key: string, descriptor: PropertyDescriptor) {
  return descriptor;
}

export class ShellGatewayRegistry {
  @traced
  makeGatewayRuntime(database: unknown, gateway: unknown, resolver: unknown, clock: unknown) {
    return { clock, database, gateway, resolver };
  }

  @traced
  createGatewayKey(tenant: string, issuer: string) {
    return `${tenant}:${issuer}`;
  }
}
