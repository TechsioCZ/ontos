import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { deriveAppConfiguration, projectProofApp, RawAppSchema, TopologySchema } from '../proof-workerd-ssr.mts';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));

it('preserves canonical Shell remotes and Party SSR route in Workerd proof inputs', () => {
  const topology = Schema.decodeUnknownSync(TopologySchema)(
    JSON.parse(readFileSync(path.join(appRoot, 'topology/reference-topology.json'), 'utf-8')),
  );
  const shell = Schema.decodeUnknownSync(RawAppSchema)(projectProofApp({ ...topology.shell, kind: 'shell' }, 3020));
  const party = topology.verticals.find((app) => app.id === 'party-registry');
  if (party === undefined) {
    throw new Error('Party Registry is missing from canonical topology');
  }
  const partyRaw = Schema.decodeUnknownSync(RawAppSchema)(projectProofApp({ ...party, kind: 'vertical' }, 4102));
  expect(deriveAppConfiguration(shell).verticalRefs).toEqual(['party-registry', 'commerce-market-catalog', 'catalog']);
  expect(deriveAppConfiguration(partyRaw).proofRoutes).toEqual(['/en/contacts']);
  for (const id of ['commerce-customer-context', 'payment-term-catalog']) {
    const app = topology.verticals.find((vertical) => vertical.id === id);
    if (app === undefined) {
      throw new Error(`${id} is missing from canonical topology`);
    }
    expect(app.cloudflare?.routes?.ssr).toBeUndefined();
    const raw = Schema.decodeUnknownSync(RawAppSchema)(projectProofApp({ ...app, kind: 'vertical' }, 4101));
    expect(raw.surfaceProfile).toBe('api-only');
    expect(raw.deliveryUnit?.unitId).toBe(`app/${id}`);
  }
});
