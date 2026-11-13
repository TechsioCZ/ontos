import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { PORTAL_OWN_OPERATION } from '../../../../verticals/commerce-customer-context/shared/portal-auth/own-session.ts';
import { deriveOntosModuleRelease } from '../../../../scripts/generate-ontos-module-contract.mts';

/*
 * The storefront customer's own profile, consents and password are served only by their portal routes, to the
 * registered storefront client. This pins the release Customer Context publishes: no generic surface addresses the
 * five carriers. MCP read/execute resolve a tool of the module's tool catalog, and the catalog names none of them (its
 * contribution publishes nothing else MCP can address); and the three Actions on the module
 * surface (which the agent platform resolves by slug) are workload-only, so any person, agent, API key, OAuth or
 * delegated module call is refused by the gate (the Shell's real-gate carriers test decides each).
 */

const OPERATIONS: readonly string[] = Object.values(PORTAL_OWN_OPERATION);
const SLUGS = [
  'change-own-customer-password',
  'update-own-customer-consent',
  'update-own-customer-profile',
  'customer-consent-read-own',
  'customer-profile-read-own',
];

it.layer(NodeServices.layer)('the published Customer Context release', (suite) => {
  suite.effect('offers no generic dispatch of the five portal carriers: no MCP tool, only workload-only Actions', () =>
    Effect.gen(function* releaseSurface() {
      const { contract, mcpToolCatalog } = yield* deriveOntosModuleRelease({ vertical: 'commerce-customer-context' });
      const tools = mcpToolCatalog ?? '';
      // The module does offer MCP tools (its other reads and Actions): the catalog is real, not empty.
      expect(tools).toContain('commerce.customer-context.');
      for (const name of [...OPERATIONS, ...SLUGS]) {
        expect({ inToolCatalog: tools.includes(name), name }).toEqual({ inToolCatalog: false, name });
      }
      const surface = contract.manifest.publicSurface;
      const carriers = surface.actions.filter(({ actionKey }) => OPERATIONS.includes(actionKey));
      expect(carriers.map(({ actionKey }) => actionKey).toSorted()).toEqual(
        [
          PORTAL_OWN_OPERATION.credentialChange,
          PORTAL_OWN_OPERATION.updateConsent,
          PORTAL_OWN_OPERATION.updateProfile,
        ].toSorted(),
      );
      for (const carrier of carriers) {
        expect({
          actionKey: carrier.actionKey,
          declared: 'accessDeclaration' in carrier && carrier.accessDeclaration !== undefined,
          workloads: 'accessWorkload' in carrier ? carrier.accessWorkload?.workloads : [],
        }).toEqual({ actionKey: carrier.actionKey, declared: false, workloads: ['commerce.storefront-client'] });
      }
    }),
  );
});
