import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { Effect, Exit, Schema } from 'effect';

import { validateActiveApplicationCompositionSnapshot } from '../../../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  applicationCompositionRevision,
  decodeActiveApplicationCompositionSnapshot,
} from '../../../../scripts/active-application-composition.mts';

const metadataSchema = Schema.Struct({ activeApplicationCompositionUrl: Schema.URLFromString });

test('publishes the exact native browser owner contracts and federation bytes under one admitted revision', async ({
  request,
}, testInfo) => {
  const compositionUrl = Schema.decodeUnknownSync(metadataSchema)(testInfo.config.metadata)
    .activeApplicationCompositionUrl.href;
  const publication = await request.get(compositionUrl);
  expect(publication.status()).toBe(200);
  const snapshot = await Effect.runPromise(
    decodeActiveApplicationCompositionSnapshot(await publication.text()).pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    ),
  );
  expect(snapshot.composition.modules.map(({ deployment }) => deployment.appId).toSorted()).toEqual([
    'inventory',
    'party-registry',
  ]);
  expect(snapshot.composition.revision).toBe(applicationCompositionRevision(snapshot.composition));
  const artifacts = [snapshot.composition.shell.federationManifest, snapshot.composition.shell.runtimeContract];
  for (const module of snapshot.composition.modules) {
    artifacts.push(module.contract);
    if (module.federation.execution === 'browser') {
      artifacts.push(module.federation.manifest);
    }
  }
  await Promise.all(
    artifacts.map(async (artifact) => {
      const response = await request.get(artifact.url);
      expect(response.status(), artifact.url).toBe(200);
      expect(
        createHash('sha256')
          .update(await response.body())
          .digest('hex'),
        artifact.url,
      ).toBe(artifact.sha256);
    }),
  );
});

test('the native composition guard rejects altered owner contract bytes', async ({ request }, testInfo) => {
  const compositionUrl = Schema.decodeUnknownSync(metadataSchema)(testInfo.config.metadata)
    .activeApplicationCompositionUrl.href;
  const publication = await request.get(compositionUrl);
  expect(publication.status()).toBe(200);
  const snapshot = await Effect.runPromise(decodeActiveApplicationCompositionSnapshot(await publication.text()));
  const rejected = await Effect.runPromiseExit(
    validateActiveApplicationCompositionSnapshot({
      ...snapshot,
      composition: {
        ...snapshot.composition,
        modules: snapshot.composition.modules.map((module) => ({
          ...module,
          contractDocument: `${module.contractDocument} `,
        })),
      },
    }),
  );
  expect(Exit.isFailure(rejected)).toBe(true);
});
