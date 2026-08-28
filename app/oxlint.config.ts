import { defineConfig } from 'oxlint';
import core from 'ultracite/oxlint/core';
import { jsPluginSettings, selectJsPlugins } from 'ultracite/oxlint/js-plugins';
import react from 'ultracite/oxlint/react';

const jsPlugins = selectJsPlugins(['github', 'sonarjs', 'react-doctor']);

const antiSlopRules = {
  'anti-slop/no-chained-type-assertions': 'error',
  'anti-slop/no-conditional-empty-object-spread': 'error',
  'anti-slop/no-known-value-widening': 'error',
  'anti-slop/no-module-mocking': 'error',
  'anti-slop/no-object-parameters': 'error',
  'anti-slop/no-reflect-apply': 'error',
  'anti-slop/no-reflect-get': 'error',
  'anti-slop/no-runtime-typeof': 'error',
  'anti-slop/no-shape-in-symbol-names': 'error',
  'anti-slop/no-unknown-parameters': 'error',
  'anti-slop/no-unknown-returns': 'error',
  'anti-slop/no-unknown-type-aliases': 'error',
  'anti-slop/no-unsafe-dictionary-type': 'error',
  'anti-slop/no-widen-then-assert': 'error',
  'anti-slop/require-safety-comment-for-type-assertion': 'error',
};

const antiSlopEffectRules = {
  'anti-slop-effect/no-service-constructor-imports': 'error',
};

export default defineConfig({
  categories: {
    correctness: 'error',
  },
  env: {
    browser: true,
    node: true,
  },
  extends: [core, react, jsPlugins],
  ignorePatterns: [
    '.agents',
    '.codex/skills',
    '.output',
    'dist',
    'node_modules',
    'repos/**',
    '.modern',
    '.modernjs',
    '**/modern-tanstack/**',
    '**/routeTree.gen.*',
    'tools/oxlint/anti-slop/**',
  ],
  jsPlugins: [
    ...jsPlugins.jsPlugins,
    '@nkzw/eslint-plugin',
    'eslint-plugin-perfectionist',
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
    {
      name: 'anti-slop-effect',
      specifier: './tools/oxlint/anti-slop/effect/index.ts',
    },
  ],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    {
      files: ['**/*.{js,jsx,mjs,cjs}'],
      rules: {
        'no-undef': 'error',
      },
    },
    {
      // Operational scripts intentionally report successful command output.
      files: ['**/scripts/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
      rules: {
        'no-console': 'off',
      },
    },
    {
      // These tests inspect complete public/module surfaces; namespace imports are the assertion.
      files: [
        'apps/shell-super-app/tests/unit/routes/home/loader.test.ts',
        'apps/shell-super-app/tests/unit/routes/modules/loader.test.ts',
        'packages/core-runtime/tests/unit/action-public-surface.test.ts',
        'packages/core-runtime/tests/unit/schema-contract.test.ts',
        'verticals/contacts/tests/unit/schema-contract.test.ts',
      ],
      rules: {
        'import/no-namespace': 'off',
        'sonarjs/no-wildcard-import': 'off',
      },
    },
    {
      // Effect intentionally exposes Schema and Predicate as namespace-style module APIs.
      files: [
        'apps/shell-super-app/module-deployment-allowlist.config.ts',
        'apps/shell-super-app/module-federation.config.ts',
        'apps/shell-super-app/rstest.config.ts',
        'apps/shell-super-app/tests/integration/module-federation-i18n-runtime.test.ts',
        'verticals/contacts/backend-federation.config.ts',
        'verticals/contacts/module-federation.config.ts',
      ],
      rules: {
        'sonarjs/no-wildcard-import': 'off',
      },
    },
    {
      // Module Federation reads dependency versions dynamically; static JSON imports cannot express this contract.
      files: [
        'apps/shell-super-app/module-federation.config.ts',
        'verticals/contacts/backend-federation.config.ts',
        'verticals/contacts/module-federation.config.ts',
      ],
      rules: {
        'typescript/no-require-imports': 'off',
      },
    },
    {
      // Rollback sentinels and Date hashing are intentional nominal boundaries inside the runtime.
      files: [
        'packages/core-runtime/src/actions/repository.ts',
        'packages/core-runtime/src/actions/runtime.ts',
        'packages/core-runtime/src/reads/runtime.ts',
      ],
      rules: {
        '@nkzw/no-instanceof': 'off',
      },
    },
    {
      // DOM constructors are the platform-provided nominal narrowing boundary in these browser tests.
      files: [
        'apps/shell-super-app/tests/unit/layout.test.tsx',
        'verticals/contacts/tests/components/customer-create-page.test.tsx',
        'verticals/contacts/tests/components/customer-edit-page.test.tsx',
      ],
      rules: {
        '@nkzw/no-instanceof': 'off',
      },
    },
    {
      // Test registration deliberately returns an ignored promise, and test synchronization may use `.then`.
      files: [
        '**/*.{test,spec,test-d,spec-d}.{ts,tsx,js,jsx}',
        '**/__tests__/**/*.{ts,tsx,js,jsx}',
      ],
      rules: {
        'github/no-then': 'off',
        // Ultracite's JS-plugin preset applies the same test-data exception; repeat it because
        // the root override is the final merged test policy.
        'sonarjs/no-duplicate-string': 'off',
        'typescript/no-floating-promises': [
          'error',
          {
            allowForKnownSafeCalls: [
              { from: 'package', name: ['it', 'test'], package: '@playwright/test' },
              { from: 'package', name: ['it', 'test'], package: '@rstest/core' },
              { from: 'package', name: ['it', 'test'], package: 'node:test' },
            ],
          },
        ],
      },
    },
    {
      // Route/build metadata is declarative data: extracting repeated values into code constants
      // would obscure the independently consumable records without reducing executable duplication.
      files: [
        '**/route.meta.ts',
        'apps/shell-super-app/shared/ultramodern-build.ts',
        'apps/shell-super-app/src/routes/ultramodern-route-metadata.ts',
        'verticals/contacts/shared/ultramodern-build.ts',
        'verticals/contacts/src/routes/ultramodern-route-metadata.ts',
        'verticals/contacts/vertical.manifest.ts',
      ],
      rules: {
        'sonarjs/no-duplicate-string': 'off',
      },
    },
    {
      // Governed descriptors intentionally repeat owner, action, policy, and problem literals so
      // each serialized/audited record is complete; shared constants would hide contract evidence.
      files: [
        'apps/shell-super-app/api/index.ts',
        'apps/shell-super-app/api/modules/shell-governed-reads.ts',
        'apps/shell-super-app/src/routes/use-shell-controls.ts',
        'apps/shell-super-app/tests/integration/generated-owner-fixture.ts',
        'packages/core-runtime/scripts/verify-db-schema.mts',
        'packages/core-runtime/src/actions/repository.ts',
        'packages/core-runtime/src/auth/principal-administration-reads.ts',
        'packages/core-runtime/src/modules/actions/*.action.ts',
        'packages/core-runtime/src/modules/module-state-gate.ts',
        'packages/core-runtime/src/modules/shell-contribution.ts',
        'packages/core-runtime/src/modules/tenant-module-state-service.ts',
        'packages/core-runtime/src/operations/context.ts',
        'packages/core-runtime/tests/fixtures/outbox-worker-process.fixture.ts',
        'verticals/contacts/scripts/verify-db-schema.mts',
        'verticals/contacts/src/actions/*.action.ts',
        'verticals/contacts/src/api/customer-ares-lookup.read.ts',
      ],
      rules: {
        'sonarjs/no-duplicate-string': 'off',
      },
    },
    {
      // Effect runtimes keep generators, transactions, and recovery callbacks beside the
      // operation whose typed channel they close; hoisting them would split one atomic workflow.
      files: [
        'apps/shell-super-app/api/auth/identity-lifecycle.ts',
        'apps/shell-super-app/api/auth/impersonation-service.ts',
        'apps/shell-super-app/api/auth/service.ts',
        'apps/shell-super-app/api/index.ts',
        'apps/shell-super-app/api/modules/shell-composition.ts',
        'apps/shell-super-app/api/modules/shell-resources.ts',
        'apps/shell-super-app/src/routes/**/modules/**/page.tsx',
        'packages/core-runtime/src/actions/collector.ts',
        'packages/core-runtime/src/actions/runtime.ts',
        'packages/core-runtime/src/outbox/repository.ts',
        'packages/core-runtime/src/reads/runtime.ts',
        'verticals/contacts/src/auth/gateway-assertion-redemption-runtime.ts',
        'verticals/contacts/tests/integration/customer-contact-operations.test.ts',
        'verticals/contacts/tests/unit/customer-contact-persistence.service.test.ts',
      ],
      rules: {
        'sonarjs/no-nested-functions': 'off',
      },
    },
    {
      // `Error` is the conventional Effect error-channel type parameter, not a runtime override
      // of the global Error constructor. SonarJS does not distinguish type and value namespaces.
      files: [
        'apps/shell-super-app/api/index.ts',
        'packages/core-runtime/src/actions/runtime.ts',
        'packages/core-runtime/src/outbox/definition.ts',
        'packages/core-runtime/src/outbox/runtime.ts',
        'packages/core-runtime/src/permissions/client.ts',
        'packages/core-runtime/src/reads/definition.ts',
        'packages/core-runtime/tests/integration/action-permission.test.ts',
        'packages/core-runtime/tests/integration/action-runtime.test.ts',
        'packages/core-runtime/tests/integration/module-state-gate.test.ts',
        'packages/core-runtime/tests/integration/tenant-module-state.test.ts',
      ],
      rules: {
        'sonarjs/no-built-in-override': 'off',
      },
    },
    {
      // These boundaries deliberately distinguish absent (`undefined`) from present-null values;
      // replacing it with null would change exact-optional and fixture contracts.
      files: [
        'apps/shell-super-app/api/modules/installed-module-catalog.ts',
        'apps/shell-super-app/tests/unit/stage-demo-bootstrap.test.ts',
        'packages/core-runtime/src/actions/runtime.ts',
        'packages/core-runtime/tests/integration/action-permission.test.ts',
        'packages/core-runtime/tests/integration/action-runtime.test.ts',
        'packages/core-runtime/tests/unit/action-collector.test.ts',
        'packages/core-runtime/tests/unit/action-runtime.test.ts',
        'packages/core-runtime/tests/unit/read-definition.test.ts',
        'verticals/contacts/api/index.ts',
        'verticals/contacts/tests/components/contact-edit-page.test.tsx',
      ],
      rules: {
        'sonarjs/no-undefined-assignment': 'off',
      },
    },
    {
      // React component names are intentionally PascalCase, contrary to SonarJS's function-name default.
      files: ['**/*.tsx', 'apps/shell-super-app/tests/integration/module-catalog-runtime.test.ts'],
      rules: {
        'sonarjs/function-name': 'off',
      },
    },
    {
      // UltraModern, Drizzle, generated federation declarations, and service tests mandate dotted filenames.
      files: [
        'apps/shell-super-app/drizzle.auth.config.ts',
        'apps/shell-super-app/modern.rstest.config.ts',
        'verticals/contacts/modern.rstest.config.ts',
        'verticals/contacts/src/federation/page-customers-list.runtime.d.ts',
        'verticals/contacts/tests/unit/ares-subject.service.test.ts',
        'verticals/contacts/tests/unit/customer-contact-persistence.service.test.ts',
      ],
      rules: {
        'github/filenames-match-regex': 'off',
      },
    },
    {
      // These files define intentionally non-production demo/test credentials.
      files: [
        'apps/shell-super-app/api/auth/stage-demo-bootstrap-contract.ts',
        'apps/shell-super-app/tests/e2e/auth-fixture.ts',
        'apps/shell-super-app/tests/integration/auth-runtime.test.ts',
        'apps/shell-super-app/tests/integration/identity-modes-runtime.test.ts',
        'apps/shell-super-app/tests/unit/auth-contract.test.ts',
        'apps/shell-super-app/tests/unit/stage-demo-bootstrap.test.ts',
      ],
      rules: {
        'sonarjs/no-hardcoded-passwords': 'off',
      },
    },
    {
      // Dynamic Modern.js cache paths contain `.js-${appId}` but are filesystem paths,
      // not CSS class names; the GitHub rule cannot distinguish those string domains.
      files: ['apps/shell-super-app/modern.config.ts', 'verticals/contacts/modern.config.ts'],
      rules: {
        'github/js-class-name': 'off',
      },
    },
    {
      // React Doctor currently emits its internal computed-property lowering TODO for this
      // typed form-error update; the code is valid and the dedicated compiler rules stay active.
      files: ['verticals/contacts/src/features/customers/customer-form.tsx'],
      rules: {
        'react/todo': 'off',
      },
    },
    {
      // This contract test intentionally passes the `undefined` value decoded by Schema.Void;
      // moving the value to a statement, as suggested by the rule, would stop testing the call.
      files: ['packages/core-runtime/tests/unit/action-definition.test.ts'],
      rules: {
        'typescript/no-confusing-void-expression': 'off',
      },
    },
    {
      // These aliases name stable domain boundaries even when their current representation is
      // identical to another type; removing the names would couple public/runtime APIs to storage.
      files: [
        'apps/shell-super-app/src/api/auth-client.ts',
        'packages/core-runtime/src/actions/runtime.ts',
      ],
      rules: {
        'sonarjs/redundant-type-aliases': 'off',
      },
    },
    {
      // Effect's typed rollback/control-flow sentinels deliberately do not extend native Error;
      // the language-service policy forbids native Error inheritance for these domain failures.
      files: [
        'apps/shell-super-app/api/auth/service.ts',
        'packages/core-runtime/src/actions/repository.ts',
        'packages/core-runtime/src/actions/runtime.ts',
        'packages/core-runtime/src/reads/runtime.ts',
        'packages/core-runtime/tests/integration/action-runtime.test.ts',
        'packages/core-runtime/tests/unit/action-runtime.test.ts',
        'packages/shared-contracts/src/index.ts',
      ],
      rules: {
        'typescript/only-throw-error': 'off',
      },
    },
    {
      // These exact framework/test callbacks intentionally return values that their consumers
      // ignore (spies, manifests, Node adapters, and React callbacks); changing them loses evidence.
      files: [
        'apps/shell-super-app/tests/integration/module-catalog-runtime.test.ts',
        'apps/shell-super-app/tests/unit/layout.test.tsx',
        'apps/shell-super-app/tests/unit/shell-composition.test.ts',
        'packages/core-runtime/src/outbox/process.ts',
        'packages/core-runtime/tests/integration/action-runtime.test.ts',
        'packages/core-runtime/tests/unit/module-manifest.test.ts',
        'packages/core-runtime/tests/unit/outbox-runtime.test.ts',
        'packages/core-runtime/tests/unit/read-runtime.test.ts',
        'verticals/contacts/tests/components/contact-form.test.tsx',
        'verticals/contacts/tests/components/customer-ares-loader.test.tsx',
        'verticals/contacts/tests/components/customer-form.test.tsx',
        'verticals/contacts/tests/integration/customer-ares-lookup-bff.test.ts',
        'verticals/contacts/tests/integration/customer-contact-bff.test.ts',
        'verticals/contacts/vertical.manifest.ts',
      ],
      rules: {
        'typescript/strict-void-return': 'off',
      },
    },
    {
      // Effect generators terminate through `return yield*` failures, React effects optionally
      // return cleanup functions, and route matching legitimately returns an optional result.
      files: [
        'apps/shell-super-app/api/auth/impersonation-service.ts',
        'apps/shell-super-app/src/routes/**/modules/**/page.tsx',
        'apps/shell-super-app/src/routes/ultramodern-route-head.tsx',
        'packages/core-runtime/src/auth/principal-management.ts',
        'packages/core-runtime/src/modules/module-state-gate.ts',
        'packages/core-runtime/src/outbox/runtime.ts',
        'verticals/contacts/src/routes/ultramodern-route-head.tsx',
        'verticals/contacts/tests/unit/action-principal.test.ts',
      ],
      rules: {
        'typescript/consistent-return': 'off',
      },
    },
    {
      // The receiver remains intact at each call site; the references only test an optional
      // Headers method or proxy a database method through a receiver-preserving getter.
      files: [
        'apps/shell-super-app/api/auth/impersonation-service.ts',
        'apps/shell-super-app/api/auth/service.ts',
        'packages/core-runtime/tests/integration/module-state-gate.test.ts',
      ],
      rules: {
        'typescript/unbound-method': 'off',
      },
    },
    {
      // Empty environment variables intentionally mean "unset" in deployment configuration;
      // replacing || with ?? changes fallback behavior, and those strings are validated later.
      files: [
        'apps/shell-super-app/modern.config.ts',
        'apps/shell-super-app/playwright.config.ts',
        'packages/core-runtime/src/outbox/poller.ts',
        'verticals/contacts/modern.config.ts',
      ],
      rules: {
        'typescript/prefer-nullish-coalescing': 'off',
        'typescript/strict-boolean-expressions': 'off',
      },
    },
    {
      // TSGo currently collapses these recursive JSON/locale aliases to `any` while the workspace
      // compiler resolves them correctly; keep the recursive boundary types and their parsers.
      files: [
        'verticals/contacts/tests/support/json-value.ts',
        'verticals/contacts/tests/support/locale-catalog.ts',
      ],
      rules: {
        'typescript/no-redundant-type-constituents': 'off',
      },
    },
    {
      // Node HTTP invokes these async request adapters as void callbacks; the tests await server
      // responses and close the exact server, so the promise lifecycle is observed at the boundary.
      files: [
        'verticals/contacts/tests/integration/customer-ares-lookup-bff.test.ts',
        'verticals/contacts/tests/integration/customer-contact-bff.test.ts',
      ],
      rules: {
        'typescript/no-misused-promises': 'off',
        'typescript/restrict-template-expressions': 'off',
      },
    },
    {
      // Promise.finally observes the async runtime disposer even though TSGo currently models its
      // callback as void-only; keeping the promise return is what makes process cleanup awaitable.
      files: ['packages/core-runtime/src/outbox/process.ts'],
      rules: {
        'typescript/no-misused-promises': 'off',
      },
    },
    {
      // This test deliberately constructs a boxed number behind a validated static type to prove
      // runtime normalization; the assertion and conversion are the behavior under test.
      files: [
        'apps/shell-super-app/api/modules/shell-composition.ts',
        'apps/shell-super-app/tests/unit/shell-composition.test.ts',
      ],
      rules: {
        'typescript/no-unnecessary-type-conversion': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
      },
    },
    {
      // Outbox matching and marking are intentionally serialized within one locked transaction;
      // Promise.all would violate ordering and may race the shared transaction executor.
      files: ['packages/core-runtime/src/outbox/repository.ts'],
      rules: {
        'react-doctor/async-await-in-loop': 'off',
      },
    },
    {
      // Drizzle object insertion order is the authoritative physical column order used by
      // migrations and schema contracts; alphabetizing these declarations changes that contract.
      files: [
        'apps/shell-super-app/api/auth/db/schema.ts',
        'packages/core-runtime/src/db/schema.ts',
        'verticals/contacts/src/db/schema.ts',
      ],
      rules: {
        'perfectionist/sort-objects': 'off',
      },
    },
    {
      // The outbox cycle uses one break for queue exhaustion and continues for two terminal
      // delivery stages; flattening those branches would obscure mutually exclusive outcomes.
      files: ['packages/core-runtime/src/outbox/runtime.ts'],
      rules: {
        'sonarjs/too-many-break-or-continue-in-loop': 'off',
      },
    },
    {
      // These memoized values cross form/query component boundaries where referential stability
      // avoids resetting controlled state; compiler caching is an optimization, not that contract.
      files: [
        'verticals/contacts/src/routes/**/contacts/customers/page.tsx',
        'verticals/contacts/src/routes/**/contacts/customers/**/page.tsx',
      ],
      rules: {
        'react-doctor/react-compiler-no-manual-memoization': 'off',
      },
    },
    {
      // The edit page keeps one cohesive mutation/detail workflow; splitting it would move
      // authorization and retry state across component boundaries during this lint-only migration.
      files: ['verticals/contacts/src/routes/**/contacts/customers/**/contacts/**/edit/page.tsx'],
      rules: {
        'react-doctor/no-giant-component': 'off',
      },
    },
    {
      // tsgolint currently loses Rstest mock signatures and several Node adapter overloads even
      // though the strict TSGo project build is clean. Keep compiler diagnostics active while
      // suppressing only the derived unsafe family inside test-only code.
      files: ['**/tests/**/*.ts', '**/tests/**/*.tsx'],
      rules: {
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
      },
    },
    {
      // tsgolint loses Modern.js route-hook generics for these pages while the referenced TSGo
      // build resolves them. Limit the exception to unsafe derivatives at that framework seam.
      files: ['verticals/contacts/src/routes/**/page.tsx'],
      rules: {
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
      },
    },
    {
      // tsgolint currently widens values after validated recursive/object boundaries and generic
      // policy descriptors even though the referenced TSGo build preserves their exact types.
      files: [
        'apps/shell-super-app/api/verticals/installed-verticals.ts',
        'packages/core-runtime/src/actions/definition.ts',
        'packages/core-runtime/src/actions/repository.ts',
        'packages/core-runtime/src/modules/runtime-registration.ts',
        'packages/core-runtime/src/reads/definition.ts',
      ],
      rules: {
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
      },
    },
    {
      // Recursive readonly dictionary interfaces are required for TSGo's recursive-type support;
      // they intentionally carry their contract through the inherited index signature.
      files: [
        'verticals/contacts/tests/support/json-value.ts',
        'verticals/contacts/tests/support/locale-catalog.ts',
      ],
      rules: {
        'typescript/no-empty-interface': 'off',
        'typescript/no-empty-object-type': 'off',
      },
    },
    {
      // The generated HttpApi client exposes overloads instead of one correlated union signature;
      // identical discriminant branches preserve narrowing for TSGo.
      files: ['apps/shell-super-app/src/api/auth-client.ts'],
      rules: {
        'sonarjs/no-all-duplicated-branches': 'off',
      },
    },
    {
      // Module Federation remotes are declared through an ambient wildcard; a top-level type import
      // would turn the declaration into an invalid module augmentation.
      files: ['apps/shell-super-app/src/modern-app-env.d.ts'],
      rules: {
        'typescript/consistent-type-imports': 'off',
      },
    },
    {
      // Governed generated surfaces and Promise-backed Effect adapters must keep direct promise
      // thunks: the Effect compiler rejects redundant async wrappers, which add no behavior.
      files: [
        'apps/shell-super-app/src/api/vertical-clients.ts',
        'apps/shell-super-app/src/routes/**/*.{ts,tsx}',
        'packages/core-runtime/src/install/action-authorization-provisioning.ts',
        'verticals/contacts/src/auth/gateway-assertion-redemption-runtime.ts',
        'verticals/contacts/api/auth/action-principal.ts',
        'verticals/contacts/src/db/client.ts',
        'verticals/contacts/src/routes/**/*.tsx',
        'verticals/*/vertical.registration.ts',
      ],
      rules: {
        'typescript/promise-function-async': 'off',
      },
    },
    {
      // This Proxy preserves the real Drizzle executor type while replacing two methods in a live
      // integration fixture. Reflect.get is required to preserve the original receiver.
      files: ['verticals/contacts/tests/integration/customer-ares-lookup-bff.test.ts'],
      rules: {
        'anti-slop/no-reflect-get': 'off',
      },
    },
    {
      // These contracts require functions/mocks to return the actual `undefined` value; omitting
      // the return or argument changes their inferred call signatures under exact optional types.
      files: [
        'apps/shell-super-app/tests/integration/auth-runtime.test.ts',
        'apps/shell-super-app/tests/unit/routes/home/page.test.tsx',
      ],
      rules: {
        'unicorn/no-useless-undefined': 'off',
      },
    },
    {
      // Strict index-signature access requires bracket notation here, while tsgolint's separate
      // stylistic pass incorrectly requests dot notation and widens decoded recursive JSON.
      files: ['apps/shell-super-app/module-deployment-allowlist.config.ts'],
      rules: {
        'typescript/dot-notation': 'off',
        'typescript/no-unsafe-argument': 'off',
      },
    },
    {
      // Modern.js's preset mismatch loses the Rspack-chain type after the compiler-suppressed
      // framework seam; keep unsafe inference exceptions limited to that one config callback.
      files: ['apps/shell-super-app/modern.config.ts'],
      rules: {
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
      },
    },
  ],
  rules: {
    '@nkzw/no-instanceof': 'error',
    '@nkzw/require-use-effect-arguments': 'error',
    // Ultracite core already enforces these policies through Unicorn and Promise rules.
    'github/array-foreach': 'off',
    'github/no-then': 'off',
    'import/export': 'error',
    'import/no-namespace': ['error', { ignore: ['effect/*'] }],
    'no-console': 'error',
    'perfectionist/sort-enums': ['error', { partitionByComment: true, sortByValue: 'always' }],
    'perfectionist/sort-heritage-clauses': 'error',
    'perfectionist/sort-interfaces': 'error',
    'perfectionist/sort-jsx-props': 'error',
    'perfectionist/sort-object-types': 'error',
    'perfectionist/sort-objects': ['error', { partitionByComment: true }],
    'react/no-unknown-property': 'error',
    // The base rule conflicts with the type-aware promise-function-async rule:
    // removing `async` immediately recreates the type-aware diagnostic.
    'require-await': 'off',
    'sort-keys': 'off',
    // Effect error channels are intentionally explicit tagged unions; two members is not a useful ceiling.
    'sonarjs/max-union-size': 'off',
    // Keep one authoritative rule for each concern instead of emitting duplicate diagnostics.
    'sonarjs/cognitive-complexity': 'off',
    'sonarjs/expression-complexity': 'off',
    'sonarjs/no-nested-conditional': 'off',
    'sonarjs/no-redundant-jump': 'off',
    'sonarjs/no-unused-vars': 'off',
    'typescript/no-require-imports': ['error', { allow: ['/package\\.json$'] }],
    // Terse void callbacks are idiomatic for framework and test APIs; confusing assignments remain errors.
    'typescript/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    // Single-use generics preserve inferred return predicates and object value types throughout Effect APIs.
    'typescript/no-unnecessary-type-parameters': 'off',
    // Annotating rejected-promise callbacks as unknown bypasses OntOS's named-error boundary policy.
    'typescript/use-unknown-in-catch-callback-variable': 'off',
    // Schema.TaggedError is a class factory invoked before `extends`; the Unicorn rule
    // mistakes that canonical Effect syntax for throwing an Error constructor without `new`.
    'unicorn/throw-new-error': 'off',
    'unicorn/prefer-string-raw': 'error',
    'unicorn/prefer-top-level-await': 'error',
    ...antiSlopRules,
    ...antiSlopEffectRules,
  },
  settings: jsPluginSettings,
});
