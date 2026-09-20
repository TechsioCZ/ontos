import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { checkLeanCoreDependencies } from '../check-lean-core-dependencies.mts';

it.live(
  'flags Core Commerce/Storefront/Better-Auth vocabulary and non-Commerce mandatory imports of Commerce private implementation, while allowing documented seams',
  () =>
    Effect.gen(function* testEffect1() {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      const files = {
        // Shell: allowed documented composition seams.
        'apps/shell-super-app/api/auth/commerce-external-identity.ts':
          "import { verify } from '@app/commerce-customer-context/portal-auth/verification/client';\n",
        // Shell: violates via the bare Commerce package specifier (no subpath), resolved against the
        // exports map's "." entry, which points at Commerce's private src.
        'apps/shell-super-app/api/auth/external-identity/bare-specifier-import.ts':
          "import CommercePrivate from '@app/commerce-customer-context';\n",
        // Shell: violates via a multi-line named import — a line-oriented regex would miss the
        // specifier because the `from` clause is on a different line than `import`.
        'apps/shell-super-app/api/auth/external-identity/multiline-import.ts':
          "import {\n  EnrollmentJourney,\n} from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Shell: violates via a side-effect import (no bindings, no `from` keyword to match on).
        'apps/shell-super-app/api/auth/external-identity/side-effect-import.ts':
          "import '../../../../verticals/commerce-customer-context/src/enrollment/side-effects.ts';\n",
        // Shell: type-only imports of Commerce private implementation are exempt.
        'apps/shell-super-app/api/auth/external-identity/type-only.ts':
          "import type { EnrollmentJourney } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Shell: violates via a package specifier that resolves to Commerce private src (not a documented seam).
        'apps/shell-super-app/api/auth/external-identity/unauthorized-package-import.ts':
          "import { verify } from '@app/commerce-customer-context/portal-auth/verification/client';\nimport { EnrollmentJourney } from '@app/commerce-customer-context/api/client';\n",
        // Shell: violates by importing Commerce private src directly.
        'apps/shell-super-app/api/auth/external-identity/unauthorized-private-import.ts':
          "import { EnrollmentJourney } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Shell: allowed published shared contract, not a listed seam but not private implementation either.
        'apps/shell-super-app/src/api/uses-shared-contract.ts':
          "import { Contract } from '@app/commerce-customer-context/shared/contracts';\n",
        'apps/shell-super-app/src/api/vertical-clients.ts':
          "import { Client } from '@app/commerce-customer-context/api/client';\n",
        // Shell: test files under the ownership roots are exempt.
        'apps/shell-super-app/tests/unit/commerce-private-import.test.ts':
          "import { EnrollmentJourney } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Core: allowed external specifiers pass.
        'packages/core-runtime/package.json': JSON.stringify({
          dependencies: { effect: '^4.0.0', pg: '^8.0.0' },
        }),
        'packages/core-runtime/src/auth/allowed-unstable.ts': "import { Foo } from 'effect/unstable/bar';\n",
        'packages/core-runtime/src/auth/allowed.ts': "import { Effect } from 'effect';\nimport { Pool } from 'pg';\n",
        // Core: violates by importing Commerce vocabulary directly.
        'packages/core-runtime/src/auth/commerce-leak.ts':
          "import { CommercePortalAuth } from '@app/commerce-customer-context';\n",
        'packages/core-runtime/src/auth/relative.ts': "import { helper } from './allowed.ts';\n",
        // Core: violates by importing Commerce private implementation via a relative specifier that
        // resolves outside packages/core-runtime/src (regression for a gate that only checked bare specifiers).
        'packages/core-runtime/src/auth/relative-commerce-leak.ts':
          "import { CommercePortalAuth } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Core: violates by importing an unpinned external package.
        'packages/core-runtime/src/auth/unpinned.ts': "import { z } from 'zod';\n",
        // Core: tests directory is exempt.
        'packages/core-runtime/tests/unit/commerce-leak.test.ts':
          "import { CommercePortalAuth } from '@app/commerce-customer-context';\n",
        // Commerce publishes its exports map.
        'verticals/commerce-customer-context/package.json': JSON.stringify({
          exports: {
            '.': './src/index.ts',
            './api/client': './src/api/client.ts',
            './portal-auth/verification/client': './src/portal-auth/verification/client.ts',
            './shared/contracts': './shared/contracts.ts',
          },
        }),
        // party-registry: violates via direct api/ import.
        'verticals/party-registry/api/uses-commerce-api.ts':
          "import { OwnerTransition } from '../../commerce-customer-context/api/owner-transition.ts';\n",
      } as const;
      yield* Effect.all(
        Object.entries(files).map(([relative, source]) =>
          Effect.gen(function* testEffect2() {
            const file = path.join(root, relative);
            yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
            yield* Effect.tryPromise(() => writeFile(file, source));
          }),
        ),
      );
      const violations = yield* checkLeanCoreDependencies(root).pipe(Effect.provide(NodeServices.layer));
      expect(violations.map(({ file, line, reason }) => `${file}:${line}: ${reason}`)).toEqual([
        'apps/shell-super-app/api/auth/external-identity/bare-specifier-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/multiline-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/side-effect-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../../../verticals/commerce-customer-context/src/enrollment/side-effects.ts" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/unauthorized-package-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context/portal-auth/verification/client" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/unauthorized-package-import.ts:2: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context/api/client" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/unauthorized-private-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts" (only published shared/ contracts and documented composition seams are allowed)',
        'packages/core-runtime/src/auth/commerce-leak.ts:1: Core runtime source imports Commerce/Storefront/Better Auth package "@app/commerce-customer-context"',
        'packages/core-runtime/src/auth/relative-commerce-leak.ts:1: Core runtime source imports Commerce/Storefront/Better Auth via relative specifier "../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts" (resolves to "verticals/commerce-customer-context/src/enrollment/journeys/index.ts")',
        'packages/core-runtime/src/auth/unpinned.ts:1: Core runtime source imports a dependency outside the pinned external specifier set: "zod"',
        'verticals/party-registry/api/uses-commerce-api.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../commerce-customer-context/api/owner-transition.ts" (only published shared/ contracts and documented composition seams are allowed)',
      ]);
    }),
);

it.live('passes on a tree with only allowed dependencies and documented seams', () =>
  Effect.gen(function* testEffect3() {
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-clean-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    const files = {
      'apps/shell-super-app/src/api/vertical-clients.ts':
        "import { Client } from '@app/commerce-customer-context/api/client';\n",
      'packages/core-runtime/package.json': JSON.stringify({ dependencies: { effect: '^4.0.0' } }),
      'packages/core-runtime/src/index.ts': "import { Effect } from 'effect';\n",
      'verticals/commerce-customer-context/package.json': JSON.stringify({
        exports: { './api/client': './src/api/client.ts' },
      }),
    } as const;
    yield* Effect.all(
      Object.entries(files).map(([relative, source]) =>
        Effect.gen(function* testEffect4() {
          const file = path.join(root, relative);
          yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
          yield* Effect.tryPromise(() => writeFile(file, source));
        }),
      ),
    );
    const violations = yield* checkLeanCoreDependencies(root).pipe(Effect.provide(NodeServices.layer));
    expect(violations).toEqual([]);
  }),
);
