// workerd's module-scope bindings, as far as core-runtime reads them.
declare module 'cloudflare:workers' {
  /** What a KV namespace text read resolves: the stored text, or null for a missing key. */
  type WorkersKvTextRead = string | null;
  type WorkersKvStreamRead = ReadableStream<Uint8Array> | null;

  interface WorkersKvRead {
    (key: string, type: 'text'): Promise<WorkersKvTextRead>;
    (key: string, type: 'stream'): Promise<WorkersKvStreamRead>;
  }

  /** A binding as core-runtime sees it: service and VPC bindings fetch, KV namespaces get; others are decoded where read. */
  interface CoreRuntimeWorkerBinding {
    readonly fetch?: typeof globalThis.fetch;
    readonly get?: WorkersKvRead;
  }

  interface CoreRuntimeWorkerBindings {
    /** Workers KV namespace holding the published active Application Composition under key `active`. */
    readonly ONTOS_ACTIVE_APPLICATION_COMPOSITION?: {
      readonly get: WorkersKvRead;
    };
    /** Bindings by name: `HYPERDRIVE`, and the Worker service bindings to other OntOS units. */
    readonly [serviceBinding: string]: CoreRuntimeWorkerBinding | undefined;
    /** Workers VPC service binding to the SpiceDB HTTP gateway behind the tunnel. */
    readonly SPICEDB?: { readonly fetch: typeof globalThis.fetch };
  }

  export const env: CoreRuntimeWorkerBindings & {
    readonly ONTOS_MODULES?: { readonly get: (name: string) => { readonly fetch: typeof globalThis.fetch } };
    readonly ONTOS_MODULES_NAMESPACE?: string;
  };
}
