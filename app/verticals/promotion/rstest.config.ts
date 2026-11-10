import { fileURLToPath } from 'node:url';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { defineConfig } from '@rstest/core';
import { encodeSync, fromJsonString, String as StringSchema } from 'effect/Schema';
import buildArtifact from './shared/ultramodern-build.json' with { type: 'json' };

// Match module-contract generation before the test runner writes any artifacts.
const buildIdentity = resolveUltramodernReleaseIdentity({
  generationBuildMarker: buildArtifact.deliveryUnit.buildMarker,
  unitId: buildArtifact.deliveryUnit.unitId,
  workspaceRoot: fileURLToPath(new URL('../../', import.meta.url)),
});
const encodeString = encodeSync(fromJsonString(StringSchema));
// Bind only this owner: global defines would also replace independent imported owners' markers.
const ownerBuildRules =
  buildIdentity.buildMarker === buildArtifact.deliveryUnit.buildMarker &&
  buildIdentity.sourceRevision === buildArtifact.deliveryUnit.sourceRevision
    ? []
    : [
        {
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
        },
      ];
const tools = {
  rspack: { module: { rules: ownerBuildRules } },
  swc: { jsc: { parser: { syntax: 'typescript' } } },
} as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      tools,
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      testTimeout: 30_000,
      tools,
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
