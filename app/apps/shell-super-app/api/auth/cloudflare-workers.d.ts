// Shell reads strings from workerd's module-scope environment; bindings are decoded by their owners.
declare module 'cloudflare:workers' {
  export const env: Readonly<Record<string, unknown>> & {
    /** The Shell's service binding to itself (server rendering reaches its own BFF on this machine). */
    readonly ONTOS_SHELL_SELF?: { readonly fetch: typeof globalThis.fetch };
  };
}
