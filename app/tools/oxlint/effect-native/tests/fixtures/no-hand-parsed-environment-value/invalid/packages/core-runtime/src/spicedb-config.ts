// expect-count: 6
// Audit A3 evidence shape: packages/core-runtime/src/permissions/config.ts:105 — an injected
// environment record that `no-ambient-process-env` cannot see, parsed entirely by hand.
type Environment = Readonly<Record<string, string | undefined>>;

export const parseSpiceDbConfig = (environment: Environment) => {
  const endpoint = environment['SPICEDB_ENDPOINT']?.trim();
  const insecureFlag = environment['SPICEDB_INSECURE']?.trim().toLowerCase();

  if (endpoint === undefined || endpoint.length === 0) {
    throw new Error('SPICEDB_ENDPOINT is required');
  }
  if (insecureFlag !== 'true' && insecureFlag !== 'false') {
    throw new Error('SPICEDB_INSECURE must be explicitly true or false');
  }

  return { endpoint, insecureLocal: insecureFlag === 'true' };
};
