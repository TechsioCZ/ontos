import { fileURLToPath } from 'node:url';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { defineConfig } from '@rstest/core';
import { encodeSync, fromJsonString, String as StringSchema } from 'effect/Schema';
import buildArtifact from './shared/ultramodern-build.json' with { type: 'json' };

// Resolve before Rstest creates artifacts, and bind only this owner's build module.
// Other owners in the test graph must retain their own independent identities.
const buildIdentity = resolveUltramodernReleaseIdentity({
  generationBuildMarker: buildArtifact.deliveryUnit.buildMarker,
  unitId: buildArtifact.deliveryUnit.unitId,
  workspaceRoot: fileURLToPath(new URL('../../', import.meta.url)),
});
const encodeString = encodeSync(fromJsonString(StringSchema));
const ownerBuildRule = {
  include: [fileURLToPath(new URL('shared/ultramodern-build.ts', import.meta.url))],
  use: [
    {
      loader: 'builtin:swc-loader',
      options: {
        jsc: {
          parser: { syntax: 'typescript' },
          transform: {
            optimizer: {
              globals: {
                vars: {
                  ULTRAMODERN_BUILD_MARKER: encodeString(buildIdentity.buildMarker),
                  ULTRAMODERN_SOURCE_REVISION: encodeString(buildIdentity.sourceRevision),
                },
              },
            },
          },
        },
      },
    },
  ],
};

// Generation metadata needs no extra transform; only a distinct release identity does.
const ownerBuildRules =
  buildIdentity.buildMarker === buildArtifact.deliveryUnit.buildMarker &&
  buildIdentity.sourceRevision === buildArtifact.deliveryUnit.sourceRevision
    ? []
    : [ownerBuildRule];

const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      testTimeout: 30_000,
      tools: { rspack: { module: { rules: ownerBuildRules } }, swc },
    },
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      tools: { swc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
