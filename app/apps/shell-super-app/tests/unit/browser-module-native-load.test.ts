// @rstest-environment happy-dom
// The Shell's native load runs on the real Federation runtime: a real host named as the Shell's, whose SDK fetches each
// remote's manifest and asks a runtime plugin for the remote's container (./routes/modules/federation-host.ts). Without
// that host a load that reaches Federation answers `unavailable`, and a load stopped before it fails with a revision
// conflict.
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  BrowserModuleRevisionConflict,
  loadBrowserModuleEntrypoint,
} from '../../src/routes/module-entrypoint-loader.ts';
import { ResolvedModuleTargetSchema } from '../../shared/browser-api.ts';
import { makeFederationHost } from './routes/modules/federation-host.ts';

const View = () => null;
const pageContract = Schema.Struct({
  default: Schema.declare<typeof View>((value): value is typeof View => Predicate.isFunction(value)),
});
const targetOf = (owner: string) =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: owner,
    componentKey: 'widget',
    compositionRevision: 'a'.repeat(64),
    entrypointKey: `${owner}.module.page.widget`,
    federation: {
      expose: './Widget',
      manifest: { sha256: 'b'.repeat(64), url: `https://${owner}.example/immutable-mf.json` },
      remoteName: owner,
    },
    moduleId: `${owner}.module`,
    routeParameters: {},
    writable: false,
  });

it.live('loads the exact pinned native expose through the scheduler and validates its export', () =>
  Effect.gen(function* loadPinnedExpose() {
    const target = targetOf('native-success');
    const host = yield* makeFederationHost({
      answer: () => Effect.succeed({ default: View }),
      refusedRemotes: [],
    });
    const result = yield* loadBrowserModuleEntrypoint(target, pageContract);
    expect(result).toMatchObject({ state: 'ready', value: { default: View } });
    expect(host.registered).toEqual([{ entry: target.federation.manifest.url, name: 'native-success' }]);
    expect(host.requests).toEqual(['native-success/Widget']);
  }),
);

it.live('rejects a native namespace that does not satisfy the caller contract', () =>
  Effect.gen(function* rejectIncompatibleExpose() {
    const target = targetOf('native-invalid');
    const host = yield* makeFederationHost({
      answer: () => Effect.succeed({ default: 'not a page' }),
      refusedRemotes: [],
    });
    expect(yield* loadBrowserModuleEntrypoint(target, pageContract)).toMatchObject({
      reason: 'incompatible',
      state: 'unavailable',
    });
    expect(host.requests).toEqual(['native-invalid/Widget']);
  }),
);

it.effect('fails before consulting Federation when a document is already pinned to another release', () =>
  Effect.gen(function* rejectChangedRelease() {
    const target = targetOf('native-revision');
    // No Federation host instance is registered in this case: a load that reaches Federation answers unavailable.
    expect(yield* loadBrowserModuleEntrypoint(target, pageContract)).toEqual({
      reason: 'unavailable',
      state: 'unavailable',
    });
    // Another release of the same document fails as a conflict, so it never got as far as Federation.
    const failure = yield* loadBrowserModuleEntrypoint(
      { ...target, compositionRevision: 'c'.repeat(64) },
      pageContract,
    ).pipe(Effect.flip);
    expect(Schema.is(BrowserModuleRevisionConflict)(failure)).toBe(true);
  }),
);
