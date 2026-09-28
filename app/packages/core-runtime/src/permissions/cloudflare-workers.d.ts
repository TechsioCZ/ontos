// workerd's module-scope bindings, as far as core-runtime reads them.
declare module 'cloudflare:workers' {
  interface CoreRuntimeWorkerBindings {
    /** Workers VPC service binding to the SpiceDB HTTP gateway behind the tunnel. */
    readonly SPICEDB?: { readonly fetch: typeof globalThis.fetch };
  }

  export const env: CoreRuntimeWorkerBindings;
}
