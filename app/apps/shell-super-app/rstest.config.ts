import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { withModernConfig } from '@modern-js/adapter-rstest';
import { defineConfig } from '@rstest/core';
import { Result, Schema } from 'effect';

import {
  DeploymentAllowlistOverlaySchema,
  DeploymentAllowlistTopologySchema,
} from './api/modules/deployment-allowlist.ts';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const topologyJsonSchema = Schema.fromJsonString(
  DeploymentAllowlistTopologySchema
);
const overlayJsonSchema = Schema.fromJsonString(
  DeploymentAllowlistOverlaySchema
);
const moduleDeploymentAllowlistJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    environment: Schema.Literal('development'),
    overlay: DeploymentAllowlistOverlaySchema,
    topology: DeploymentAllowlistTopologySchema,
  })
);
const siteUrlJsonSchema = Schema.fromJsonString(Schema.String);
const referenceTopology = Result.getOrThrow(
  Schema.decodeUnknownResult(topologyJsonSchema, {
    onExcessProperty: 'preserve',
  })(
    readFileSync(
      new URL('../../topology/reference-topology.json', import.meta.url),
      'utf-8'
    )
  )
);
const developmentOverlay = Result.getOrThrow(
  Schema.decodeUnknownResult(overlayJsonSchema, {
    onExcessProperty: 'preserve',
  })(
    readFileSync(
      new URL(
        '../../topology/local-overlays/development.json',
        import.meta.url
      ),
      'utf-8'
    )
  )
);
const encodeOptions = { onExcessProperty: 'preserve' } as const;
const encodedReferenceTopology = Result.getOrThrow(
  Schema.encodeResult(topologyJsonSchema, encodeOptions)(referenceTopology)
);
const encodedModuleDeploymentAllowlist = Result.getOrThrow(
  Schema.encodeResult(
    moduleDeploymentAllowlistJsonSchema,
    encodeOptions
  )({
    environment: 'development',
    overlay: developmentOverlay,
    topology: referenceTopology,
  })
);
const encodedSiteUrl = Result.getOrThrow(
  Schema.encodeResult(siteUrlJsonSchema)('http://localhost:3020')
);

export default defineConfig({
  clearMocks: true,
  extends: withModernConfig({
    configPath: './modern.rstest.config.ts',
  }),
  include: ['tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  output: {
    module: false,
  },
  restoreMocks: true,
  source: {
    define: {
      ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: encodedReferenceTopology,
      ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: encodedModuleDeploymentAllowlist,
      ULTRAMODERN_SITE_URL: encodedSiteUrl,
    },
  },
  testEnvironment: 'happy-dom',
});
