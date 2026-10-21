// Shell reads strings from workerd's module-scope environment; bindings are decoded by their owners.
declare module 'cloudflare:workers' {
  export const env: Readonly<Record<string, unknown>>;
}
