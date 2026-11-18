// @rstest-environment happy-dom
// The document pin guards the real Federation runtime: no Federation host is created in this file, so any load
// that reaches Federation answers `unavailable`, and only a load stopped before it can fail with a revision conflict.
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  BrowserModuleRevisionConflict,
  loadBrowserModuleEntrypoint,
} from '../../src/routes/module-entrypoint-loader.ts';
import { ResolvedModuleTargetSchema } from '../../shared/browser-api.ts';

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

it.effect('fails before consulting Federation when a document is already pinned to another release', () =>
  Effect.gen(function* rejectChangedRelease() {
    const target = targetOf('native-revision');
    // Federation has no host instance here: a load that reaches it answers unavailable.
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
