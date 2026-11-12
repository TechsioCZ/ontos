import { Effect, Option, Result, Schema } from 'effect';

import {
  AccessActorSchema,
  AccessDeclarationSchema,
  AccessFieldGroupSchema,
} from '../../authorization/access-declaration.ts';
import type { AccessActor, AccessDeclaration, AccessFieldGroup } from '../../authorization/access-declaration.ts';
import type { DomainEventContractMap } from '../../actions/events.ts';
import type {
  ActionRegistration,
  AnyActionRegistration,
  RegisteredActionCommandReader,
} from '../../actions/definition.ts';
import {
  decodeActionPayload,
  getRegisteredActionCommandReader,
  RegisteredActionCommandPayloadSchema,
  isActionRegistration,
} from '../../actions/definition.ts';
import { getActionGoverningRead } from '../../actions/governing-read.ts';
import { ActionPermissionCheckError } from '../../actions/errors.ts';
import { computeCanonicalValueHash } from '../../actions/repository.ts';
import { resolveActionTargetSet } from '../../actions/target-set.ts';
import type { AccessRecordTarget } from '../decision/contract.ts';
import type { GateInput } from '../enforcement/contract.ts';
import { capabilityPolicyOf } from '../enforcement/capability.ts';
import {
  CapabilityKeySchema,
  CommandDigestSchema,
  CurrencyCodeSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../ids.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { LEGAL_ENTITY_SCOPES } from '../../operations/legal-entity-scope.ts';
import { freezeCommand } from './command.ts';
import { ActionKeySchema } from './frozen-command.ts';
import { CommandNotCanonicalError } from './errors.ts';
import { withOptional } from '../decision/optional.ts';

const VersionSchema = Schema.Literal('core.action/2');
const ReadKeySchema = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand('ActionGoverningReadKey'));
const VersionIdSchema = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand('ActionSchemaVersion'));
const TargetSchema = Schema.Struct({ moduleKey: ModuleKeySchema, recordKey: RecordKeySchema });
const ScopeSchema = Schema.Struct({
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  tenantId: TenantIdSchema,
});
const GoverningReadSchema = Schema.Struct({
  accessActor: Schema.optionalKey(AccessActorSchema),
  declaration: AccessDeclarationSchema,
  fieldGroups: Schema.Array(AccessFieldGroupSchema),
  readKey: ReadKeySchema,
  schemaVersion: VersionIdSchema,
});

/**
 * Forward Action document only. Historical FrozenCommand payloads remain immutable opaque JSON;
 * this decoder deliberately has no scalar-business-payload or legacy-witness interpretation.
 */
const ActionCommandV2Fields = Schema.Struct({
  accessActor: Schema.optionalKey(AccessActorSchema),
  actionKey: ActionKeySchema,
  amount: Schema.optionalKey(
    Schema.Struct({
      currency: CurrencyCodeSchema,
      minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  declaration: AccessDeclarationSchema,
  fieldGroups: Schema.Array(AccessFieldGroupSchema),
  format: VersionSchema,
  governingRead: Schema.optionalKey(GoverningReadSchema),
  legalEntityScope: Schema.Literals(LEGAL_ENTITY_SCOPES),
  owningModuleKey: ModuleKeySchema,
  payload: Schema.Json,
  schemaVersion: VersionIdSchema,
  scope: ScopeSchema,
  targetBinding: Schema.Literals(['record_set', 'single_record', 'scope']),
  targets: Schema.Array(TargetSchema),
  targetSetHash: CommandDigestSchema,
});
export type ActionCommandV2 = typeof ActionCommandV2Fields.Type;

export interface ActionCommandQuestionV2 {
  readonly accessActor?: AccessActor;
  readonly declaration: AccessDeclaration | AccessFieldGroup;
  readonly parent?: AccessDeclaration;
  readonly questionHash: string;
  readonly role: 'governing_read' | 'write';
  readonly target?: AccessRecordTarget;
}

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ActionPermissionCheckError({
      code: 'action_permission_check_failed',
      reason: 'The complete forward Action command could not be bound safely',
    }),
    'cause',
    { enumerable: false, value: cause },
  );

const scopeHash = (
  scope: { readonly legalEntityId?: string; readonly tenantId: string },
  targets: readonly AccessRecordTarget[],
) => computeCanonicalValueHash({ legalEntityId: scope.legalEntityId, targets, tenantId: scope.tenantId });

const commandTargetIssue = (command: ActionCommandV2): string | undefined => {
  const { owningModuleKey, scope, targets } = command;
  if (
    targets.some((target) => target.moduleKey !== owningModuleKey) ||
    new Set(targets.map((target) => target.recordKey)).size !== targets.length ||
    targets.some((target, index) => index > 0 && (targets[index - 1]?.recordKey ?? '') >= target.recordKey)
  ) {
    return 'The command needs the complete canonical owned record set';
  }
  if (command.targetSetHash !== scopeHash(scope, targets)) {
    return 'The record-set digest must bind the exact tenant, company and records';
  }
  return undefined;
};

const commandScopeIssue = (command: ActionCommandV2): string | undefined => {
  const { declaration, governingRead, scope, targets } = command;
  const recordScoped = declaration.selectors.length > 0;
  if (
    recordScoped !== targets.length > 0 ||
    (recordScoped && governingRead === undefined) ||
    (command.targetBinding === 'record_set' &&
      (targets.length === 0 || scope.legalEntityId === undefined || command.legalEntityScope !== 'required')) ||
    (command.targetBinding === 'single_record' && targets.length !== 1) ||
    (command.targetBinding === 'scope' && targets.length !== 0) ||
    (!recordScoped && governingRead !== undefined)
  ) {
    return 'Record commands require their real governing Read and complete target set in the declared scope';
  }
  if (
    !['action', 'admin'].includes(declaration.kind) ||
    (command.legalEntityScope === 'required' && scope.legalEntityId === undefined) ||
    (command.legalEntityScope === 'forbidden' && scope.legalEntityId !== undefined)
  ) {
    return 'The forward document must retain the actual Action capability and declared legal-entity scope';
  }
  return undefined;
};

const commandGroupIssue = (command: ActionCommandV2): string | undefined => {
  const { fieldGroups, governingRead } = command;
  if (
    fieldGroups.some((group) => group.kind !== 'field_write') ||
    new Set(fieldGroups.map((group) => group.key)).size !== fieldGroups.length
  ) {
    return 'Action commands contain only unique applicable field-write groups';
  }
  if (
    governingRead !== undefined &&
    (governingRead.declaration.kind !== 'read' ||
      governingRead.declaration.selectors.length === 0 ||
      !governingRead.declaration.modes.includes('run') ||
      governingRead.fieldGroups.some((group) => group.kind !== 'field_read') ||
      new Set(governingRead.fieldGroups.map((group) => group.key)).size !== governingRead.fieldGroups.length)
  ) {
    return 'The independent governing Read and every field-read restriction must remain intact';
  }
  return undefined;
};

const commandIssue = (command: ActionCommandV2): string | undefined =>
  commandTargetIssue(command) ?? commandScopeIssue(command) ?? commandGroupIssue(command);

export const ActionCommandV2Schema = ActionCommandV2Fields.check(Schema.makeFilter(commandIssue));

/** No fallback: a legacy scalar payload is not a forward Action document. */
export const decodeActionCommandV2 = <Value>(
  value: Value,
): Effect.Effect<ActionCommandV2, ActionPermissionCheckError> =>
  Schema.decodeUnknownEffect(ActionCommandV2Schema, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError(unavailable),
  );

const commandFromRegisteredFacts = Effect.fn('ActionCommand.fromRegisteredFactsV2')(
  function* commandFromRegisteredFacts(input: {
    readonly descriptor: RegisteredActionCommandReader['descriptor'];
    readonly facts: Effect.Success<ReturnType<RegisteredActionCommandReader['resolve']>>;
    readonly scope: OperationalScope;
  }) {
    const { descriptor, facts, scope } = input;
    const declaration = descriptor.accessDeclaration;
    if (declaration === undefined) {
      return yield* unavailable();
    }
    let targets: readonly AccessRecordTarget[] = [];
    let targetBinding: ActionCommandV2['targetBinding'] = 'scope';
    if (facts.targets !== undefined) {
      targetBinding = 'record_set';
      ({ targets } = yield* resolveActionTargetSet(
        facts.targets,
        scope,
        descriptor.owningModuleKey,
        (resolved) => resolved,
      ));
    } else if (facts.target !== undefined) {
      targetBinding = 'single_record';
      const target = yield* Schema.decodeUnknownEffect(TargetSchema)(facts.target).pipe(Effect.mapError(unavailable));
      targets = [target];
    }
    const read = getActionGoverningRead(descriptor.accessGoverningRead);
    const base = withOptional(
      withOptional(
        {
          actionKey: descriptor.actionKey,
          declaration,
          fieldGroups: facts.applicableFieldGroups,
          format: 'core.action/2',
          legalEntityScope: descriptor.legalEntityScope,
          owningModuleKey: descriptor.owningModuleKey,
          payload: facts.encodedPayload,
          schemaVersion: descriptor.schemaVersion,
          targetBinding,
          targets,
          targetSetHash: scopeHash(scope, targets),
        },
        'amount',
        Option.getOrUndefined(facts.amount),
      ),
      'accessActor',
      descriptor.accessActor,
    );
    // Scope is deliberately not spread into the document. It carries transport/actor facts which
    // are not the frozen business scope and must not become an unversioned JSON contract.
    const commandScope =
      scope.legalEntityId === undefined
        ? { tenantId: scope.tenantId }
        : { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId };
    const candidate =
      read === undefined
        ? { ...base, scope: commandScope }
        : {
            ...base,
            governingRead: withOptional(
              {
                declaration: read.descriptor.accessDeclaration,
                fieldGroups: read.descriptor.accessFieldGroups ?? [],
                readKey: read.descriptor.readKey,
                schemaVersion: read.descriptor.schemaVersion,
              },
              'accessActor',
              read.descriptor.accessActor,
            ),
            scope: commandScope,
          };
    return yield* decodeActionCommandV2(candidate);
  },
);

/**
 * Build from genuine registrations and decoded owner input. The caller must already have admitted
 * the exact Action and governing Read against the registered owner and composition catalog.
 */
export const resolveActionCommandV2 = Effect.fn('ActionCommand.makeV2')(function* resolveActionCommandV2<
  Payload extends Schema.ConstraintDecoder<unknown>,
  Result extends Schema.ConstraintDecoder<unknown>,
  DomainError extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  Events extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
>(input: {
  readonly payload: Payload['Type'];
  readonly registration: ActionRegistration<Payload, Result, DomainError, Events, Owner, Services, Requirements>;
  readonly scope: OperationalScope;
}) {
  const { registration, scope } = input;
  const reader = getRegisteredActionCommandReader(registration);
  if (!isActionRegistration(registration) || reader === undefined) {
    return yield* unavailable();
  }
  const encoded = yield* Schema.encodeUnknownEffect(
    Schema.make<Schema.ConstraintEncoder<unknown>>(registration.descriptor.payloadSchema.ast),
  )(input.payload).pipe(
    Effect.flatMap((encodedValue) =>
      Schema.decodeUnknownEffect(RegisteredActionCommandPayloadSchema)({ payload: encodedValue }),
    ),
    Effect.mapError(unavailable),
  );
  const facts = yield* reader.resolve(encoded.payload, scope).pipe(Effect.mapError(unavailable));
  return yield* commandFromRegisteredFacts({ descriptor: reader.descriptor, facts, scope });
});

/** Rebind the exact original registered command without exposing or invoking an owner executable. */
export const rebindRegisteredActionCommandV2 = Effect.fn('ActionCommand.rebindRegisteredV2')(
  function* rebindRegisteredActionCommandV2(input: {
    readonly command: ActionCommandV2;
    readonly registration: AnyActionRegistration;
    readonly scope: OperationalScope;
  }) {
    const { command, registration, scope } = input;
    const reader = getRegisteredActionCommandReader(registration);
    if (!isActionRegistration(registration) || reader === undefined) {
      return yield* unavailable();
    }
    const facts = yield* reader.resolve(command.payload, scope).pipe(Effect.mapError(unavailable));
    const current = yield* commandFromRegisteredFacts({ descriptor: reader.descriptor, facts, scope });
    if (computeCanonicalValueHash(current) !== computeCanonicalValueHash(command)) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

/** Every record/question is independent. No witness or selector from one question admits another. */
export const actionCommandQuestionsV2 = (command: ActionCommandV2): readonly ActionCommandQuestionV2[] => {
  const questions: ActionCommandQuestionV2[] = [];
  const targets: readonly (AccessRecordTarget | undefined)[] =
    command.targets.length === 0 ? [undefined] : command.targets;
  const add = (
    declaration: AccessDeclaration | AccessFieldGroup,
    role: 'governing_read' | 'write',
    target: AccessRecordTarget | undefined,
    parent?: AccessDeclaration,
  ) => {
    const accessActor = role === 'write' ? command.accessActor : command.governingRead?.accessActor;
    const question = withOptional(
      withOptional(withOptional({ declaration, role }, 'target', target), 'parent', parent),
      'accessActor',
      accessActor,
    );
    questions.push(
      Object.freeze({
        ...question,
        questionHash: computeCanonicalValueHash({ ...question, amount: command.amount, scope: command.scope }),
      }),
    );
  };
  for (const target of targets) {
    add(command.declaration, 'write', target);
    for (const field of command.fieldGroups) {
      add(field, 'write', target, command.declaration);
    }
    const read = command.governingRead;
    if (read !== undefined) {
      add(read.declaration, 'governing_read', target);
      for (const field of read.fieldGroups) {
        add(field, 'governing_read', target, read.declaration);
      }
    }
  }
  return Object.freeze(questions);
};

/** Existing durable outer command and digest APIs remain unchanged; the version is inside payload. */
export const freezeActionCommandV2 = (command: ActionCommandV2) =>
  Schema.decodeUnknownResult(ActionCommandV2Schema, { onExcessProperty: 'error' })(command).pipe(
    Result.mapError(
      () =>
        new CommandNotCanonicalError({
          code: 'command_not_canonical',
          reason: 'Only a complete forward Action command can be frozen',
        }),
    ),
    Result.flatMap((decoded) =>
      freezeCommand({ capabilityKey: CapabilityKeySchema.make(decoded.declaration.key), payload: decoded }),
    ),
  );

/**
 * The single canonical gate still evaluates every question. An approval never asks for Action RUN;
 * independent record/field reads stay RUN, including their own parent Read.
 */
export const actionCommandGateQuestionV2 = (
  command: ActionCommandV2,
  question: ActionCommandQuestionV2,
  phase: 'requester' | 'approver',
  scope: OperationalScope,
  now: Date,
): Effect.Effect<GateInput, ActionPermissionCheckError> => {
  const current = actionCommandQuestionsV2(command).find((entry) => entry.questionHash === question.questionHash);
  if (
    current === undefined ||
    computeCanonicalValueHash(current) !== computeCanonicalValueHash(question) ||
    scope.tenantId !== command.scope.tenantId ||
    scope.legalEntityId !== command.scope.legalEntityId ||
    (phase === 'requester' && question.role !== 'write')
  ) {
    return Effect.fail(unavailable());
  }
  let mode: GateInput['mode'] = 'run';
  if (question.role === 'write') {
    mode = phase === 'requester' ? 'propose' : 'approve';
  }
  const parentRead =
    question.parent === undefined
      ? undefined
      : withOptional(
          withOptional({ capability: capabilityPolicyOf(question.parent) }, 'target', question.target),
          'amount',
          question.role === 'write' ? command.amount : undefined,
        );
  const base = {
    carrier: withOptional({ accessDeclaration: question.declaration }, 'accessActor', question.accessActor),
    legalEntityScope: command.legalEntityScope,
    mode,
    now,
    scope,
  };
  return Effect.succeed(
    withOptional(
      withOptional(
        withOptional(base, 'target', question.target),
        'amount',
        question.role === 'write' ? command.amount : undefined,
      ),
      'parentRead',
      parentRead,
    ),
  );
};

/** Re-resolve payload, full target set, amount and Read identity under the current genuine registration. */
export const rebindActionCommandV2 = Effect.fn('ActionCommand.rebindV2')(function* rebindActionCommandV2<
  Payload extends Schema.ConstraintDecoder<unknown>,
  Result extends Schema.ConstraintDecoder<unknown>,
  DomainError extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  Events extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
>(
  registration: ActionRegistration<Payload, Result, DomainError, Events, Owner, Services, Requirements>,
  command: ActionCommandV2,
  scope: OperationalScope,
) {
  const decoded = yield* decodeActionPayload(registration.descriptor.payloadSchema, command.payload).pipe(
    Effect.mapError(unavailable),
  );
  const current = yield* resolveActionCommandV2({ payload: decoded, registration, scope });
  if (computeCanonicalValueHash(current) !== computeCanonicalValueHash(command)) {
    return yield* unavailable();
  }
  return decoded;
});
