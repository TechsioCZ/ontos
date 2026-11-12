import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Option, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ApprovalAuthorityUnavailableError, ApprovalStorageConflictError } from '../../src/access/approvals/errors.ts';
import {
  ActionApprovalLifecycleV2Ports,
  makeActionApprovalLifecycleV2,
} from '../../src/access/approvals/action-lifecycle-v2.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { freezeActionCommandV2, resolveActionCommandV2 } from '../../src/access/approvals/action-command-v2.ts';
import { proposeActionV2 } from '../../src/access/approvals/action-proposal-v2.ts';
import type { FrozenCommandRecord } from '../../src/access/approvals/frozen-command.ts';
import type { LiveApprovalServices } from '../../src/access/approvals/live-composition.ts';
import { prepareActionAuthorityV2 } from '../../src/access/approvals/prepared-action-authority-v2.ts';
import { verifyHumanPrincipal } from '../../src/access/approvals/principals.ts';
import type { ApprovalProposalRecords } from '../../src/access/approvals/service.ts';
import { projectPublishedCatalog } from '../../src/access/changes/publication.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import {
  AccessScopeIdSchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  CapabilityKeySchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import { requestTransactions } from '../../src/access/intent/persistence.ts';
import { makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import { refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import { makeAccessAuthorityCurrentness } from '../../src/access/enforcement/currentness.ts';
import { makeActionTestAccessFences } from '../../src/testing/action-access-fences.ts';
import type { ActionTestAccessFenceRow } from '../../src/testing/action-access-fences.ts';
import { actionFor, ownerKey, principal, readFor } from '../support/action-command-v2.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { makeTestDatabase } from '../support/database.ts';
import { at, cell, makeAuthority, makeCheck, scopeId as companyScopeId } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const now = at('2026-11-07T10:00:00Z');
const first = RecordKeySchema.make('first');
const second = RecordKeySchema.make('second');
const approverId = PrincipalIdSchema.make('00000000-0000-4000-8000-000000000009');
const tenantScopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000101');
const requesterScope = { ...principal, correlationId: 'inspection-requester' };
const approverScope = { ...requesterScope, principalId: approverId };
const normalize = (sql: string) => sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
const scopeSettings = Schema.Tuple([Schema.String, Schema.String]);
const missingAuthorities = ['action', 'field', 'read', 'readField', 'second'] as const;
type MissingAuthority = (typeof missingAuthorities)[number];
const keys = {
  action: `${ownerKey}.record.change`,
  field: `${ownerKey}.record.write-salary`,
  read: `${ownerKey}.record.read`,
  readField: `${ownerKey}.record.read-salary`,
};

const fixture = (missing?: MissingAuthority) =>
  Effect.gen(function* nativeInspectionFixture() {
    yield* TestClock.setTime(now.getTime());
    const read = readFor();
    const action = actionFor(read);
    const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey, reads: [read] });
    const { revision } = owner.composition;
    const command = yield* resolveActionCommandV2({
      payload: { ids: [first, second], salary: 25 },
      registration: action,
      scope: requesterScope,
    });
    const { governingRead } = command;
    if (governingRead === undefined) {
      return yield* Effect.die('The original fixture Action must declare its original governing Read');
    }
    const fenceRows: readonly ActionTestAccessFenceRow[] = [
      { revision: 3, scopeId: tenantScopeId, state: 'Ready', tenantId: principal.tenantId },
      {
        legalEntityId: LegalEntityIdSchema.make(principal.legalEntityId ?? ''),
        revision: 5,
        scopeId: companyScopeId,
        state: 'Ready',
        tenantId: principal.tenantId,
      },
    ];
    let fences = yield* makeActionTestAccessFences(fenceRows);
    const advancedFenceRows = fenceRows.map((row) => ({ ...row, revision: row.revision + 2 }));
    let tenantId = '';
    let legalEntityId = '';
    let saves = 0;
    let remoteCalls = 0;
    let unavailable = false;
    let stale = false;
    let fenceChanged = false;
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((sql, params) =>
      Effect.gen(function* executeOnlyInspectionInfrastructure() {
        const statement = normalize(sql);
        statements.push(statement);
        if (['begin', 'commit', 'rollback'].includes(statement)) {
          return [];
        }
        if (
          statement === "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)"
        ) {
          [tenantId, legalEntityId] = yield* Schema.decodeUnknownEffect(scopeSettings)(params).pipe(Effect.orDie);
          return [];
        }
        if (statement.startsWith('select current_user::text as role,')) {
          return [{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }];
        }
        if (statement === 'select transaction_timestamp() as operation_at') {
          return [{ operation_at: now }];
        }
        if (statement.startsWith("select current_setting('transaction_isolation') as isolation,")) {
          return [{ isolation: 'read committed' }];
        }
        if (statement.includes('from "core"."application_composition_authority"')) {
          if (fenceChanged) {
            fences = yield* makeActionTestAccessFences(advancedFenceRows).pipe(Effect.orDie);
          }
          return [{ phase: 'active', revision, subscriptionsJson: null, unexpired: !stale }];
        }
        const answer = fences.read({ params, scope: { legalEntityId, tenantId }, sql });
        return Option.isSome(answer) ? yield* answer.value : yield* Effect.die(`Unlisted inspection SQL: ${sql}`);
      }),
    );
    const holder = { _tag: 'Principal' as const, principalId: approverId };
    const spec: AuthoritySpec = {
      cells: [
        cell({ capability: keys.action, mode: 'propose', selector: { _tag: 'targets', recordKeys: [first, second] } }),
        cell({ capability: keys.field, mode: 'propose' }),
        ...Object.entries(keys).flatMap(([name, capability]) =>
          missing === name
            ? []
            : [
                cell({
                  capability,
                  holder,
                  mode: name === 'action' || name === 'field' ? 'approve' : 'run',
                  selector:
                    name === 'action' && missing === 'second'
                      ? { _tag: 'targets', recordKeys: [first] }
                      : { _tag: 'all' },
                }),
              ],
        ),
      ],
      legalEntityScope: {
        _tag: 'LegalEntity',
        legalEntityId: LegalEntityIdSchema.make(principal.legalEntityId ?? ''),
        tenantId: TenantIdSchema.make(principal.tenantId),
      },
      resolvedScopeId: companyScopeId,
    };
    const authority = makeAuthority(spec).port;
    const check = makeCheck({ authority: spec }).port;
    const ports = {
      candidates: { listCandidateIds: () => Effect.succeed([]) },
      check: {
        checkBulk: (items: Parameters<typeof check.checkBulk>[0]) =>
          Effect.gen(function* guardedRemoteAuthority() {
            yield* refuseInsideDatabaseTransaction('spicedb', 'inspection-proof');
            remoteCalls += 1;
            return yield* (unavailable ? makeCheck({ authority: spec, failure: true }).port : check).checkBulk(items);
          }),
      },
      decisionLog: { record: () => Effect.void },
      intent: { authorityFor: () => authority, joined: () => ({ authorityFor: () => authority }) },
      principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
    };
    const seam = makeAccessDecisionService({
      authorityFor: ports.intent.authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
    });
    const database = { enrollment: defineDatabaseIdentityEnrollment([]), executor };
    const gate = bindAccessGate(seam, { ...ports, currentness: makeAccessAuthorityCurrentness(database) });
    const requester = yield* prepareActionAuthorityV2({
      command,
      gate,
      now,
      phase: 'requester',
      scope: requesterScope,
    });
    const person = yield* Effect.fromResult(
      verifyHumanPrincipal({ principalId: PrincipalIdSchema.make(principal.principalId), principalKind: 'human' }),
    );
    const proposal = yield* proposeActionV2({
      capability: capabilityPolicyOf(command.declaration),
      command,
      now,
      proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000020'),
      requester: person,
      requesterAuthority: requester.proof,
      scopeId: companyScopeId,
      tenantId: command.scope.tenantId,
    });
    const frozen: FrozenCommandRecord = {
      actionKey: command.actionKey,
      command: { capabilityKey: CapabilityKeySchema.make(command.declaration.key), payload: command },
      commandDigest: Result.getOrThrow(freezeActionCommandV2(command)),
      proposalId: proposal.id,
      scopeId: companyScopeId,
      tenantId: command.scope.tenantId,
    };
    const records: ApprovalProposalRecords = {
      create: () => Effect.die('Inspection cannot create'),
      listOpen: () => Effect.succeed([proposal]),
      load: () => Effect.succeed(Option.some(proposal)),
      recordEnd: () => Effect.die('Inspection cannot lapse'),
      save: () =>
        Effect.sync(() => {
          saves += 1;
        }),
    };
    const catalog = Result.getOrThrow(
      projectPublishedCatalog([
        { declaration: command.declaration, moduleId: ownerKey, published: true },
        ...command.fieldGroups.map((declaration) => ({
          declaration,
          moduleId: ownerKey,
          parentKey: command.declaration.key,
          published: true,
        })),
        { declaration: governingRead.declaration, moduleId: ownerKey, published: true },
        ...governingRead.fieldGroups.map((declaration) => ({
          declaration,
          moduleId: ownerKey,
          parentKey: governingRead.declaration.key,
          published: true,
        })),
      ]),
    );
    const live: LiveApprovalServices = {
      crypto: yield* Crypto.Crypto,
      intent: makeTenantIntentLoader(database),
      join: () => live,
      loadRelease: () =>
        Effect.succeed(
          Option.some({
            digest: CatalogDigestSchema.make('a'.repeat(64)),
            entries: catalog.entries,
            id: CatalogSnapshotIdSchema.make('00000000-0000-4000-8000-000000000021'),
            publishedAt: now,
          }),
        ),
      records: { recordsFor: () => records },
      transactions: requestTransactions(database),
    };
    const lifecycle = yield* makeActionApprovalLifecycleV2().pipe(
      Effect.provideService(ActionApprovalLifecycleV2Ports, {
        database,
        enforcement: ports,
        frozenCommands: {
          append: () => Effect.die('Inspection cannot freeze'),
          appendInTransaction: () => Effect.die('Inspection cannot freeze'),
          load: () => Effect.succeed(Option.some(frozen)),
        },
        live,
        owners: [owner],
      }),
      Effect.provideService(AccessDecisionGate, seam),
    );
    return {
      changeFenceAtFinalRecheck: () => {
        fenceChanged = true;
      },
      input: {
        command: {
          approver: holder,
          approverKind: 'human' as const,
          policy: { selfApproval: 'forbidden' as const },
          proposalId: proposal.id,
          scopeId: companyScopeId,
          tenantId: command.scope.tenantId,
        },
        proposal,
        scope: approverScope,
      },
      lifecycle,
      remoteCalls: () => remoteCalls,
      saves: () => saves,
      setStale: () => {
        stale = true;
      },
      setUnavailable: () => {
        unavailable = true;
      },
      statements,
    };
  });

it.layer(NodeCrypto.layer)('native full-target approval inspection', (suite) => {
  suite.effect(
    'inspection prepares every APPROVE/write and independent Read RUN question without an approval or owner write',
    () =>
      Effect.gen(function* fullTargetInspection() {
        const test = yield* fixture();
        expect(yield* test.lifecycle.inspectApproval(test.input)).toBe(true);
        expect(test.remoteCalls()).toBeGreaterThan(4);
        expect(test.saves()).toBe(0);
        expect(test.statements.some((sql) => /^(?:insert|update|delete)\b/u.test(sql))).toBe(false);
        expect(yield* test.lifecycle.approve(test.input)).toHaveProperty('status', 'approved');
        expect(test.saves()).toBe(1);
      }),
  );

  suite.effect('inspection cannot publish eligibility after a prepared revision or immutable proposal changes', () =>
    Effect.gen(function* noStaleObservation() {
      const test = yield* fixture();
      test.changeFenceAtFinalRecheck();
      expect(
        Schema.is(ApprovalAuthorityUnavailableError)(
          yield* test.lifecycle.inspectApproval(test.input).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(test.saves()).toBe(0);
      const changed = yield* fixture();
      expect(
        Schema.is(ApprovalStorageConflictError)(
          yield* changed.lifecycle
            .inspectApproval({
              ...changed.input,
              proposal: { ...changed.input.proposal, expiresAt: at('2026-11-08T10:00:00Z') },
            })
            .pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(changed.saves()).toBe(0);
    }),
  );

  for (const missing of missingAuthorities) {
    suite.effect(`inspection cannot report eligibility without every ${missing} authority`, () =>
      Effect.gen(function* completeAuthorityRequired() {
        const test = yield* fixture(missing);
        expect(yield* test.lifecycle.inspectApproval(test.input)).toBe(false);
        expect(test.saves()).toBe(0);
      }),
    );
  }

  suite.effect(
    'inspection preserves typed unavailability and current release refusal without saving a virtual approval',
    () =>
      Effect.gen(function* currentReadOnlyInspection() {
        const test = yield* fixture();
        test.setUnavailable();
        expect(
          Schema.is(ApprovalAuthorityUnavailableError)(
            yield* test.lifecycle.inspectApproval(test.input).pipe(Effect.flip),
          ),
        ).toBe(true);
        expect(test.saves()).toBe(0);
        const stale = yield* fixture();
        stale.setStale();
        expect(
          Schema.is(ApprovalAuthorityUnavailableError)(
            yield* stale.lifecycle.inspectApproval(stale.input).pipe(Effect.flip),
          ),
        ).toBe(true);
        expect(stale.saves()).toBe(0);
      }),
  );
});
