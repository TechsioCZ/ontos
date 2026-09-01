const assignmentPattern = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;

const existingValues = (lines: readonly string[]): Readonly<Record<string, string>> =>
  Object.fromEntries(
    lines.flatMap((line) => {
      const match = assignmentPattern.exec(line);
      const key = match?.groups?.['key'];
      const value = match?.groups?.['value'];
      return key === undefined || value === undefined ? [] : [[key, value] as const];
    }),
  );

export interface LocalEnvironmentOverrides {
  readonly grpcPort?: string;
  readonly httpPort?: string;
  readonly preSharedKey?: string;
}

export const localSpiceDbValues = (
  lines: readonly string[],
  overrides: LocalEnvironmentOverrides,
): Readonly<Record<string, string>> => {
  const existing = existingValues(lines);
  const grpcPort = overrides.grpcPort ?? existing['SPICEDB_GRPC_PORT'] ?? '50051';
  const httpPort = overrides.httpPort ?? existing['SPICEDB_HTTP_PORT'] ?? '8443';
  const preSharedKey =
    overrides.preSharedKey ?? existing['SPICEDB_PRESHARED_KEY'] ?? 'ontos-local-development-key';

  return {
    SPICEDB_ENDPOINT:
      overrides.grpcPort === undefined && existing['SPICEDB_ENDPOINT'] !== undefined
        ? existing['SPICEDB_ENDPOINT']
        : `localhost:${grpcPort}`,
    SPICEDB_GRPC_PORT: grpcPort,
    SPICEDB_HTTP_PORT: httpPort,
    SPICEDB_INSECURE: existing['SPICEDB_INSECURE'] ?? 'true',
    SPICEDB_PRESHARED_KEY: preSharedKey,
  };
};
