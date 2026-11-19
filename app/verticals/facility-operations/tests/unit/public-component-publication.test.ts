import { fileURLToPath } from 'node:url';
import { getVerticalRuntimeEntrypoints } from '@app/core-runtime';
import { getMFConfig } from '@module-federation/modern-js-v3/config-plugin';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { RecordDiscussion } from '../../src/components/record-discussion.tsx';
import { facilityOperationsManifest } from '../../vertical.manifest.ts';
import { facilityOperationsRegistration } from '../../vertical.registration.ts';

it('publishes record-discussion through its tenant-scoped Shell entrypoint', () => {
  expect(facilityOperationsManifest.publicSurface.components['record-discussion']).toBe(RecordDiscussion);
  expect(facilityOperationsManifest.publicSurface.shellContributions.publicComponents).toEqual([
    expect.objectContaining({
      componentKey: 'facility.operations.record-discussion',
      contributionKey: 'facility.operations.component.record-discussion',
      entrypoint: expect.objectContaining({
        entrypointKey: 'facility.operations.component.record-discussion',
        moduleKey: 'facility.operations',
        role: 'public_component',
        scope: 'tenant',
      }),
      expose: './RecordDiscussion',
    }),
  ]);
});

it.effect('the registered loader and federation expose bind the published artifact', () =>
  Effect.gen(function* artifactBindings() {
    const loader = Option.getOrThrow(
      Option.fromUndefinedOr(
        getVerticalRuntimeEntrypoints(facilityOperationsRegistration).components['record-discussion'],
      ),
    );
    const artifact = yield* Effect.promise(loader);
    expect(artifact).toHaveProperty('default', RecordDiscussion);
    const config = yield* Effect.promise(() =>
      getMFConfig({ configPath: fileURLToPath(new URL('../../module-federation.config.ts', import.meta.url)) }),
    );
    const exposes = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(config.exposes);
    expect(exposes['./RecordDiscussion']).toBe('./src/components/record-discussion.tsx');
  }),
);
