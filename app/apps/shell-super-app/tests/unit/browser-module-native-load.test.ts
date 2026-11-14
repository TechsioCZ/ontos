import { Effect, Predicate, Schema } from 'effect';
import { beforeEach, expect, it, rs } from 'effect-rstest';

import {
  BrowserModuleRevisionConflict,
  loadBrowserModuleEntrypoint,
} from '../../src/routes/module-entrypoint-loader.ts';
import { ResolvedModuleTargetSchema } from '../../shared/browser-api.ts';

const View = () => null;
/** What a remote expose resolves to in these cases: the page component, or a value that is not one. */
interface RemoteNamespace {
  readonly default: string | typeof View;
}
/** The Federation host instance the shell finds by name, or none. */
const federation = rs.hoisted(() => ({
  getInstance: rs.fn<(predicate: (instance: { readonly name: string }) => boolean) => object | undefined>(),
}));
rs.mock('@module-federation/modern-js-v3/runtime', () => ({ getInstance: federation.getInstance }));

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

beforeEach(() => {
  federation.getInstance.mockReset();
});

it.effect('loads the exact pinned native expose through the scheduler and validates its export', () =>
  Effect.gen(function* loadPinnedExpose() {
    const target = targetOf('native-success');
    const registerRemotes = rs.fn();
    const loadRemote = rs.fn<(key: string) => Promise<RemoteNamespace>>().mockResolvedValue({ default: View });
    federation.getInstance.mockImplementation((matches) => {
      expect(matches({ name: 'shellSuperApp' })).toBe(true);
      expect(matches({ name: 'anotherHost' })).toBe(false);
      return { loadRemote, name: 'shellSuperApp', registerRemotes };
    });
    const result = yield* loadBrowserModuleEntrypoint(target, pageContract);
    expect(result).toMatchObject({ state: 'ready', value: { default: View } });
    expect(registerRemotes).toHaveBeenCalledExactlyOnceWith([
      { entry: target.federation.manifest.url, name: 'native-success' },
    ]);
    expect(loadRemote).toHaveBeenCalledExactlyOnceWith('native-success/Widget');
  }),
);

it.effect('rejects a native namespace that does not satisfy the caller contract', () =>
  Effect.gen(function* rejectIncompatibleExpose() {
    const target = targetOf('native-invalid');
    const loadRemote = rs.fn<(key: string) => Promise<RemoteNamespace>>().mockResolvedValue({ default: 'not a page' });
    federation.getInstance.mockReturnValue({ loadRemote, name: 'shellSuperApp', registerRemotes: rs.fn() });
    expect(yield* loadBrowserModuleEntrypoint(target, pageContract)).toMatchObject({
      reason: 'incompatible',
      state: 'unavailable',
    });
    expect(loadRemote).toHaveBeenCalledTimes(1);
  }),
);

it.effect('fails before consulting Federation when a document is already pinned to another release', () =>
  Effect.gen(function* rejectChangedRelease() {
    const target = targetOf('native-revision');
    // No Federation host instance: the reset mock answers none.
    expect(yield* loadBrowserModuleEntrypoint(target, pageContract)).toEqual({
      reason: 'unavailable',
      state: 'unavailable',
    });
    federation.getInstance.mockClear();
    const failure = yield* loadBrowserModuleEntrypoint(
      { ...target, compositionRevision: 'c'.repeat(64) },
      pageContract,
    ).pipe(Effect.flip);
    expect(Schema.is(BrowserModuleRevisionConflict)(failure)).toBe(true);
    expect(federation.getInstance).not.toHaveBeenCalled();
  }),
);
