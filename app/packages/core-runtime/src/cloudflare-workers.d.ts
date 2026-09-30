// workerd's module-scope bindings, as far as core-runtime reads them.
declare module 'cloudflare:workers' {
  /** A binding as core-runtime sees it: service and VPC bindings fetch, KV namespaces get; others are decoded where read. */
  interface CoreRuntimeWorkerBinding {
    readonly fetch?: typeof globalThis.fetch;
    // oxlint-disable-next-line effect-native/no-nullable-service-outcome -- workerd's KV `get` resolves null for a missing key.
    readonly get?: (key: string, type: 'text') => Promise<string | null>;
  }

  interface CoreRuntimeWorkerBindings {
    /** Workers KV namespace holding the published active Application Composition under key `active`. */
    readonly ONTOS_ACTIVE_APPLICATION_COMPOSITION?: {
      // oxlint-disable-next-line effect-native/no-nullable-service-outcome -- workerd's KV `get` resolves null for a missing key.
      readonly get: (key: string, type: 'text') => Promise<string | null>;
    };
    /** Bindings by name: `HYPERDRIVE`, and the Worker service bindings to other OntOS units. */
    readonly [serviceBinding: string]: CoreRuntimeWorkerBinding | undefined;
    /** Workers VPC service binding to the SpiceDB HTTP gateway behind the tunnel. */
    readonly SPICEDB?: { readonly fetch: typeof globalThis.fetch };
  }

  export const env: CoreRuntimeWorkerBindings;
}
