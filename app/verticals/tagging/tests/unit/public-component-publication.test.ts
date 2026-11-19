import { fileURLToPath } from 'node:url';
import { getVerticalRuntimeEntrypoints } from '@app/core-runtime';
import { getMFConfig } from '@module-federation/modern-js-v3/config-plugin';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TagControls } from '../../src/components/tag-controls.tsx';
import { taggingManifest } from '../../vertical.manifest.ts';
import { taggingRegistration } from '../../vertical.registration.ts';

it('publishes tag-controls through its tenant-scoped Shell entrypoint', () => {
  expect(taggingManifest.publicSurface.components['tag-controls']).toBe(TagControls);
  expect(taggingManifest.publicSurface.shellContributions.publicComponents).toEqual([
    expect.objectContaining({
      componentKey: 'demo.tagging.tag-controls',
      contributionKey: 'demo.tagging.component.tag-controls',
      entrypoint: expect.objectContaining({
        entrypointKey: 'demo.tagging.component.tag-controls',
        moduleKey: 'demo.tagging',
        role: 'public_component',
        scope: 'tenant',
      }),
      expose: './TagControls',
    }),
  ]);
});

it.effect('the registered loader and federation expose bind the published artifact', () =>
  Effect.gen(function* artifactBindings() {
    const loader = Option.getOrThrow(
      Option.fromUndefinedOr(getVerticalRuntimeEntrypoints(taggingRegistration).components['tag-controls']),
    );
    const artifact = yield* Effect.promise(loader);
    expect(artifact).toHaveProperty('default', TagControls);
    const config = yield* Effect.promise(() =>
      getMFConfig({ configPath: fileURLToPath(new URL('../../module-federation.config.ts', import.meta.url)) }),
    );
    const exposes = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(config.exposes);
    expect(exposes['./TagControls']).toBe('./src/components/tag-controls.tsx');
  }),
);
