import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  LegacyCompletionPublication,
  LegacyCompletionPublicationError,
} from '../../packages/core-runtime/src/modules/legacy-completion-publication.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  runApplicationCompositionMigration,
} from '../application-composition-authority-publication.mts';

const runtimeUrl = 'postgresql://ontos_runtime:runtime-test-secret@127.0.0.1:5432/publication';
const adminUrl = 'postgresql://ontos_admin:admin-test-secret@127.0.0.1:5432/publication';

it.effect('requires explicit distinct valid runtime and admin identities without leaking credentials', () =>
  Effect.gen(function* requiresNativeAdminConfiguration() {
    for (const environment of [
      {},
      { DATABASE_URL: runtimeUrl },
      { DATABASE_ADMIN_URL: adminUrl },
      { DATABASE_ADMIN_URL: runtimeUrl, DATABASE_URL: runtimeUrl },
      { DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: adminUrl },
      {
        DATABASE_ADMIN_URL: adminUrl,
        DATABASE_URL: 'https://ontos_runtime:runtime-test-secret@example.test/publication',
      },
      { DATABASE_ADMIN_URL: 'not-a-url-admin-test-secret', DATABASE_URL: runtimeUrl },
    ]) {
      const failure = yield* Layer.build(ApplicationCompositionAuthorityAdminDatabaseLive).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        Effect.scoped,
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(failure.reason).toMatch(/database (?:configuration|identities)/u);
      expect(failure.reason).not.toContain('admin-test-secret');
      expect(failure.reason).not.toContain('runtime-test-secret');
      expect(failure.cause).toBeUndefined();
    }
  }),
);

it.live(
  'failed owner lease acquisition settles Core before returning the original failure without publishing authority',
  () =>
    Effect.gen(function* failedOwnerAcquisition() {
      const statements: string[] = [];
      const events: string[] = [];
      let transactionOpen = false;
      let authorityLocked = false;
      let sessionLocked = false;
      let migrationExecuted = false;
      const original = new LegacyCompletionPublicationError({ reason: 'Scripted owner lease acquisition failed' });
      const executor = yield* makeTestDatabase((statement) =>
        Effect.sync(() => {
          statements.push(statement);
          const query = statement.toLowerCase();
          if (query === 'begin') {
            transactionOpen = true;
          } else if (query === 'rollback' || query === 'commit') {
            transactionOpen = false;
            authorityLocked = false;
            events.push(query);
          } else if (query.includes('pg_advisory_unlock(')) {
            sessionLocked = false;
            events.push('session unlocked');
            return [{ unlocked: true }];
          } else if (query.includes('pg_advisory_lock(')) {
            sessionLocked = true;
          } else if (query.includes('pg_advisory_xact_lock(')) {
            authorityLocked = true;
          } else if (query.includes('as initialized')) {
            return [{ initialized: true }];
          } else if (query.includes('completionschemainstalled')) {
            return [{ completionSchemaInstalled: true }];
          } else if (query.includes('from "core"."application_composition_authority"')) {
            return [
              { phase: 'sealed', revision: 'sealed-fixture-revision', validUntil: new Date('2027-01-01T00:00:00Z') },
            ];
          } else if (query.includes('as blocked')) {
            return [{ blocked: false }];
          } else if (query.includes('as isolation')) {
            return [{ isolation: 'read committed' }];
          }
          return [];
        }),
      );
      const failure = yield* runApplicationCompositionMigration(
        Effect.sync(() => {
          migrationExecuted = true;
        }),
        Effect.void,
      ).pipe(
        Effect.provideService(CoreDatabase, { executor }),
        Effect.provideService(LegacyCompletionPublication, {
          owners: [
            {
              producerModuleKey: 'scripted.owner',
              topic: 'scripted.topic',
              withLease: () =>
                Effect.sync(() => {
                  expect(transactionOpen).toBe(true);
                  expect(authorityLocked).toBe(true);
                  events.push('owner acquisition failed');
                }).pipe(Effect.andThen(Effect.fail(original))),
            },
          ],
          retainEvidence: () => Effect.void,
          runtimeTarget: { databaseName: 'publication_test', host: '127.0.0.1', port: 5432, user: 'ontos_runtime' },
          runtimeUser: 'ontos_runtime',
        }),
        Effect.flip,
        Effect.timeout('2 seconds'),
      );
      expect(failure).toBe(original);
      expect({ authorityLocked, migrationExecuted, sessionLocked, transactionOpen }).toEqual({
        authorityLocked: false,
        migrationExecuted: false,
        sessionLocked: false,
        transactionOpen: false,
      });
      expect(events).toEqual(['owner acquisition failed', 'rollback', 'session unlocked']);
      expect(statements.some((statement) => /^(?:insert|update|delete) /iu.test(statement))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
