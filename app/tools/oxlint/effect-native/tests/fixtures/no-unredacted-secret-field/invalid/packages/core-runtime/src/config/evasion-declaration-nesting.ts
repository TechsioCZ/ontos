// expect-count: 2
// Credential fields buried in a TS namespace and a module augmentation.
export namespace Auth {
  export interface RuntimeConfig {
    readonly issuer: string;
    readonly secret: string;
  }
}

declare module 'auth-augment' {
  interface GatewayExtras {
    readonly apiKey: string;
  }
}
