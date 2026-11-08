import type { OperationalScope } from '@app/core-runtime';
import { decodeAccessDeclarationOrThrow, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { ActionKeySchema } from '@app/core-runtime/access/approvals/frozen-command';
import type { FrozenCommandRecord } from '@app/core-runtime/access/approvals/frozen-command';
import type { GovernedAmountDescriptor } from '@app/core-runtime/access/approvals/governed-amount';
import { AccessApprovalsInbox } from '@app/core-runtime/access/approvals/inbox';
import type { AccessApprovalsInboxService } from '@app/core-runtime/access/approvals/inbox';
import { CatalogSnapshotEntrySchema } from '@app/core-runtime/access/changes/role-revision';
import { AccessChangesCommands } from '@app/core-runtime/access/changes/commands';
import type { AccessChangesCommandsService } from '@app/core-runtime/access/changes/commands';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  ProposalIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { AccessPeopleDirectory } from '@app/core-runtime/access/intent/people-directory';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessApprovalsCommands } from '../../api/access-admin/approvals-commands.ts';
import { ApprovalOwnerTransport } from '../../api/access-admin/approval-owner-transport.ts';
import type { AccessApprovalsCommandsService } from '../../api/access-admin/approvals-commands.ts';
import {
  AccessApprovalsLive,
  accessApprovalActionsLayer,
  approvalActionOf,
} from '../../api/access-admin/approvals-live.ts';

/*
 * The live Core seam of "Ke schválení", unit level: what the BFF is told about a frozen command. Its
 * governed amount comes from the owner Action registration when this process holds one, is "no amount"
 * only when the published declaration names none, and is otherwise unavailable — never a guess. The
 * preview names the Action, the capability, the digest and the target, and counts every payload field
 * as redacted. Core's inbox, release and directory are scripted ports here.
 */

const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const TENANT = uuid(1);
const SCOPE_ID = uuid(2);
const PROPOSAL = uuid(3);
const PAY = 'finance.invoice.pay';
const VOID = 'finance.invoice.void';
const DERIVED = 'finance.invoice.settle';

const scope: OperationalScope = {
  authBindingId: uuid(4),
  authContextRef: 'session-1',
  authMethod: 'session',
  correlationId: 'approvals-live',
  principalId: uuid(5),
  tenantId: TENANT,
};

const entrypointOf = (key: string) =>
  defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: key,
    moduleKey: 'finance',
    role: 'action',
  });

const ACTION_FACTS = {
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'finance', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const;

/** A published entry; an amount input is named only for a capability that governs one. */
const entryOf = (key: string, amountInput?: string) => {
  const base = { ...ACTION_FACTS, key, moduleKey: 'finance' };
  return Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)(
    amountInput === undefined ? base : { ...base, amountInput },
  );
};

const PayInvoice = Schema.Struct({ total: Schema.Struct({ currency: Schema.String, minor: Schema.Int }) });
const payInvoice: GovernedAmountDescriptor<typeof PayInvoice> = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    { ...ACTION_FACTS, amountInput: 'total', key: PAY },
    entrypointOf(PAY),
  ),
  actionKey: PAY,
  payloadSchema: PayInvoice,
};

const TOTAL = { currency: 'CZK', minor: 50_000 };
/** A payload with one field beyond the governed total, so the preview has two to redact. */
const NOTED_PAYLOAD = { note: 'urgent', total: TOTAL };

const frozenOf = (
  actionKey: string,
  capabilityKey: string,
  payload: Schema.Json = NOTED_PAYLOAD,
): FrozenCommandRecord => ({
  actionKey: ActionKeySchema.make(actionKey),
  command: {
    capabilityKey: CapabilityKeySchema.make(capabilityKey),
    payload,
    target: RecordKeySchema.make('invoice-7'),
  },
  commandDigest: CommandDigestSchema.make('ab'.repeat(32)),
  frozenAt: DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, 9))),
  proposalId: ProposalIdSchema.make(PROPOSAL),
  scopeId: AccessScopeIdSchema.make(SCOPE_ID),
  tenantId: TenantIdSchema.make(TENANT),
});

const unused = (name: string) => Effect.die(`${name} is not part of this suite`);

const inboxOver = (frozen: FrozenCommandRecord): AccessApprovalsInboxService => ({
  approvals: () => ({
    approve: () => unused('approve'),
    execute: () => unused('execute'),
    expireDue: () => unused('expireDue'),
    propose: () => unused('propose'),
    recheckAuthority: () => unused('recheckAuthority'),
    recordAuthorityLoss: () => unused('recordAuthorityLoss'),
    reject: () => unused('reject'),
    withdraw: () => unused('withdraw'),
  }),
  frozenCommand: () => Effect.succeed(Option.some(frozen)),
  isAdministrator: () => Effect.succeed(false),
  open: () => Effect.succeed([]),
  scopes: () => Effect.succeed([]),
});

const changes: AccessChangesCommandsService = {
  adopt: () => unused('adopt'),
  decline: () => unused('decline'),
  preview: () => unused('preview'),
  read: () => unused('read'),
  readRelease: () =>
    Effect.succeed(
      Option.some({
        catalogSnapshotId: uuid(6),
        digest: 'c'.repeat(64),
        entries: [entryOf(PAY, 'total'), entryOf(VOID), entryOf(DERIVED, 'derived.total')],
        publishedAt: DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 1))),
      }),
    ),
  roleNames: () => unused('roleNames'),
  undo: () => unused('undo'),
};

/** The live commands port over a scripted inbox holding one frozen command. */
const commandsFor = (frozen: FrozenCommandRecord) =>
  Layer.build(
    AccessApprovalsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ApprovalOwnerTransport, {
            approve: () => unused('owner approve'),
            inspect: () => unused('owner inspect'),
          }),
          accessApprovalActionsLayer([approvalActionOf(payInvoice)]),
          Layer.succeed(AccessApprovalsInbox, inboxOver(frozen)),
          Layer.succeed(AccessChangesCommands, changes),
          Layer.succeed(AccessPeopleDirectory, {
            people: () => Effect.succeed([]),
            scopeLabels: () => Effect.succeed({ companies: [] }),
          }),
        ),
      ),
    ),
  ).pipe(Effect.map((context): AccessApprovalsCommandsService => Context.get(context, AccessApprovalsCommands)));

const amountOf = (frozen: FrozenCommandRecord) =>
  Effect.scoped(
    commandsFor(frozen).pipe(
      Effect.flatMap((commands) => commands.governedAmount(scope, { proposalId: PROPOSAL, scopeId: SCOPE_ID })),
    ),
  );

it.effect('resolves the governed amount with the owner Action registration this process holds', () =>
  Effect.gen(function* registeredAmount() {
    const amount = yield* amountOf(frozenOf(PAY, PAY, { total: TOTAL }));
    expect(Option.getOrUndefined(amount)).toEqual({ currency: 'CZK', minor: 50_000 });
  }),
);

it.effect('answers "no amount" only when the published declaration governs none', () =>
  Effect.gen(function* noAmount() {
    expect(Option.isNone(yield* amountOf(frozenOf('finance.invoice.void-action', VOID)))).toBe(true);
  }),
);

it.effect('is unavailable, never "no amount", for an amount whose owner Action this process lacks', () =>
  Effect.gen(function* unregisteredAmount() {
    const failure = yield* Effect.flip(amountOf(frozenOf('finance.invoice.settle-action', DERIVED)));
    expect(failure.reason).toContain('is not registered here');
  }),
);

it.effect('previews the frozen command without a single payload field, counting each as redacted', () =>
  Effect.gen(function* redactedPreview() {
    const commands = yield* commandsFor(frozenOf(PAY, PAY));
    const preview = yield* commands.preview(scope, { proposalId: PROPOSAL, scopeId: SCOPE_ID });
    expect(Option.getOrUndefined(preview)).toEqual({
      actionKey: PAY,
      capabilityKey: PAY,
      digestShort: 'abababababab',
      fields: [],
      frozenAt: DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, 9))),
      redactedFieldCount: 2,
      target: { recordKey: 'invoice-7' },
    });
  }).pipe(Effect.scoped),
);
