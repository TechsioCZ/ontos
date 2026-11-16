import type { Effect } from 'effect';

/** Loads one module a request path imports lazily: local module evaluation, no I/O beyond reading the bundle. */
export type BootWarmUpImport = Effect.Effect<void>;

declare global {
  /**
   * Installed and removed by the Node process host (`scripts/zerops/serve-units.mts`) before its units load. Each
   * independently bundled unit registers its lazy imports here; the host's boot warm-up runs them once, as the host's
   * process-shared pools and composition validation already hand Effects across bundles.
   */
  var ontosBootWarmUpImports: Set<BootWarmUpImport> | undefined;
}

/**
 * Lets the process host's boot warm-up load a module this request path imports lazily, so the first request finds it
 * evaluated. Without a process host (tests, Workers, a single-unit dev server) nothing is registered.
 */
export const registerBootWarmUpImport = (load: BootWarmUpImport): void => {
  globalThis.ontosBootWarmUpImports?.add(load);
};
