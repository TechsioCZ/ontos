import { Effect } from 'effect';

import { dispatchModuleApiRequest } from '../../src/module-api/transport.ts';
import { symmyUnavailableProblem } from '../../shared/symmy/contract.ts';

const relayOrigin = 'https://symmy-owner-relay.invalid';
const shellApiMount = '/shell-super-app-api';
const releasePath = /^\/module-api\/(?<owner>[a-z][a-z0-9-]*)\/[^/?#\\]+\/(?<prefix>[a-z][a-z0-9-]*-api)$/u;
const operations: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'symmy-integration',
    new Set([
      'symmy-integration/actions/admit-symmy-job',
      'symmy-integration/actions/admit-symmy-sync',
      'reads/symmy-job-status',
      'reads/symmy-route-context',
    ]),
  ],
  ['catalog', new Set(['reads/catalog-source-products'])],
  ['price-group-catalog', new Set(['reads/price-group-source-associations', 'reads/price-group-definition'])],
  ['pricing', new Set(['reads/price-group-source-prices', 'reads/current-supported-currencies'])],
  ['commerce-market-catalog', new Set(['reads/current-market-catalog'])],
  [
    'commerce-customer-context',
    new Set(['reads/customer-profile-source', 'reads/customer-profile-ico', 'reads/organization-customer-profile-ico']),
  ],
  ['party-registry', new Set(['reads/source-profile-export', 'reads/organization-business-name-export'])],
]);

/** Only the issuer's release URL and this finite server-owned operation list reach the native relay. */
export const resolveSymmyOwnerReleaseBase = Effect.fn('SymmyOwnerRelay.resolve')(function* resolve(
  path: string,
  owner: string,
) {
  const relative = path.slice(shellApiMount.length);
  const match = releasePath.exec(relative);
  if (
    !path.startsWith(shellApiMount) ||
    !operations.has(owner) ||
    match?.groups?.['owner'] !== owner ||
    match.groups['prefix'] !== `${owner}-api`
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const url = new URL(relative, relayOrigin);
  return url.pathname === relative ? url : yield* Effect.fail(symmyUnavailableProblem);
});

export const forwardSymmyOwnerRelease = Effect.fn('SymmyOwnerRelay.forward')(function* forward(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const match = releasePath.exec(segments.slice(0, 5).join('/'));
  const owner = match?.groups?.['owner'];
  if (
    url.origin !== relayOrigin ||
    owner === undefined ||
    match?.groups?.['prefix'] !== `${owner}-api` ||
    operations.get(owner)?.has(segments.slice(5).join('/')) !== true ||
    url.search !== '' ||
    request.method !== 'POST'
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return yield* dispatchModuleApiRequest(request);
});
