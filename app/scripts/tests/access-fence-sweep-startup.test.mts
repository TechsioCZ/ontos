import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { accessFenceSweepLines } from '../zerops/access-fence-sweep.mts';

/*
 * The Outbox host starts the access fence sweep once the host's own credentials are handed over, beside its other
 * Core maintenance, and the sweep's lines say what a tenant's users see.
 */
it('the Outbox host starts the fence sweep after the module credential hand-over', () => {
  const startup = readFileSync(new URL('../zerops/outbox-host-startup.mts', import.meta.url), 'utf-8');
  const handover = startup.indexOf('receiveModuleCredentialHandover(MODULE_CREDENTIAL_CALLERS)');
  const sweep = startup.indexOf('startAccessFenceSweep()');
  expect(handover).toBeGreaterThan(0);
  expect(sweep).toBeGreaterThan(handover);
});

it('prints a recovery, a tenant left to another writer, and a tenant still refusing Actions', () => {
  expect(
    accessFenceSweepLines({
      busy: ['t-2'],
      deferred: 0,
      failed: [{ reason: 'engine down', retryInMillis: 60_000, tenantId: 't-3' }],
      healed: ['t-1'],
    }),
  ).toEqual({
    busy: ['[access-fence-sweep] tenant t-2: another writer is healing it; left to that writer'],
    failed: [
      '[access-fence-sweep] TENANT t-3 STILL REFUSES ACTIONS (access projection incomplete): engine down; next try in 1 min',
    ],
    healed: [
      "[access-fence-sweep] tenant t-1: took over a lapsed access fence and reconciled it; the tenant's Actions run again",
    ],
  });
});
