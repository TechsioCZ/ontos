// expect-count: 5
// Audit A3/B3 evidence shape: scripts/postgres/bootstrap-runtime-role.mts:29 — computed environment
// keys plus a hand-written codec chain.
export const runtimeRole = (environment: Record<string, string | undefined>, name: string) => {
  const raw = environment[name];
  const value = raw?.trim();
  const parts = value?.split(':') ?? [];

  if (parts.length !== 2) {
    throw new Error(`${name} must be role:password`);
  }

  const timeout = Number.parseInt(environment['ROLE_TIMEOUT_MS'] ?? '5000', 10);
  const options = JSON.parse(environment['ROLE_OPTIONS'] ?? '{}');
  return { options, parts, timeout };
};
