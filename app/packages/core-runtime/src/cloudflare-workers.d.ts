// workerd's module-scope bindings, as far as core-runtime reads them.
declare module 'cloudflare:workers' {
  /** A binding as core-runtime sees it: service and VPC bindings fetch; others are decoded where read. */
  interface CoreRuntimeWorkerBinding {
    readonly fetch?: typeof globalThis.fetch;
  }

  interface CoreRuntimeWorkerBindings {
    /** Bindings by name: `HYPERDRIVE`, and the Worker service bindings to other OntOS units. */
    readonly [serviceBinding: string]: CoreRuntimeWorkerBinding | undefined;
    /** Workers VPC service binding to the SpiceDB HTTP gateway behind the tunnel. */
    readonly SPICEDB?: { readonly fetch: typeof globalThis.fetch };
  }

  export const env: CoreRuntimeWorkerBindings;
}
