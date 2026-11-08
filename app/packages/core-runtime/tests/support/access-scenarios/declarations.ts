import { Effect, Schema } from 'effect';

import type {
  AccessCatalogModule,
  AccessDeclarationInput,
  AccessFieldGroupInput,
  AccessWorkloadInput,
} from '../../../src/authorization/access-declaration.ts';
import { decodeAccessDeclarationOrThrow } from '../../../src/authorization/access-declaration.ts';
import { defineAction } from '../../../src/actions/definition.ts';
import { defineRead } from '../../../src/reads/definition.ts';
import { defineTenantModuleEntrypoint } from '../../../src/modules/module-entrypoint.ts';
import type { ListAccessPredicate, ListRowProjection } from '../../../src/access/decision/list-access.ts';
import { evaluateListAccessPredicate } from '../../../src/access/decision/list-access.ts';
import { PrincipalIdSchema, RecordKeySchema } from '../../../src/access/ids.ts';
import { withOptional } from '../../../src/access/decision/optional.ts';

/*
 * The test-only entrypoints of the cutover scenario suite (C20). Each one is a real `defineAction` /
 * `defineRead` carrier with a real `accessDeclaration`, so the suite exercises the same descriptor
 * shape a vertical ships — the gate reads the declaration the descriptor was validated with, and the
 * Action/Read runtimes decide exactly as they do in a vertical. Nothing here depends on a vertical
 * that is still in flux.
 */

export const SCENARIO_MODULE = 'test.scenarios';

/** The module a later release adds a capability to (S1: not usable until adopted). */
export const RELEASE_MODULE = 'test.ledger';

export const routineReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.api.invoice-list',
  moduleKey: SCENARIO_MODULE,
  role: 'api',
});
export const recordListEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.api.record-list',
  moduleKey: SCENARIO_MODULE,
  role: 'api',
});
export const recordDetailEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.api.record-detail',
  moduleKey: SCENARIO_MODULE,
  role: 'api',
});
export const workloadReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.api.binding-status',
  moduleKey: SCENARIO_MODULE,
  role: 'api',
});
export const dualReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.api.binding-view',
  moduleKey: SCENARIO_MODULE,
  role: 'api',
});
export const releaseReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.ledger.api.statement-list',
  moduleKey: RELEASE_MODULE,
  role: 'api',
});
export const releaseExportEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.ledger.api.export-run',
  moduleKey: RELEASE_MODULE,
  role: 'api',
});
export const routineActionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.action.invoice-change',
  moduleKey: SCENARIO_MODULE,
  role: 'action',
});
export const amountActionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.action.invoice-pay',
  moduleKey: SCENARIO_MODULE,
  role: 'action',
});
export const workloadActionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.action.binding-reserve',
  moduleKey: SCENARIO_MODULE,
  role: 'action',
});
export const dualActionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.action.binding-sync',
  moduleKey: SCENARIO_MODULE,
  role: 'action',
});
export const reductionActionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.action.credential-revoke',
  moduleKey: SCENARIO_MODULE,
  role: 'action',
});
export const ownerFactsActionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.action.counterparty-touch',
  moduleKey: SCENARIO_MODULE,
  role: 'action',
});
/** A scope-wide detail read that governs one of its result fields (O74). */
export const fieldReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.api.field-detail',
  moduleKey: SCENARIO_MODULE,
  role: 'api',
});
/** A record-scoped detail read that governs one of its result fields: the O74 control (D14). */
export const recordFieldReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.api.record-field-detail',
  moduleKey: SCENARIO_MODULE,
  role: 'api',
});
/** A scope-wide Action that governs one of its payload fields (O74). */
export const fieldActionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.scenarios.action.field-change',
  moduleKey: SCENARIO_MODULE,
  role: 'action',
});

const declaration = (input: {
  readonly amountInput?: string;
  readonly key: string;
  readonly kind: AccessDeclarationInput['kind'];
  readonly modes: AccessDeclarationInput['modes'];
  readonly risk: AccessDeclarationInput['risk'];
  readonly selectors: AccessDeclarationInput['selectors'];
}): AccessDeclarationInput => {
  const base = {
    key: input.key,
    kind: input.kind,
    modes: input.modes,
    placement: { group: 'scenarios', level: 'basic' as const },
    risk: input.risk,
    selectors: input.selectors,
  };
  return input.amountInput === undefined ? base : { ...base, amountInput: input.amountInput };
};

export const ROUTINE_READ = 'test.scenarios.invoice.read';
export const RECORD_LIST = 'test.scenarios.record.list';
export const RECORD_DETAIL = 'test.scenarios.record.detail';
export const DUAL_READ = 'test.scenarios.binding.view';
export const ROUTINE_ACTION = 'test.scenarios.invoice.change';
export const AMOUNT_ACTION = 'test.scenarios.invoice.charge';
export const WORKLOAD_ACTION = 'test.scenarios.binding.reserve';
export const DUAL_ACTION = 'test.scenarios.binding.sync';
export const REDUCTION_ACTION = 'test.scenarios.credential.revoke';
export const OWNER_FACTS_ACTION = 'test.scenarios.counterparty.touch';
export const LEDGER_READ = 'test.ledger.statement.read';
export const LEDGER_EXPORT = 'test.ledger.export.run';
export const FIELD_READ = 'test.scenarios.field.read';
export const RECORD_FIELD_READ = 'test.scenarios.record.field-read';
export const FIELD_ACTION = 'test.scenarios.field.change';
/** The result path a read's field group governs; a caller without the group never receives it (O17). */
export const FIELD_READ_GROUP = 'test.scenarios.field.read-salaries';
/** The same salaries on a record-scoped read: a field group belongs to exactly one parent (O58). */
export const FIELD_RECORD_READ_GROUP = 'test.scenarios.record.field-read-salaries';
/** The payload path an Action's field group governs; a caller without the group may not write it (O58). */
export const FIELD_WRITE_GROUP = 'test.scenarios.field.write-purchase-price';

export const routineReadDeclaration = declaration({
  key: ROUTINE_READ,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const recordListDeclaration = declaration({
  key: RECORD_LIST,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: ['assigned'],
});
export const recordDetailDeclaration = declaration({
  key: RECORD_DETAIL,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: ['all'],
});
export const dualReadDeclaration = declaration({
  key: DUAL_READ,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const routineActionDeclaration = declaration({
  key: ROUTINE_ACTION,
  kind: 'action',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const amountActionDeclaration = declaration({
  key: AMOUNT_ACTION,
  kind: 'action',
  // Routine and run-only: an amount ceiling blocks the run cell outright, with no proposal path to
  // turn the refusal into NEEDS_APPROVAL (O18, O42).
  amountInput: 'derived.total',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const dualActionDeclaration = declaration({
  key: DUAL_ACTION,
  kind: 'action',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const reductionActionDeclaration = declaration({
  key: REDUCTION_ACTION,
  kind: 'action',
  // 'revoke' is a dangerous verb (D29), so it is at least sensitive; the reducer payload still runs
  // without a grant, and every other payload of the same Action needs one (O35, O71).
  modes: ['run', 'propose'],
  risk: 'sensitive',
  selectors: [],
});
export const ownerFactsActionDeclaration = declaration({
  key: OWNER_FACTS_ACTION,
  kind: 'action',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const fieldReadDeclaration = declaration({
  key: FIELD_READ,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const recordFieldReadDeclaration = declaration({
  key: RECORD_FIELD_READ,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: ['all'],
});
export const fieldActionDeclaration = declaration({
  key: FIELD_ACTION,
  kind: 'action',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
/** The salaries a governed read projects; the group below is what decides whether it reaches a caller. */
export const fieldReadSalariesGroup: AccessFieldGroupInput = {
  fieldClass: 'salaries',
  fields: ['salaries'],
  key: FIELD_READ_GROUP,
  kind: 'field_read',
  modes: ['run'],
  placement: { group: 'scenarios', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
};
/** The salaries of the record-scoped read: the same class, its own key and parent (O58, O74). */
export const recordFieldReadSalariesGroup: AccessFieldGroupInput = {
  fieldClass: 'salaries',
  fields: ['salaries'],
  key: FIELD_RECORD_READ_GROUP,
  kind: 'field_read',
  modes: ['run'],
  placement: { group: 'scenarios', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
};
/** The purchase price a governed Action writes; a caller without this group may not send it (O74). */
export const fieldWritePurchasePriceGroup: AccessFieldGroupInput = {
  fieldClass: 'purchase_prices',
  fields: ['derived.purchasePrice'],
  key: FIELD_WRITE_GROUP,
  kind: 'field_write',
  modes: ['run'],
  placement: { group: 'scenarios', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
};
export const ledgerReadDeclaration = declaration({
  key: LEDGER_READ,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
});
export const ledgerExportDeclaration = declaration({
  key: LEDGER_EXPORT,
  kind: 'export',
  modes: ['run'],
  risk: 'sensitive',
  selectors: [],
});

const WORKLOAD_REASON = 'Only a trusted machine workload may run this scenario capability';
/** The one registered workload the scenario suite binds for its workload carriers (O73). */
export const SCENARIO_WORKLOAD = 'test.machine-provisioner';

const workloadMarker = (): AccessWorkloadInput => ({ reason: WORKLOAD_REASON, workloads: [SCENARIO_WORKLOAD] });

export const workloadReadMarker: AccessWorkloadInput = workloadMarker();
export const dualReadMarker: AccessWorkloadInput = workloadMarker();
export const workloadActionMarker: AccessWorkloadInput = workloadMarker();
export const dualActionMarker: AccessWorkloadInput = workloadMarker();

/** The decoded carriers the suite hands the gate directly, beside the runtimes that own their own. */
export const routineReadCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(routineReadDeclaration, routineReadEntrypoint),
};
/** The record-scoped field read asked directly of the gate: it names the one record it is decided with. */
export const recordFieldReadCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(recordFieldReadDeclaration, recordFieldReadEntrypoint),
};
export const ledgerExportCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(ledgerExportDeclaration, releaseExportEntrypoint),
};

/**
 * The catalog a bootstrap releases: the modules and their declared capabilities (O69). Workload-only
 * carriers are deliberately absent — they are never configurable and never granted to a human (O59).
 */
export const scenarioModules = (extra: readonly AccessCatalogModule[] = []): readonly AccessCatalogModule[] => [
  {
    descriptors: [
      { accessDeclaration: routineReadDeclaration, entrypoint: routineReadEntrypoint },
      { accessDeclaration: recordListDeclaration, entrypoint: recordListEntrypoint },
      { accessDeclaration: recordDetailDeclaration, entrypoint: recordDetailEntrypoint },
      { accessDeclaration: dualReadDeclaration, entrypoint: dualReadEntrypoint },
      { accessDeclaration: routineActionDeclaration, entrypoint: routineActionEntrypoint },
      { accessDeclaration: amountActionDeclaration, entrypoint: amountActionEntrypoint },
      { accessDeclaration: dualActionDeclaration, entrypoint: dualActionEntrypoint },
      { accessDeclaration: reductionActionDeclaration, entrypoint: reductionActionEntrypoint },
      { accessDeclaration: ownerFactsActionDeclaration, entrypoint: ownerFactsActionEntrypoint },
      {
        accessDeclaration: fieldReadDeclaration,
        accessFieldGroups: [fieldReadSalariesGroup],
        entrypoint: fieldReadEntrypoint,
      },
      {
        accessDeclaration: recordFieldReadDeclaration,
        accessFieldGroups: [recordFieldReadSalariesGroup],
        entrypoint: recordFieldReadEntrypoint,
      },
      {
        accessDeclaration: fieldActionDeclaration,
        accessFieldGroups: [fieldWritePurchasePriceGroup],
        entrypoint: fieldActionEntrypoint,
      },
    ],
    moduleId: SCENARIO_MODULE,
  },
  ...extra,
];

/** The release-1 module set: the ledger's read, without the export a later release adds. */
export const ledgerModulesWithoutExport: readonly AccessCatalogModule[] = [
  {
    descriptors: [{ accessDeclaration: ledgerReadDeclaration, entrypoint: releaseReadEntrypoint }],
    moduleId: RELEASE_MODULE,
  },
];

/** The release-2 module set: the ledger's read and the export it adds (S1). */
export const ledgerModulesWithExport: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: ledgerReadDeclaration, entrypoint: releaseReadEntrypoint },
      { accessDeclaration: ledgerExportDeclaration, entrypoint: releaseExportEntrypoint },
    ],
    moduleId: RELEASE_MODULE,
  },
];

/** The owner-local counterparty a scenario's owner rule is about (O70); not a Core identifier. */
const CounterpartyIdSchema = Schema.String.pipe(Schema.brand('CounterpartyId'));

const scenarioAction = <PayloadSchema extends Schema.ConstraintDecoder<unknown>>(input: {
  readonly accessAmount?: (payload: PayloadSchema['Type']) => {
    readonly currency: string;
    readonly minor: number;
  };
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  readonly accessOwnerFacts?: (payload: PayloadSchema['Type']) => Readonly<Record<string, string>>;
  readonly accessReducesAuthority?: (payload: PayloadSchema['Type']) => boolean;
  readonly actionKey: string;
  readonly carrier:
    | { readonly accessDeclaration: AccessDeclarationInput }
    | { readonly accessDeclaration: AccessDeclarationInput; readonly accessWorkload: AccessWorkloadInput }
    | { readonly accessWorkload: AccessWorkloadInput };
  readonly entrypoint: typeof routineActionEntrypoint;
  readonly payloadSchema: PayloadSchema;
}) =>
  defineAction(
    {
      ...input.carrier,
      ...withOptional(
        withOptional(
          withOptional(
            withOptional({}, 'accessAmount', input.accessAmount),
            'accessOwnerFacts',
            input.accessOwnerFacts,
          ),
          'accessReducesAuthority',
          input.accessReducesAuthority,
        ),
        'accessFieldGroups',
        input.accessFieldGroups,
      ),
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${input.actionKey}.v1` },
      actionKey: input.actionKey,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: input.entrypoint,
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: SCENARIO_MODULE,
      payloadSchema: input.payloadSchema,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
    () => Effect.succeed({}),
  );

export const routineActionRegistration = scenarioAction({
  actionKey: ROUTINE_ACTION,
  carrier: { accessDeclaration: routineActionDeclaration },
  entrypoint: routineActionEntrypoint,
  payloadSchema: Schema.Struct({ value: Schema.String }),
});
export const amountActionRegistration = scenarioAction({
  accessAmount: (payload) => ({ currency: 'CZK', minor: payload.totalMinor }),
  actionKey: AMOUNT_ACTION,
  carrier: { accessDeclaration: amountActionDeclaration },
  entrypoint: amountActionEntrypoint,
  payloadSchema: Schema.Struct({ totalMinor: Schema.Int }),
});
export const workloadActionRegistration = scenarioAction({
  actionKey: WORKLOAD_ACTION,
  carrier: { accessWorkload: workloadActionMarker },
  entrypoint: workloadActionEntrypoint,
  payloadSchema: Schema.Struct({ value: Schema.String }),
});
export const dualActionRegistration = scenarioAction({
  actionKey: DUAL_ACTION,
  carrier: { accessDeclaration: dualActionDeclaration, accessWorkload: dualActionMarker },
  entrypoint: dualActionEntrypoint,
  payloadSchema: Schema.Struct({ value: Schema.String }),
});
export const reductionActionRegistration = scenarioAction({
  accessReducesAuthority: (payload) => payload.reduce,
  actionKey: REDUCTION_ACTION,
  carrier: { accessDeclaration: reductionActionDeclaration },
  entrypoint: reductionActionEntrypoint,
  payloadSchema: Schema.Struct({ reduce: Schema.Boolean }),
});
export const ownerFactsActionRegistration = scenarioAction({
  accessOwnerFacts: (payload) => ({ counterpartyId: payload.counterpartyId }),
  actionKey: OWNER_FACTS_ACTION,
  carrier: { accessDeclaration: ownerFactsActionDeclaration },
  entrypoint: ownerFactsActionEntrypoint,
  payloadSchema: Schema.Struct({ counterpartyId: CounterpartyIdSchema }),
});

/** The rows one list scenario exposes, exactly the owner projection the list predicate reads (O25). */
export interface ScenarioRecordRow extends ListRowProjection {
  readonly label: string;
}

const recordReadCommon = {
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: 'test.scenarios.record.read.v1' },
  legalEntityScope: 'forbidden' as const,
  owningModuleKey: SCENARIO_MODULE,
  permissionTarget: 'module' as const,
  policies: [],
  schemaVersion: '1',
};

export const recordListRegistration = defineRead(
  {
    ...recordReadCommon,
    accessDeclaration: recordListDeclaration,
    accessKind: 'list',
    entrypoint: recordListEntrypoint,
    inputSchema: Schema.Struct({
      rows: Schema.Array(
        Schema.Struct({
          assignedPrincipalId: Schema.optionalKey(PrincipalIdSchema),
          recordKey: RecordKeySchema,
        }),
      ),
    }),
    readKey: 'test.scenarios.record-list',
    resultSchema: Schema.Array(Schema.String),
  },
  (input, context) =>
    Effect.sync(() => {
      const predicate: ListAccessPredicate | undefined = context.listAccess;
      const rows = input.rows.map((row): ScenarioRecordRow => {
        const base = {
          label: row.recordKey,
          recordKey: row.recordKey,
          teamIds: [],
        } satisfies ScenarioRecordRow;
        return row.assignedPrincipalId === undefined
          ? base
          : { ...base, assigned: { _tag: 'Principal', principalId: row.assignedPrincipalId } };
      });
      const visible = predicate === undefined ? [] : rows.filter((row) => evaluateListAccessPredicate(predicate, row));
      return { evidence: { resultCount: visible.length }, result: visible.map(({ recordKey }) => recordKey) };
    }),
  () => Effect.succeed({}),
  () => ({ kind: 'module' as const, moduleId: SCENARIO_MODULE }),
);

export const recordDetailRegistration = defineRead(
  {
    ...recordReadCommon,
    accessDeclaration: recordDetailDeclaration,
    accessKind: 'detail',
    accessTarget: (input) => ({ moduleKey: SCENARIO_MODULE, recordKey: input.recordKey }),
    entrypoint: recordDetailEntrypoint,
    inputSchema: Schema.Struct({ recordKey: RecordKeySchema }),
    readKey: 'test.scenarios.record-detail',
    resultSchema: Schema.Struct({ recordKey: RecordKeySchema }),
  },
  (input) => Effect.succeed({ evidence: { resultCount: 1 }, result: { recordKey: input.recordKey } }),
  () => Effect.succeed({}),
  () => ({ kind: 'module' as const, moduleId: SCENARIO_MODULE }),
  undefined,
  [],
);

const workloadReadCommon = {
  ...recordReadCommon,
  accessKind: 'detail' as const,
  inputSchema: Schema.Struct({}),
  resultSchema: Schema.Struct({ status: Schema.String }),
};

export const workloadReadRegistration = defineRead(
  {
    ...workloadReadCommon,
    accessWorkload: workloadReadMarker,
    entrypoint: workloadReadEntrypoint,
    readKey: 'test.scenarios.workload-read',
  },
  () => Effect.succeed({ evidence: { resultCount: 1 }, result: { status: 'workload' } }),
  () => Effect.succeed({}),
  () => ({ kind: 'module' as const, moduleId: SCENARIO_MODULE }),
  undefined,
  [],
);

export const routineReadRegistration = defineRead(
  {
    ...workloadReadCommon,
    accessDeclaration: routineReadDeclaration,
    entrypoint: routineReadEntrypoint,
    readKey: 'test.scenarios.routine-read',
  },
  () => Effect.succeed({ evidence: { resultCount: 1 }, result: { status: 'routine' } }),
  () => Effect.succeed({}),
  () => ({ kind: 'module' as const, moduleId: SCENARIO_MODULE }),
  undefined,
  [],
);

export const dualReadRegistration = defineRead(
  {
    ...workloadReadCommon,
    accessDeclaration: dualReadDeclaration,
    accessWorkload: dualReadMarker,
    entrypoint: dualReadEntrypoint,
    readKey: 'test.scenarios.dual-read',
  },
  () => Effect.succeed({ evidence: { resultCount: 1 }, result: { status: 'dual' } }),
  () => Effect.succeed({}),
  () => ({ kind: 'module' as const, moduleId: SCENARIO_MODULE }),
  undefined,
  [],
);

/** The result a field-governed read answers whole; the governed salaries reach only a granted caller. */
const FieldReadSalariesSchema = Schema.Struct({ amount: Schema.Int, currencyCode: Schema.String });

const fieldReadCommon = {
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: 'test.scenarios.field.read.v1' },
  legalEntityScope: 'forbidden' as const,
  owningModuleKey: SCENARIO_MODULE,
  policies: [],
  schemaVersion: '1',
};

/** A scope-wide detail read whose salaries field group is the whole point (O74). */
export const fieldReadRegistration = defineRead(
  {
    ...fieldReadCommon,
    accessDeclaration: fieldReadDeclaration,
    accessFieldGroups: [fieldReadSalariesGroup],
    accessKind: 'detail',
    entrypoint: fieldReadEntrypoint,
    inputSchema: Schema.Struct({}),
    readKey: 'test.scenarios.field-read',
    resultSchema: Schema.Struct({ salaries: Schema.optionalKey(FieldReadSalariesSchema), status: Schema.String }),
  },
  () =>
    Effect.succeed({
      evidence: { resultCount: 1 },
      result: { salaries: { amount: 5000, currencyCode: 'CZK' }, status: 'field' },
    }),
  () => Effect.succeed({}),
);

/** The same field group on a record-scoped read: the parent read stays the record (O74 control). */
export const recordFieldReadRegistration = defineRead(
  {
    ...fieldReadCommon,
    accessDeclaration: recordFieldReadDeclaration,
    accessFieldGroups: [recordFieldReadSalariesGroup],
    accessKind: 'detail',
    accessTarget: (input) => ({ moduleKey: SCENARIO_MODULE, recordKey: input.recordKey }),
    entrypoint: recordFieldReadEntrypoint,
    inputSchema: Schema.Struct({ recordKey: RecordKeySchema }),
    readKey: 'test.scenarios.record-field-read',
    resultSchema: Schema.Struct({ recordKey: RecordKeySchema, salaries: Schema.optionalKey(FieldReadSalariesSchema) }),
  },
  (input) =>
    Effect.succeed({
      evidence: { resultCount: 1 },
      result: { recordKey: input.recordKey, salaries: { amount: 5000, currencyCode: 'CZK' } },
    }),
  () => Effect.succeed({}),
);

/** A scope-wide Action whose purchase price is a governed write field (O74, R5a-3). */
export const fieldActionRegistration = scenarioAction({
  accessFieldGroups: [fieldWritePurchasePriceGroup],
  actionKey: FIELD_ACTION,
  carrier: { accessDeclaration: fieldActionDeclaration },
  entrypoint: fieldActionEntrypoint,
  payloadSchema: Schema.Struct({
    derived: Schema.optionalKey(
      Schema.Struct({
        purchasePrice: Schema.optionalKey(Schema.Struct({ currency: Schema.String, minor: Schema.Int })),
      }),
    ),
    value: Schema.String,
  }),
});
