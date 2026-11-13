import { decodeAccessWorkload } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { commerceCustomerContextMcpContribution } from '../../shared/mcp/contribution.ts';
import { PORTAL_OWN_CARRIER } from '../../shared/portal-auth/own-session.ts';
import { changeOwnCustomerPasswordAction } from '../../src/actions/change-own-customer-password.action.ts';
import { updateOwnCustomerConsentAction } from '../../src/actions/update-own-customer-consent.action.ts';
import { updateOwnCustomerProfileAction } from '../../src/actions/update-own-customer-profile.action.ts';
import { customerOwnConsentRead } from '../../src/api/customer-own-consent.read.ts';
import { customerOwnProfileRead } from '../../src/api/customer-own-profile.read.ts';

/*
 * The five storefront self-service registrations are reachable only through their portal routes, which admit the
 * customer's session from its cookie and hand the read or Action that session alone:
 *   - no generic Action or read endpoint: the module mounts each read and Action on its own explicit handler, and the
 *     only importers of these five are their own definition, the module's registration and manifest, and their route;
 *   - no MCP tool: MCP offers `/reads/<slug>` reads and public Actions only; these reads are on portal routes and the
 *     three Actions are hidden;
 *   - no delegated module call: a call by another module is decided only on a carrier that declares `accessActor`
 *     naming that caller (the gate's first rule, `deny.actor_forbidden` otherwise), and none of these declares one;
 *   - no person, agent, API key or OAuth caller: no `accessDeclaration`, so no capability anyone's role could hold.
 */

const REGISTRATIONS = [
  ['src/api/customer-own-profile.read.ts', customerOwnProfileRead.descriptor, 'api/portal-auth/profile/http.ts'],
  ['src/api/customer-own-consent.read.ts', customerOwnConsentRead.descriptor, 'api/portal-auth/consent/http.ts'],
  [
    'src/actions/update-own-customer-profile.action.ts',
    updateOwnCustomerProfileAction.descriptor,
    'api/portal-auth/profile/http.ts',
  ],
  [
    'src/actions/update-own-customer-consent.action.ts',
    updateOwnCustomerConsentAction.descriptor,
    'api/portal-auth/consent/http.ts',
  ],
  [
    'src/actions/change-own-customer-password.action.ts',
    changeOwnCustomerPasswordAction.descriptor,
    'api/portal-auth/password-change/http.ts',
  ],
] as const;

const SOURCE_ROOTS = ['api', 'src', 'shared'] as const;

/** Every TypeScript source of one source root, relative to the module root. */
const sourcesOf = Effect.fn('PortalReachability.sources')(function* sourcesOf(root: string, directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* fs.readDirectory(path.join(root, directory), { recursive: true });
  return files.filter((file) => file.endsWith('.ts')).map((file) => path.join(directory, file));
});
const MODULE_FILES = ['vertical.registration.ts', 'vertical.manifest.ts'] as const;

it('each registered carrier is the public carrier table entry the Shell real-gate test decides', () => {
  const byKey = {
    changePassword: changeOwnCustomerPasswordAction.descriptor,
    readConsent: customerOwnConsentRead.descriptor,
    readProfile: customerOwnProfileRead.descriptor,
    updateConsent: updateOwnCustomerConsentAction.descriptor,
    updateProfile: updateOwnCustomerProfileAction.descriptor,
  } as const;
  for (const [key, carrier] of Object.entries(PORTAL_OWN_CARRIER)) {
    const descriptor = new Map<string, (typeof byKey)[keyof typeof byKey]>(Object.entries(byKey)).get(key);
    expect({ key, workload: descriptor?.accessWorkload }).toEqual({
      key,
      workload: Result.getOrThrow(
        decodeAccessWorkload(carrier.workload, {
          access: carrier.access,
          authorization: { kind: 'protected' },
          moduleKey: 'commerce.customer-context',
          role: carrier.role,
        }),
      ),
    });
    expect({ access: descriptor?.entrypoint.access, key, role: descriptor?.entrypoint.role }).toEqual({
      access: carrier.access,
      key,
      role: carrier.role,
    });
  }
});

it('no carrier of the five admits a delegated module call, a person, an agent, an API key or OAuth', () => {
  for (const [, descriptor] of REGISTRATIONS) {
    expect('accessActor' in descriptor && descriptor.accessActor !== undefined).toBe(false);
    expect(descriptor.accessDeclaration).toBeUndefined();
    expect(descriptor.accessWorkload?.workloads).toEqual(['commerce.storefront-client']);
  }
});

it('MCP offers none of the five: the Actions are hidden and the reads are not module reads', () => {
  const actions = new Map<string, unknown>(Object.entries(commerceCustomerContextMcpContribution.actions));
  const reads = new Map<string, unknown>(Object.entries(commerceCustomerContextMcpContribution.reads));
  for (const slug of ['change-own-customer-password', 'update-own-customer-consent', 'update-own-customer-profile']) {
    expect(actions.get(slug)).toBe('hidden');
  }
  for (const slug of ['customer-profile-read-own', 'customer-consent-read-own']) {
    expect(reads.has(slug)).toBe(false);
  }
});

it.layer(NodeServices.layer)('the five registrations and their importers', (suite) => {
  suite.effect('only the definition, the module registration and manifest, and its own portal route import each', () =>
    Effect.gen(function* importers() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(import.meta.dirname, '../..');
      const listed = yield* Effect.forEach(SOURCE_ROOTS, (directory) => sourcesOf(root, directory), { concurrency: 1 });
      const sources = [...listed.flat(), ...MODULE_FILES];
      const texts = yield* Effect.forEach(
        sources,
        (file) => fs.readFileString(path.join(root, file)).pipe(Effect.map((text) => [file, text] as const)),
        { concurrency: 8 },
      );
      for (const [definition, , route] of REGISTRATIONS) {
        const moduleName = path.basename(definition, '.ts');
        const importing = texts
          .filter(([file, text]) => file !== definition && text.includes(`/${moduleName}.ts'`))
          .map(([file]) => file);
        const allowed = [route, ...MODULE_FILES].filter((file) =>
          texts.some(([candidate, text]) => candidate === file && text.includes(`/${moduleName}.ts'`)),
        );
        expect({ definition, importing: new Set(importing) }).toEqual({ definition, importing: new Set(allowed) });
        // Its own route is one of them: the portal route is how it is reached.
        expect(importing).toContain(route);
      }
    }),
  );
});
