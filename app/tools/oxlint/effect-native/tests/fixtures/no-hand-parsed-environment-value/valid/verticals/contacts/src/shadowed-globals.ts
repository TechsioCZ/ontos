// Shadowed hosts and shadowed parsers: a local `process`, `Number`, `URL` or `JSON` is not the
// ambient environment or the global parser, so nothing here reports.
import * as Schema from 'effect/Schema';

declare const environment: Record<string, string | undefined>;

const process = { env: { DATABASE_URL: 'postgres://localhost:5432/app' } } as const;
export const mockedUrl = process.env.DATABASE_URL.trim();

export const shadowedParsers = () => {
  const Number = (value: string | undefined) => value ?? '';
  class URL {
    constructor(readonly value: string) {}
  }
  const JSON = { parse: (value: string) => ({ value }) };
  return {
    count: Number(environment['COUNT']),
    options: JSON.parse(environment['OPTIONS'] ?? '{}'),
    url: new URL(environment['SERVICE_URL'] ?? ''),
  };
};

// Decoding an environment value *through Schema/Config* is the target state, not the defect.
const Endpoint = Schema.Struct({ endpoint: Schema.String });
export const decoded = Schema.decodeUnknownSync(Endpoint)({ endpoint: environment['SPICEDB_ENDPOINT'] });
