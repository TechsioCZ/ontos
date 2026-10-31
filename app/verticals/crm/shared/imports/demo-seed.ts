// AREA: imports — owned by the crm-imports lane. Demo seed of the imports slice for Velkoobchod Hanák:
// approved external customer links, then one completed import of the `initial` sample file, run through the real
// ImportOrdersCsv reducer (so the seeded batch looks exactly like a live import).
import { DateTime, Effect, Schema } from 'effect';
import { applyImportsCommand } from '../commands/imports.ts';
import { CrmViewerSchema } from '../domain/access.ts';
import { CustomerLinkSchema } from '../domain/imports.ts';
import type { CrmState } from '../domain/state.ts';
import { initialOrdersSample } from './samples.ts';

const accountingSource = 'Účetní systém';

/** Approved correlations source customer id -> client key (crm.client demo ids). */
export const demoCustomerLinks: readonly { clientKey: string; externalCustomerId: string; source: string }[] = [
  { clientKey: 'pekarna-mala', externalCustomerId: 'ESH-1001', source: 'E-shop' },
  { clientKey: 'zlata-husa', externalCustomerId: 'ESH-1002', source: 'E-shop' },
  { clientKey: 'hotel-podhradi', externalCustomerId: 'ESH-1003', source: 'E-shop' },
  { clientKey: 'bistro-kral', externalCustomerId: 'ESH-1004', source: 'E-shop' },
  { clientKey: 'lazensky-hotel', externalCustomerId: 'ESH-1005', source: 'E-shop' },
  { clientKey: 'zamecka-restaurace', externalCustomerId: 'ESH-1006', source: 'E-shop' },
  { clientKey: 'potraviny-cerna', externalCustomerId: 'ESH-1007', source: 'E-shop' },
  { clientKey: 'kavarna-na-rohu', externalCustomerId: 'ESH-1008', source: 'E-shop' },
  { clientKey: 'catering-vsetin', externalCustomerId: 'UCT-501', source: accountingSource },
  { clientKey: 'minimarket-hodonin', externalCustomerId: 'UCT-502', source: accountingSource },
  { clientKey: 'zs-blansko', externalCustomerId: 'UCT-503', source: accountingSource },
];

export interface ImportsSeedInput {
  /** Principal shown as the author of the links and the seeded import. */
  readonly by: string;
  /** Client id of a demo client key. */
  readonly clientIdOf: (key: string) => string;
  /** ISO time of the seeded import. */
  readonly importedAt: DateTime.Utc;
  /** Deterministic invocation id of the seeded import (ids become `<invocationId>-<suffix>`). */
  readonly invocationId: string;
  /** ISO time of the links (before the import). */
  readonly linkedAt: DateTime.Utc;
}

/** Returns the state with the imports slice seeded (links + one completed import batch). */
export const seedImports = Effect.fn('Crm.seedImports')(function* seedImports(
  state: CrmState,
  input: ImportsSeedInput,
) {
  // Complete eligibility calls before generating any accepted link's ID: the caller port can fail.
  const eligibleLinks: (typeof demoCustomerLinks)[number][] = [];
  for (const link of demoCustomerLinks) {
    if (state.clients.items.some((client) => client.id === input.clientIdOf(link.clientKey))) {
      eligibleLinks.push(link);
    }
  }
  const rawLinks = eligibleLinks.map((link) => ({
    clientId: input.clientIdOf(link.clientKey),
    createdAt: DateTime.formatIso(input.linkedAt),
    createdBy: input.by,
    externalCustomerId: link.externalCustomerId,
    source: link.source,
  }));
  const customerLinks = yield* Schema.decodeEffect(Schema.Array(CustomerLinkSchema))(rawLinks);
  const viewer = yield* Schema.decodeEffect(CrmViewerSchema)({
    assign: true,
    principalId: input.by,
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  });
  const sample = initialOrdersSample();
  return yield* applyImportsCommand(
    { ...state, imports: { batches: [], customerLinks, orders: [], pairingHistory: [] } },
    { _tag: 'ImportOrdersCsv', csv: sample.csv, fileName: sample.fileName },
    { invocationId: input.invocationId, now: input.importedAt, viewer },
  ).pipe(Effect.map((change) => change.state));
});
