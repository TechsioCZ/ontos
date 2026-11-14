import { NodeServices } from '@effect/platform-node';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { Effect, FileSystem, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { callerModuleAccess, emptyCallerAccessTrace } from '../../api/agent-platform/caller.ts';
import { accessAdminTemplateLayer } from '../support/access-admin-real-gate-fixture.ts';
import {
  CALLER_INSTALLED_BOUNDS,
  callerAccessOneAtATime,
  firstTaskAction,
  installedComposition,
  keptIn,
  measured,
  queueReadActionKeys,
  reportOf,
  reportPath,
  sessionScope,
  sorted,
  withAuthorityCase,
} from './agent-caller-authority-full-catalog.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '900 seconds' })(
  'agent platform caller authority over the installed release',
  (suite) => {
    suite.effect(
      "asks a stage tenant owner's caller authority only about the modules the tenant installed",
      () =>
        withAuthorityCase('work.tasks', (authorityCase) =>
          Effect.gen(function* installedCallerAuthority() {
            const snapshot = yield* installedComposition;
            const { companyId, owner, tenantId } = authorityCase;
            // Stage's N1 demo tenant: 6 of the release's modules installed, the owner holding full access.
            const installed = [
              'commerce.customer-context',
              'commerce.market-catalog',
              'commerce.storefront-registry',
              'demo.merchandise',
              'party.registry',
              'work.tasks',
            ];
            yield* authorityCase.reinstall(installed);
            const ownerScope = (correlationId: string) =>
              sessionScope({ correlationId, legalEntityId: companyId, principalId: owner, tenantId });
            const trace = yield* Ref.make(emptyCallerAccessTrace);
            const caller = yield* measured({
              authorityCase,
              correlationId: 'installed-caller-authority',
              read: callerModuleAccess({ scope: yield* ownerScope('installed-caller-authority') }, trace),
              snapshot,
            });
            // Asking every composed module, as before, then dropping the uninstalled ones (all installed ones are
            // active, which admits reads and writes) gives the same rights.
            const everything = yield* measured({
              authorityCase,
              correlationId: 'installed-caller-reference',
              read: callerAccessOneAtATime(yield* ownerScope('installed-caller-reference')),
              snapshot,
            });
            expect(sorted(caller.value.access)).toEqual(keptIn(installed, everything.value.access));
            expect(sorted(caller.value.propose)).toEqual(keptIn(installed, everything.value.propose));
            expect(sorted(caller.value.write)).toEqual(keptIn(installed, everything.value.write));
            const remaining = [...everything.decisionRowContents];
            for (const row of caller.decisionRowContents) {
              const at = remaining.indexOf(row);
              expect(at).toBeGreaterThanOrEqual(0);
              remaining.splice(at, 1);
            }
            // One exact proposal batch read's Action authority: every Action of the release (as it asked before) or
            // only the one its rows name (a work-tasks proposal), as an approval's five batch reads now ask it.
            const batchScope = yield* ownerScope('installed-batch-authority');
            const everyAction = yield* measured({
              authorityCase,
              correlationId: 'installed-batch-every-action',
              read: Effect.gen(function* everyActionAuthority() {
                const actionKeys = yield* queueReadActionKeys;
                return yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys, scope: batchScope });
              }),
              snapshot,
            });
            const oneAction = yield* measured({
              authorityCase,
              correlationId: 'installed-batch-one-action',
              read: Effect.gen(function* oneActionAuthority() {
                const actionKeys = firstTaskAction(yield* queueReadActionKeys);
                return yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys, scope: batchScope });
              }),
              snapshot,
            });
            const [taskAction] = oneAction.value;
            expect(oneAction.value).toEqual(
              everyAction.value.filter(({ actionKey }) => actionKey === taskAction?.actionKey),
            );
            expect(oneAction.counters.checkItems).toBeLessThan(everyAction.counters.checkItems);
            const path = yield* reportPath;
            if (Option.isSome(path)) {
              yield* (yield* FileSystem.FileSystem).writeFileString(
                `${path.value}.installed.json`,
                yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  after: reportOf(caller),
                  batchAuthorityEvery: reportOf(everyAction),
                  batchAuthorityOne: reportOf(oneAction),
                  everything: reportOf(everything),
                  trace: yield* Ref.get(trace),
                }),
              );
            }
            // Asking every composed module: 16 SpiceDB calls (14 of them one LIST each) and 478 evidence rows.
            expect(caller.counters.checkBulk).toBeLessThanOrEqual(CALLER_INSTALLED_BOUNDS.checkBulk);
            expect(caller.transactions).toBeLessThanOrEqual(CALLER_INSTALLED_BOUNDS.transactions);
            expect(caller.decisionRows).toBeLessThan(everything.decisionRows);
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      300_000,
    );
  },
);
