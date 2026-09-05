// expect-count: 3
// A3 in a TSX route: `import.meta.env` plus an `Environment` alias parameter, both throwing.
type Environment = Readonly<Record<string, string | undefined>>;

export function readApiBase(): string {
  const base = import.meta.env?.VITE_API_BASE;
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error('VITE_API_BASE is required');
  }
  return base;
}

export const parseFeatureFlags = (environment: Environment): ReadonlySet<string> => {
  const raw = environment['ONTOS_FEATURE_FLAGS'];
  if (raw === undefined) {
    throw new Error('ONTOS_FEATURE_FLAGS is required');
  }
  const flags = raw.split(',').filter((flag) => flag.length > 0);
  if (flags.length === 0) {
    throw new Error('ONTOS_FEATURE_FLAGS must list at least one flag');
  }
  return new Set(flags);
};

export const ConfigPanel = () => <section>{readApiBase()}</section>;
