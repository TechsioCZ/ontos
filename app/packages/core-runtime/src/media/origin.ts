import type { MediaIngestionSource } from './public-contract.ts';

/*
 * BR-06 of #1430: the recorded `ingestionSource` corresponds to the true origin. The payload states the origin, but the
 * principal that uploads is a Core identity fact (`core.principals.kind`), and the two upload carriers split exactly on
 * it: a person or an agent rides the access declaration, a workload principal (`system`, `integration`, `service`)
 * rides the `core.media.ingest` workload. Only the contradiction is refused; the origin is otherwise provenance and
 * grants nothing, and `system`, `integration` and `import` are not told apart from each other, because no Core fact
 * distinguishes them. A kind this module does not know is refused, never guessed.
 */
/** The origins each known principal kind may state: a person or agent only `user`, a workload anything but `user`. */
const ORIGINS_BY_PRINCIPAL_KIND = {
  agent: ['user'],
  human: ['user'],
  integration: ['import', 'integration', 'system'],
  service: ['import', 'integration', 'system'],
  system: ['import', 'integration', 'system'],
} as const satisfies Record<string, readonly MediaIngestionSource[]>;

const originsOf = (kind: string): readonly MediaIngestionSource[] =>
  Object.entries(ORIGINS_BY_PRINCIPAL_KIND).find(([known]) => known === kind)?.[1] ?? [];

export const isOriginConsistentWithPrincipalKind = (kind: string, source: MediaIngestionSource): boolean =>
  originsOf(kind).includes(source);
