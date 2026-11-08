import type {
  AccessDeclaration,
  AccessDeclarationInput,
  AccessDeclarationOwner,
  OperationalScope,
} from '@app/core-runtime';
import { decodeAccessDeclaration, declaredAccessCarrier, defineSystemModuleEntrypoint } from '@app/core-runtime';
import { AccessChangesCommands } from '@app/core-runtime/access/changes/commands';
import type { AccessChangesCommandsService, AccessChangesView } from '@app/core-runtime/access/changes/commands';
import { explainAccess } from '@app/core-runtime/access/decision/explain';
import type { AccessAmount, AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate, capabilityPolicyOf } from '@app/core-runtime/access/enforcement';
import type { LegalEntityId, RoleId } from '@app/core-runtime/access/ids';
import { ModuleKeySchema, PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { AccessMembershipStore } from '@app/core-runtime/access/intent/memberships';
import type { AccessMembership } from '@app/core-runtime/access/intent/memberships';
import { HttpApiBuilder, HttpEffect, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer, Option, Predicate, Result, Schema } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { AccessAdminProblem, ExplainAccessPayload, ExplainAccessResponse } from '../../shared/access-admin-api.ts';
import {
  AccessCapabilityKeySchema,
  AccessDecisionReasonCodeSchema,
  AccessHumanIdSchema,
  AccessRoleIdSchema,
} from '../../shared/access-admin-api.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import {
  AccessAdminSession,
  accessAdminForbiddenProblem,
  accessAdminUnprocessableProblem,
  accessAdminUnavailableProblem,
} from './session.ts';

/*
 * "Proč?" — the explanation surface of authorization v2 (P7).
 *
 * The screen answers exactly one question: *why* is this action, read or export allowed, denied or
 * waiting for approval, on this target, for this amount. It answers it by asking the one gate the same
 * question every other entrypoint asks (`AccessDecisionGate.decide`, CUTOVER-PLAN §3.1), so an
 * explanation can never disagree with what the runtime will do:
 *
 *   1. the surface itself is decided (`shell-super-app.access-explain.read`, `kind: 'admin'`, tenant
 *      context): a person who may not ask "Proč?" gets 403 and learns nothing about anyone;
 *   2. authority metadata is a *separate* capability (`…access-explain.read-authority`): the outcome
 *      and its reason codes may be shown without it, roles, deadlines and people may not;
 *   3. explaining *someone else* is a third capability (`…access-explain.read-subject`) plus a proven
 *      membership of the asker's own tenant;
 *   4. the asked capability's declaration comes from the tenant's *published* catalog — never from the
 *      request — and that same declaration is handed to the gate as the carrier, so the policy the
 *      gate decides is the policy the release published (O1, guarantee 2);
 *   5. the answer is projected by Core's own `explainAccess`, so the reason vocabulary and the evidence
 *      shape are the ones every other explanation path returns (D13).
 *
 * Non-enumeration rules this file enforces, in one place:
 *
 *   - Nothing about a record is ever returned: no record key, no holder, no assignee identity, no raw
 *     witness. The answer speaks about the explained person's own grants (`authority`) and, at most,
 *     about which roles and people could grant the capability *in a scope* — never about who owns a row.
 *   - People and role names are returned only under the authority-metadata capability. Without it the
 *     answer carries the outcome and its codes alone (`authorityMetadata: 'withheld'`), and the
 *     directories are never called, so a refusal cannot leak whether anything was found.
 *   - An unreadable identity, catalog or engine is a retryable 503 and never a denial. A denial is a
 *     200 whose `outcome` is `DENIED`; that is a different statement from 403 "you may not ask".
 *   - A capability the release does not publish is answered `DENIED`/`deny.declaration_missing` — the
 *     code the gate refuses a declaration-less entrypoint with — instead of a distinct "unknown"
 *     answer, so the endpoint cannot be used to test whether a key exists. A person of another tenant
 *     and a person who does not exist answer with one and the same 403.
 *   - Tenant admission is not company authority (O88). A question about someone else in a company,
 *     and the authority block of any company question, are asked again in that company's own required
 *     scope, for the asker; a company that refuses reads exactly like a company the asker cannot select,
 *     and its roles, deadlines and people are withheld.
 *   - No caller-supplied authority: the payload names a capability, a mode, a subject scope, an
 *     optional subject person, a target and an amount. It never names a decision, an administrator, a
 *     parent read or the people who could grant it. A parent read is not accepted because a wrong one
 *     would render a false ALLOWED; a field capability is answered by the gate's own
 *     `deny.parent_read_required` until the release carries the field group's parent.
 *
 * KNOWN GAP (raised to P1b, not fixed here): `scripts/authorization-catalog.mts` recognises a
 * declaration only on a carrier descriptor (Action, governed read, shell contribution, page) whose
 * `accessDeclaration` is a static literal beside `entrypoint`. This BFF's three capabilities are
 * therefore validated at definition time (`declaredAccessCarrier` refuses a wrong classification), but
 * they are not in the scanned catalog yet, so `stage-access-catalog` publishes no capability for them
 * and no role can be granted the surface until the admin-surface carrier is decided. Every product
 * lane's admin BFF has the same shape, so that carrier belongs in one shared decision, not in one file.
 */

const MODULE_KEY = 'shell-super-app';

/** The entrypoints of the "Proč?" surface; each carries its own capability (O1, O62). */
export const accessExplainEntrypoints = Object.freeze({
  read: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-explain.read',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  readAuthority: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-explain.read-authority',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  readSubject: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-explain.read-subject',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
});

type ExplainEntrypoint = (typeof accessExplainEntrypoints)[keyof typeof accessExplainEntrypoints];

/**
 * Asking "Proč?" is administrative work, never business data: every capability is `kind: 'admin'`, so
 * Core refuses them at routine risk, agents never run them (O43, O67-Q5) and they run in tenant context
 * without a selected company (O28). `selectors` stays empty — an explanation reaches capabilities, never
 * a row set. `declaredAccessCarrier` validates each declaration against its own entrypoint at definition
 * time, so a wrong classification fails here, not silently at runtime.
 */
const declaredDeclaration = (
  key: string,
  entrypoint: ExplainEntrypoint,
  risk: 'critical' | 'sensitive',
): AccessDeclaration => {
  const carrier = declaredAccessCarrier({
    accessDeclaration: {
      key,
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'access', level: 'manage' },
      risk,
      selectors: [],
    },
    entrypoint,
  });
  // Definition-time invariant: `declaredAccessCarrier` returned a declaration because one was given.
  return Option.getOrThrow(Option.fromNullishOr(carrier.accessDeclaration));
};

/** Published with the Shell module's declarations by P1 (O50: never a private allow of this file). */
export const accessExplainDeclarations = Object.freeze({
  read: declaredDeclaration('shell-super-app.access-explain.read', accessExplainEntrypoints.read, 'sensitive'),
  readAuthority: declaredDeclaration(
    'shell-super-app.access-explain.read-authority',
    accessExplainEntrypoints.readAuthority,
    'critical',
  ),
  readSubject: declaredDeclaration(
    'shell-super-app.access-explain.read-subject',
    accessExplainEntrypoints.readSubject,
    'critical',
  ),
});

/** An administration surface is tenant work: it never needs a selected company (O28, P3). */
const ADMIN_LEGAL_ENTITY_SCOPE = 'optional' as const;
/** A company's own scope: the only context its roles and people are explained in (O88). */
const COMPANY_LEGAL_ENTITY_SCOPE = 'required' as const;

const FORBIDDEN_DETAIL = '"Proč?" is not available to this person.';
/** One answer for "not a member of this tenant" and for "no such person": they are indistinguishable. */
const SUBJECT_FORBIDDEN_DETAIL = 'the access of this person cannot be explained here.';
const UNAVAILABLE = accessAdminUnavailableProblem();

/**
 * The gate's answers for this surface's entrypoints. A denial — and a `NEEDS_APPROVAL` that no
 * explanation can honour, because asking "Proč?" is not a proposal — is 403; an engine that cannot
 * decide is the retryable 503, never a denial.
 */
export const accessExplainGateProblem = (outcome: 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE'): AccessAdminProblem =>
  outcome === 'UNAVAILABLE' ? UNAVAILABLE : accessAdminForbiddenProblem(FORBIDDEN_DETAIL);

/* ------------------------------------------------------------------------------------------------
 * The released catalog, as "Proč?" reads it
 * ---------------------------------------------------------------------------------------------- */

/** One published capability: its declaration projection and the module that owns the key (O1, O27). */
export interface AccessExplainPublishedCapability {
  /**
   * Exactly the declaration projection the release published. It is handed to the gate unchanged as the
   * asked entrypoint's carrier, so the decided policy is the published one; the request adds nothing.
   */
  readonly declaration: AccessDeclarationInput;
  /** The record-owning module of the key; the declaration's owner rules are checked against it. */
  readonly moduleKey: string;
  /**
   * The containing declaration a field group rides (O87): present exactly on `field_read`/`field_write`
   * entries, never inside the declaration itself. The release guarantees it names another entry of the
   * same release that is not a field group, so the parent read is read from the catalog, not the request.
   */
  readonly parentKey?: string;
}

/** No labels are read when the answer may not show any: an empty map is the honest default. */
const NO_ROLE_LABELS: ReadonlyMap<RoleId, string> = new Map();

/**
 * The two questions an explanation asks the catalog, kept apart because they cost different things: the
 * release is platform-wide and cheap (one published-catalog read), while role names need the tenant's own
 * intent. A caller decides first, and a withheld answer never pays for the labels at all.
 */
export type AccessExplainReleaseReader = () => Effect.Effect<
  readonly AccessExplainPublishedCapability[],
  AccessExplainCatalogUnavailable
>;
export type AccessExplainRoleLabelReader = (
  scope: OperationalScope,
) => Effect.Effect<ReadonlyMap<RoleId, string>, AccessExplainCatalogUnavailable>;

/** A release this composition cannot read: retryable, and never narrowed into "nothing is published". */
const AccessExplainCatalogUnavailableSchema = Schema.TaggedStruct('AccessExplainCatalogUnavailable', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
});
export type AccessExplainCatalogUnavailable = Schema.Schema.Type<typeof AccessExplainCatalogUnavailableSchema>;

export const accessExplainCatalogUnavailable = (reason: string, cause?: unknown): AccessExplainCatalogUnavailable =>
  cause === undefined
    ? AccessExplainCatalogUnavailableSchema.make({ _tag: 'AccessExplainCatalogUnavailable', reason })
    : AccessExplainCatalogUnavailableSchema.make({ _tag: 'AccessExplainCatalogUnavailable', cause, reason });

/**
 * The owner facts a declaration is validated against. They are structural properties of the descriptor
 * the published key came from — an Action is a write entrypoint, a governed read is a read entrypoint —
 * never a claim about authority, and the catalog projection does not carry them.
 */
const ownerOfPublishedKey = (moduleKey: string, kind: AccessDeclaration['kind']): AccessDeclarationOwner =>
  kind === 'action' || kind === 'field_write'
    ? { access: 'write', authorization: { kind: 'protected' }, moduleKey, role: 'action' }
    : { access: 'read', authorization: { kind: 'protected' }, moduleKey, role: 'api' };

export const publishedDeclaration = (
  capability: AccessExplainPublishedCapability | undefined,
): AccessDeclaration | undefined => {
  if (capability === undefined) {
    return undefined;
  }
  const decoded = decodeAccessDeclaration(
    capability.declaration,
    ownerOfPublishedKey(capability.moduleKey, capability.declaration.kind),
  );
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/** One published entry of the release this decision is asked against (O1, guarantee 2). */
type ReleaseEntry = NonNullable<AccessChangesView['release']>['entries'][number];

/** One release entry as the declaration projection the decision policy reads. */
const publishedCapability = (entry: ReleaseEntry): AccessExplainPublishedCapability => {
  const base: AccessDeclarationInput = {
    key: entry.key,
    kind: entry.kind,
    modes: entry.modes,
    placement: entry.placement,
    risk: entry.risk,
    selectors: entry.selectors,
  };
  const withAmount = entry.amountInput === undefined ? base : { ...base, amountInput: entry.amountInput };
  const withFieldClass = entry.fieldClass === undefined ? withAmount : { ...withAmount, fieldClass: entry.fieldClass };
  // The release states the ephemeral proof itself (O22, O87), so it is carried through and never re-derived
  // here: a projection that omits it is a broken catalog, which `decodeAccessDeclaration` below refuses.
  const withEphemeral =
    entry.ephemeral === undefined ? withFieldClass : { ...withFieldClass, ephemeral: entry.ephemeral };
  const declaration = entry.lineage === undefined ? withEphemeral : { ...withEphemeral, lineage: entry.lineage };
  const baseCapability = { declaration, moduleKey: String(entry.moduleKey) };
  // The release names a field group's parent (O87); every other kind carries none.
  return entry.parentKey === undefined ? baseCapability : { ...baseCapability, parentKey: String(entry.parentKey) };
};

const releaseUnreadable = (failure: { readonly code: string }) =>
  accessExplainCatalogUnavailable(`the published release could not be read: ${failure.code}`, failure);

/**
 * The release every capability is decided against: platform-wide, one published-catalog read, no tenant
 * state. A composition with no published release has nothing to explain from — that is retryable
 * unavailability and never an empty catalog that every key would answer as "no declaration in force".
 */
export const releaseReader = (
  commands: Pick<AccessChangesCommandsService, 'readRelease'>,
): AccessExplainReleaseReader =>
  Effect.fn('AccessExplainCatalog.release')(function* releaseEffect(): Effect.fn.Return<
    readonly AccessExplainPublishedCapability[],
    AccessExplainCatalogUnavailable
  > {
    const release = yield* commands.readRelease().pipe(Effect.mapError(releaseUnreadable));
    if (Option.isNone(release)) {
      return yield* Effect.fail(
        accessExplainCatalogUnavailable('no release has been published, so no capability is in force'),
      );
    }
    return release.value.entries.map(publishedCapability);
  });

/**
 * What the tenant calls its roles — the only labels an explanation may show, and only when the asker may
 * see authority metadata at all. One read of the tenant's roles, nothing else: no release, no intent, no
 * memberships, and no policy of its own, so it can never become a second gate. A caller asks for it late,
 * after the metadata decision, and never on a withheld answer.
 */
export const roleLabelReader = (
  commands: Pick<AccessChangesCommandsService, 'roleNames'>,
): AccessExplainRoleLabelReader =>
  Effect.fn('AccessExplainCatalog.roleLabels')(function* roleLabelsEffect(
    scope: OperationalScope,
  ): Effect.fn.Return<ReadonlyMap<RoleId, string>, AccessExplainCatalogUnavailable> {
    return yield* commands
      .roleNames(scope)
      .pipe(
        Effect.mapError((failure) =>
          accessExplainCatalogUnavailable(`the tenant's role names could not be read: ${failure.code}`, failure),
        ),
      );
  });

/* ------------------------------------------------------------------------------------------------
 * The identity directory: who could grant, and whether someone is a member here
 * ---------------------------------------------------------------------------------------------- */

/** One person who could grant the asked capability in the asked scope. */
export interface AccessExplainGrantablePerson {
  readonly displayName: string;
  readonly principalId: string;
}

const AccessExplainDirectoryUnavailableSchema = Schema.TaggedStruct('AccessExplainDirectoryUnavailable', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
});
export type AccessExplainDirectoryUnavailable = Schema.Schema.Type<typeof AccessExplainDirectoryUnavailableSchema>;

const directoryUnavailable = (reason: string, cause?: unknown): AccessExplainDirectoryUnavailable =>
  cause === undefined
    ? AccessExplainDirectoryUnavailableSchema.make({ _tag: 'AccessExplainDirectoryUnavailable', reason })
    : AccessExplainDirectoryUnavailableSchema.make({ _tag: 'AccessExplainDirectoryUnavailable', cause, reason });

/** One question about the identity of a scope: who could grant, and whether someone is a member here. */
export interface AccessExplainDirectoryAnswers {
  /**
   * The people who hold a role that reaches this capability *in a scope*. It never answers a
   * record-scoped question, so it cannot become a way to learn who owns a row. A composition without it
   * answers "unknown", never "nobody": the surface must not tell a person that no one can grant what
   * they lack.
   */
  readonly grantableBy: (input: {
    readonly capabilityKey: string;
    readonly mode: 'propose' | 'run';
    readonly scope: OperationalScope;
  }) => Effect.Effect<readonly AccessExplainGrantablePerson[], AccessExplainDirectoryUnavailable>;
  /**
   * The proof that a named subject belongs to the asker's own tenant. It answers one boolean for members
   * and the same boolean for everyone else, so a person of another tenant and a person who does not exist
   * are indistinguishable — which is why an explanation of someone else's access cannot be used to test
   * whether a principal exists.
   */
  readonly isTenantMember: (input: {
    readonly principalId: string;
    readonly scope: OperationalScope;
  }) => Effect.Effect<boolean, AccessExplainDirectoryUnavailable>;
}

/** The membership every principal of this tenant has; management rows are separate (see memberships.ts). */
const TENANT_MEMBER = 'member';

const membershipLoader = (memberships: readonly AccessMembership[], principalId: string, now: Date): boolean =>
  memberships.some(
    (membership) =>
      membership.kind === TENANT_MEMBER &&
      membership.status === 'active' &&
      Predicate.isTagged(membership.holder, 'Principal') &&
      String(membership.holder.principalId) === principalId &&
      membership.validFrom <= now &&
      (membership.validUntil === undefined || now < membership.validUntil),
  );

/**
 * The one identity answer this wave can prove without a product directory: Core's own membership intent.
 * A subject must hold an active `member` row of the asker's tenant, inside its own period — never a row
 * read from the request, and never a kind lookup on an arbitrary UUID (P3's rule).
 *
 * Who could *grant* a capability needs the tenant's roles joined to their holders, which no contract
 * exposes yet, so this directory answers that question as unknown rather than inventing one.
 */
export const makeAccessExplainDirectory = (
  load: (scope: OperationalScope) => Effect.Effect<readonly AccessMembership[], AccessExplainDirectoryUnavailable>,
): AccessExplainDirectoryAnswers => ({
  grantableBy: () => Effect.fail(directoryUnavailable('this composition binds no role directory')),
  isTenantMember: Effect.fn('AccessExplainDirectory.isTenantMember')(function* isTenantMemberEffect(input: {
    readonly principalId: string;
    readonly scope: OperationalScope;
  }): Effect.fn.Return<boolean, AccessExplainDirectoryUnavailable> {
    const memberships = yield* load(input.scope);
    return membershipLoader(memberships, input.principalId, yield* DateTime.nowAsDate);
  }),
});

/* ------------------------------------------------------------------------------------------------
 * The BFF
 * ---------------------------------------------------------------------------------------------- */

type AuthorityMetadataState = ExplainAccessResponse['authorityMetadata'];
/** The record a question names, if it names one; Core brands it with the scope it resolves in (D29). */
type GenericTarget = GateInput['target'];
type DecisionAnswer = Effect.Success<ReturnType<AccessDecisionService['decide']>>;

/** The gate's own answer for a capability that decides authority metadata: only ALLOWED grants it. */
const authorityVisibility = (decision: DecisionAnswer): 'granted' | 'unavailable' | 'withheld' => {
  if (decision.outcome === 'ALLOWED') {
    return 'granted';
  }
  return decision.outcome === 'UNAVAILABLE' ? 'unavailable' : 'withheld';
};

/**
 * Whether the authority block may be shown. A withheld question shows nothing and never reads a
 * directory; a granted question with an unreadable or unbound directory says "unknown", because telling
 * a person that nobody could grant the capability would be a claim this surface cannot make.
 */
const authorityMetadataOf = (
  visibility: 'granted' | 'unavailable' | 'withheld',
  grantable: readonly AccessExplainGrantablePerson[] | undefined,
): AuthorityMetadataState => {
  if (visibility === 'withheld') {
    return 'withheld';
  }
  return visibility === 'granted' && grantable !== undefined ? 'included' : 'unavailable';
};

/** No declaration in force: the same code the gate refuses a declaration-less entrypoint with (O62). */
const missingDeclaration = (): ExplainAccessResponse => ({
  authority: [],
  authorityMetadata: 'withheld',
  grantableBy: [],
  outcome: 'DENIED',
  reasonCodes: ['deny.declaration_missing'],
});

/**
 * The wire vocabulary of reason codes, and the one place a decision is checked against it. An engine code
 * this release cannot name is a contract mismatch, so the answer is a retryable 503: a browser must never
 * receive a code no copy can explain, and no code is invented here to fill the gap.
 */
const decodeReasonCode = Schema.decodeUnknownResult(AccessDecisionReasonCodeSchema);
type DeclaredReasonCode = typeof AccessDecisionReasonCodeSchema.Type;

/**
 * The decision's codes as the wire vocabulary states them, or nothing: an engine code this release cannot
 * name is a contract mismatch, never a code a browser is shown. A decision always carries at least one.
 */
const reasonCodesOf = (
  reasons: readonly { readonly code: string }[],
): NonEmptyReadonlyArray<DeclaredReasonCode> | undefined => {
  const codes: DeclaredReasonCode[] = [];
  for (const reason of reasons) {
    const decoded = decodeReasonCode(reason.code);
    if (Result.isFailure(decoded)) {
      return undefined;
    }
    codes.push(decoded.success);
  }
  const [first, ...rest] = codes;
  return first === undefined ? undefined : [first, ...rest];
};

/** A gate question whose authority could not be read at all (O48b: never a denial, always retryable). */
const AccessExplainUnavailableSchema = Schema.TaggedStruct('AccessExplainUnavailable', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
});
export type AccessExplainUnavailable = Schema.Schema.Type<typeof AccessExplainUnavailableSchema>;

const accessExplainUnavailable = (reason: string, cause?: unknown): AccessExplainUnavailable =>
  cause === undefined
    ? AccessExplainUnavailableSchema.make({ _tag: 'AccessExplainUnavailable', reason })
    : AccessExplainUnavailableSchema.make({ _tag: 'AccessExplainUnavailable', cause, reason });

/** Every dependency failure this surface can meet, kept as one named union (no `unknown` in a signature). */
type AccessExplainDependencyFailure =
  | AccessExplainCatalogUnavailable
  | AccessExplainDirectoryUnavailable
  | AccessExplainUnavailable;

/**
 * A dependency that did not answer must never become a denial, and its evidence must not vanish: the
 * answer is the retryable 503, and the failure itself goes to the log where an operator can find it.
 */
const unavailableBecause = Effect.fn('AccessExplainBff.unavailableBecause')(function* unavailableBecauseEffect(
  failure: AccessExplainDependencyFailure,
) {
  yield* Effect.logWarning('access explain: a dependency did not answer, so the question stays unanswered', failure);
  return yield* Effect.fail(UNAVAILABLE);
});

/** Core decides in `Date`; the wire contract carries Effect's UTC instant, so the boundary converts. */
const utcOf = (value: Date | undefined) => (value === undefined ? undefined : DateTime.fromDateUnsafe(value));

/** The asked record, branded by Core so a raw key can never reach another tenant's record (D29). */
const targetOf = (payload: ExplainAccessPayload): GateInput['target'] =>
  payload.target === undefined
    ? undefined
    : {
        moduleKey: ModuleKeySchema.make(payload.target.moduleKey),
        recordKey: RecordKeySchema.make(payload.target.recordKey),
      };

/**
 * The parent read a field capability rides (D14, O58, O74): the containing declaration's own capability,
 * read from the release — with the asked record only when that parent is itself record-scoped, and with
 * no record at all when it is scope-wide. A field capability whose parent this release cannot describe is
 * `'unprovable'`: that is a catalog defect, answered as retryable unavailability and never as a denial,
 * because a caller-named parent would let a wrong parent render a false ALLOWED (O87).
 */
const parentReadOf = (
  entries: readonly AccessExplainPublishedCapability[],
  capability: AccessExplainPublishedCapability,
  declaration: AccessDeclaration,
  target: GenericTarget,
  amount: AccessAmount | undefined,
): NonNullable<GateInput['parentRead']> | 'unprovable' | undefined => {
  if (capability.parentKey === undefined) {
    return declaration.kind === 'field_read' || declaration.kind === 'field_write' ? 'unprovable' : undefined;
  }
  const parentDeclaration = publishedDeclaration(
    entries.find((candidate) => candidate.declaration.key === capability.parentKey),
  );
  if (parentDeclaration === undefined) {
    return 'unprovable';
  }
  const parentCapability = capabilityPolicyOf(parentDeclaration);
  const parent =
    parentCapability.selectors.length === 0 || target === undefined
      ? { capability: parentCapability }
      : { capability: parentCapability, target };
  // A capped parent is held to the same hypothetical amount as the field it carries, as execution does.
  return amount === undefined ? parent : { ...parent, amount };
};

/** The governed money value of the hypothetical command, as the amount caveat reads it (O18). */
const amountOf = (payload: ExplainAccessPayload): AccessAmount | undefined =>
  payload.amount === undefined ? undefined : { currency: payload.amount.currency, minor: payload.amount.minor };

export interface AccessExplainBffService {
  /**
   * One explanation for one question. The tenant, the acting person, the instant, the declaration and
   * every scope come from the session, the release and Core; only the question comes from the request.
   */
  readonly explain: (
    headers: Headers,
    payload: ExplainAccessPayload,
  ) => Effect.Effect<ExplainAccessResponse, AccessAdminProblem>;
}

export class AccessExplainBff extends Context.Service<AccessExplainBff, AccessExplainBffService>()(
  '@app/shell-super-app/api/access-admin/explain/AccessExplainBff',
) {}

/**
 * The functions this surface is built from. They are plain functions, not services, because the owning
 * composition binds them once in the layer below: the surface asks the one gate, the one session port and
 * one reader per collaborator, and it can ask nothing else.
 */
interface AccessExplainPorts {
  readonly decide: (input: GateInput) => Effect.Effect<DecisionAnswer>;
  readonly grantableBy?: AccessExplainDirectoryAnswers['grantableBy'];
  readonly isTenantMember?: AccessExplainDirectoryAnswers['isTenantMember'];
  readonly readRelease: AccessExplainReleaseReader;
  readonly readRoleLabels: AccessExplainRoleLabelReader;
  readonly requireTenantContext: (headers: Headers) => Effect.Effect<OperationalScope, AccessAdminProblem>;
  readonly selectableLegalEntities: (input: {
    readonly now: Date;
    readonly scope: OperationalScope;
  }) => Effect.Effect<readonly LegalEntityId[], AccessExplainUnavailable>;
}

export const makeAccessExplainBff = (ports: AccessExplainPorts): AccessExplainBffService => {
  const {
    decide,
    grantableBy: readGrantableBy,
    isTenantMember,
    readRelease,
    readRoleLabels,
    requireTenantContext,
    selectableLegalEntities,
  } = ports;

  /** One entrypoint's own admission in the tenant context this surface always runs in (O28). */
  const admitCapability = Effect.fn('AccessExplainBff.admitCapability')(function* admitExplainCapability(
    scope: OperationalScope,
    carrier: AccessDeclaration,
  ) {
    const decision = yield* decide({
      carrier: { accessDeclaration: carrier },
      legalEntityScope: ADMIN_LEGAL_ENTITY_SCOPE,
      now: yield* DateTime.nowAsDate,
      scope,
    });
    if (decision.outcome !== 'ALLOWED') {
      return yield* Effect.fail(accessExplainGateProblem(decision.outcome));
    }
    return scope;
  });

  /**
   * One explain capability asked for the asker in the company a question is about (O88). The company
   * was already proven selectable, so its trusted scope is the asker's own with that company.
   */
  const askInCompany = Effect.fn('AccessExplainBff.askInCompany')(function* askExplainInCompany(
    asker: OperationalScope,
    legalEntityId: NonNullable<OperationalScope['legalEntityId']>,
    carrier: AccessDeclaration,
  ) {
    const decision = yield* decide({
      carrier: { accessDeclaration: carrier },
      legalEntityScope: COMPANY_LEGAL_ENTITY_SCOPE,
      now: yield* DateTime.nowAsDate,
      scope: { ...asker, legalEntityId },
    });
    if (decision.outcome === 'UNAVAILABLE') {
      // An unreadable company authority is a retry, never a smaller or a wider answer (O48).
      return yield* Effect.fail(UNAVAILABLE);
    }
    return decision.outcome === 'ALLOWED';
  });

  /** A request's own admission: P1's tenant context, then the entrypoint's own capability. */
  const admit = Effect.fn('AccessExplainBff.admit')(function* admitExplainSurface(
    headers: Headers,
    carrier: AccessDeclaration,
  ) {
    return yield* admitCapability(yield* requireTenantContext(headers), carrier);
  });

  /**
   * Whose access is explained. Naming another person is its own capability (`…read-subject`, asked of the
   * same gate) *and* a proven membership of the asker's own tenant: the tenant never comes from the
   * request, and a person of another tenant and a person who does not exist are refused with one and the
   * same answer, so the surface cannot be used to test whether a principal exists.
   *
   * The subject's question substitutes only the acting principal — it authenticates nobody, it carries the
   * asker's own session binding, and it never leaves this read-only path.
   */
  const subjectScope = Effect.fn('AccessExplainBff.subjectScope')(function* resolveSubjectScope(
    asker: OperationalScope,
    memberId: string | undefined,
  ) {
    // Explaining yourself through the subject field is the same question as asking without it: a UI may
    // echo the current person, and that must never become a summary of someone else's right to ask.
    if (memberId === undefined || memberId === asker.principalId) {
      return asker;
    }
    yield* admitCapability(asker, accessExplainDeclarations.readSubject);
    if (isTenantMember === undefined) {
      return yield* Effect.fail(UNAVAILABLE);
    }
    const member = yield* isTenantMember({ principalId: memberId, scope: asker }).pipe(
      Effect.catch(unavailableBecause),
    );
    if (!member) {
      return yield* Effect.fail(accessAdminForbiddenProblem(SUBJECT_FORBIDDEN_DETAIL));
    }
    return { ...asker, principalId: PrincipalIdSchema.make(memberId) };
  });

  /**
   * The company a company-owned capability is asked in. Administration runs in the tenant context (O28)
   * and everything else in the company context it belongs to (O7), so the payload's scope domain must be
   * the one the release declares; a mismatch is the request's own error, never a denial. A company the
   * person may not select is refused through the gate's own `access_legal_entity#select` question, so the
   * body never picks a company context: it asks for one that is already authorized.
   */
  const companyScope = Effect.fn('AccessExplainBff.companyScope')(function* resolveCompanyScope(
    asker: OperationalScope,
    scope: OperationalScope,
    declaration: AccessDeclaration,
    payload: ExplainAccessPayload,
  ) {
    const tenantContext = declaration.kind === 'admin';
    if (payload.scope.kind === 'tenant') {
      if (tenantContext) {
        return scope;
      }
      return yield* Effect.fail(
        accessAdminUnprocessableProblem(
          'this capability belongs to a company, so the question names the company it belongs to',
        ),
      );
    }
    if (tenantContext) {
      return yield* Effect.fail(
        accessAdminUnprocessableProblem(
          'this capability is administered in the tenant context, so it is asked without a company',
        ),
      );
    }
    const { legalEntityId } = payload.scope;
    const selectable = yield* selectableLegalEntities({ now: yield* DateTime.nowAsDate, scope }).pipe(
      Effect.catch(unavailableBecause),
    );
    const refused = accessAdminForbiddenProblem('this person may not work in the company the question names');
    if (!selectable.some((id) => String(id) === legalEntityId)) {
      return yield* Effect.fail(refused);
    }
    // Someone else's access in a company is that company's data: the tenant-context `read-subject`
    // answer admitted the question, and the company itself must admit it too (O88).
    if (
      scope.principalId !== asker.principalId &&
      !(yield* askInCompany(asker, legalEntityId, accessExplainDeclarations.readSubject))
    ) {
      return yield* Effect.fail(refused);
    }
    return { ...scope, legalEntityId };
  });

  /** Who asks and whom the question is about, resolved before the release is read (no early disclosure). */
  const resolveRequest = Effect.fn('AccessExplainBff.resolveRequest')(function* resolveExplainRequest(
    headers: Headers,
    payload: ExplainAccessPayload,
  ) {
    const asker = yield* admit(headers, accessExplainDeclarations.read);
    const subject = yield* subjectScope(
      asker,
      payload.subjectPrincipalId === undefined ? undefined : String(payload.subjectPrincipalId),
    );
    return { asker, subject };
  });

  /**
   * The wire answer for one decision: Core's own projection, the authority block only when the asker may
   * see it, and the reason codes checked against the vocabulary this release can render.
   */
  const explainedResponse = Effect.fn('AccessExplainBff.explainedResponse')(function* explainedResponseEffect(
    asker: OperationalScope,
    decision: DecisionAnswer,
    declaration: AccessDeclaration,
    payload: ExplainAccessPayload,
    legalEntityId: OperationalScope['legalEntityId'],
  ) {
    // Defence in depth: an unprovable decision never becomes an explanation, whoever calls this projection.
    if (decision.outcome === 'UNAVAILABLE') {
      return yield* Effect.fail(UNAVAILABLE);
    }
    const tenantVisibility = authorityVisibility(
      yield* decide({
        carrier: { accessDeclaration: accessExplainDeclarations.readAuthority },
        legalEntityScope: ADMIN_LEGAL_ENTITY_SCOPE,
        now: yield* DateTime.nowAsDate,
        scope: asker,
      }),
    );
    // A company question's authority names that company's roles, deadlines and people, so the company
    // must admit the metadata capability in its own scope as well (O88).
    const visibility =
      tenantVisibility === 'withheld' ||
      legalEntityId === undefined ||
      (yield* askInCompany(asker, legalEntityId, accessExplainDeclarations.readAuthority))
        ? tenantVisibility
        : 'withheld';
    const grantable =
      visibility === 'granted' && readGrantableBy !== undefined
        ? Option.getOrUndefined(
            yield* readGrantableBy({ capabilityKey: declaration.key, mode: payload.mode, scope: asker }).pipe(
              Effect.option,
            ),
          )
        : undefined;
    // Role names are the tenant's own vocabulary, so they are read only when this answer may show them:
    // a withheld response never spends the tenant-state read that names them.
    const roleLabels =
      visibility === 'withheld' ? NO_ROLE_LABELS : yield* readRoleLabels(asker).pipe(Effect.catch(unavailableBecause));
    const explanation = explainAccess({
      decision,
      policy: capabilityPolicyOf(declaration),
      roleLabels,
    });
    const authorityMetadata = authorityMetadataOf(visibility, grantable);
    const authority = explanation.authority.map((item) => {
      const base = {
        capabilityKey: AccessCapabilityKeySchema.make(String(item.capabilityKey)),
        mode: item.mode,
        roleId: AccessRoleIdSchema.make(String(item.roleId)),
        selector: item.selector,
      };
      const dated = item.deadline === undefined ? base : { ...base, deadline: DateTime.fromDateUnsafe(item.deadline) };
      return item.roleLabel === undefined ? dated : { ...dated, roleName: item.roleLabel };
    });
    const grantableBy =
      authorityMetadata === 'included' && grantable !== undefined
        ? grantable.map((person) => ({
            displayName: person.displayName,
            principalId: AccessHumanIdSchema.make(person.principalId),
          }))
        : [];
    const reasonCodes = reasonCodesOf(decision.reasons);
    if (reasonCodes === undefined) {
      return yield* Effect.fail(UNAVAILABLE);
    }
    const decisionDeadline = utcOf(explanation.admissionDeadline);
    const baseResponse: ExplainAccessResponse = {
      authority: authorityMetadata === 'withheld' ? [] : authority,
      authorityMetadata,
      grantableBy,
      outcome: decision.outcome,
      reasonCodes,
    };
    const scheduled =
      decisionDeadline === undefined ? baseResponse : { ...baseResponse, admissionDeadline: decisionDeadline };
    return explanation.fieldClass === undefined ? scheduled : { ...scheduled, fieldClass: explanation.fieldClass };
  });

  const explain = Effect.fn('AccessExplainBff.explain')(function* explainAccessQuestion(
    headers: Headers,
    payload: ExplainAccessPayload,
  ) {
    const request = yield* resolveRequest(headers, payload);
    const { asker, subject } = request;
    const entries = yield* readRelease().pipe(Effect.catch(unavailableBecause));
    const askedCapability = entries.find((capability) => capability.declaration.key === payload.capabilityKey);
    const declaration = publishedDeclaration(askedCapability);
    if (askedCapability === undefined || declaration === undefined) {
      return missingDeclaration();
    }
    // The seam decides `run` or `approve` and never `propose` (O56, O63): a proposal question is answered
    // by that same decision (`NEEDS_APPROVAL` is what a propose-only holder gets), and a mode the release
    // does not offer is the engine's own `deny.mode_unsupported`.
    if (!declaration.modes.includes(payload.mode)) {
      const unsupportedMode: ExplainAccessResponse = {
        ...missingDeclaration(),
        reasonCodes: ['deny.mode_unsupported'],
      };
      return unsupportedMode;
    }

    const target = targetOf(payload);
    const amount = amountOf(payload);
    const parentRead = parentReadOf(entries, askedCapability, declaration, target, amount);
    if (parentRead === 'unprovable') {
      // The release describes a field capability without the parent read it rides: no truthful answer
      // exists, and a broken catalog is never a denial (O87).
      return yield* Effect.fail(UNAVAILABLE);
    }
    const question: GateInput = {
      carrier: { accessDeclaration: declaration },
      legalEntityScope: declaration.kind === 'admin' ? ADMIN_LEGAL_ENTITY_SCOPE : COMPANY_LEGAL_ENTITY_SCOPE,
      now: yield* DateTime.nowAsDate,
      scope: yield* companyScope(asker, subject, declaration, payload),
    };
    const governed = amount === undefined ? question : { ...question, amount };
    // Who asked, when the answer is about someone else (O86): the gate records it beside the subject's
    // own row, so "explained about X" is never mistaken for "X acted". The asker is always the session
    // principal, and the subject was proven to be a member of the same tenant above.
    const onBehalfOf =
      subject.principalId === asker.principalId ? undefined : PrincipalIdSchema.make(asker.principalId);
    const targeted = target === undefined ? governed : { ...governed, target };
    const withParent = parentRead === undefined ? targeted : { ...targeted, parentRead };
    const decision = yield* decide(
      onBehalfOf === undefined ? withParent : { ...withParent, onBehalfOfPrincipalId: onBehalfOf },
    );
    if (decision.outcome === 'UNAVAILABLE') {
      return yield* Effect.fail(UNAVAILABLE);
    }
    if (decision.reasons.some(({ code }) => code === 'deny.scope_mismatch')) {
      return yield* Effect.fail(accessAdminForbiddenProblem(FORBIDDEN_DETAIL));
    }

    // The metadata question is always about the *asker*: what someone may see about authority does not
    // change because they asked on someone else's behalf.
    return yield* explainedResponse(asker, decision, declaration, payload, question.scope.legalEntityId);
  });

  return Object.freeze({ explain });
};

/** The one gate question whose failure this surface translates: which companies the person may select. */
export const selectableCompaniesOf =
  (gate: Pick<AccessDecisionService, 'selectableLegalEntities'>) =>
  (input: {
    readonly now: Date;
    readonly scope: OperationalScope;
  }): Effect.Effect<readonly LegalEntityId[], AccessExplainUnavailable> =>
    gate
      .selectableLegalEntities(input)
      .pipe(Effect.mapError((cause) => accessExplainUnavailable('the selectable companies could not be read', cause)));

/** The surface with Core's membership intent as its directory: naming a member of this tenant works. */
export const AccessExplainBffWithMembershipsLive: Layer.Layer<
  AccessExplainBff,
  never,
  AccessAdminSession | AccessChangesCommands | AccessDecisionGate | AccessMembershipStore
> = Layer.effect(
  AccessExplainBff,
  Effect.gen(function* accessExplainBffWithMemberships() {
    const commands = yield* AccessChangesCommands;
    const gate = yield* AccessDecisionGate;
    const session = yield* AccessAdminSession;
    const memberships = yield* AccessMembershipStore;
    const directory = makeAccessExplainDirectory((scope) =>
      memberships
        .loadTenantMemberships(scope)
        .pipe(Effect.mapError((cause) => directoryUnavailable('memberships unreadable', cause))),
    );
    return makeAccessExplainBff({
      decide: gate.decide,
      grantableBy: directory.grantableBy,
      isTenantMember: directory.isTenantMember,
      readRelease: releaseReader(commands),
      readRoleLabels: roleLabelReader(commands),
      requireTenantContext: session.requireTenantContext,
      selectableLegalEntities: selectableCompaniesOf(gate),
    });
  }),
);

/* ------------------------------------------------------------------------------------------------
 * The HTTP surface (P1 registers the group and merges this layer)
 * ---------------------------------------------------------------------------------------------- */

/** The endpoint's headers, as the owning contract states them (an open string map is forbidden here). */
const ExplainRequestHeadersSchema = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Undefined]));
type ExplainRequestHeaders = Schema.Schema.Type<typeof ExplainRequestHeadersSchema>;

/** The endpoint's headers as the `Headers` the session integration reads. */
const headersOf = (headers: ExplainRequestHeaders): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
};

/**
 * Every response this surface returns is personal — who may do what, in which scope, sometimes about a
 * named person — so nothing may be stored by a proxy, a browser or a CDN.
 *
 * The admin session layer also registers this centrally before authentication, so this is a second net
 * rather than the only one: the surface that renders the personal body states its own guarantee, and stays
 * correct if it is ever reached through a handler that does not pass the session. Both set the same value
 * through `Headers.set`, so the duplicate is idempotent. It is not imported from `api/index.ts` because
 * that module imports this one, and a cycle for two lines of header is not worth it.
 */
export const noStoreExplain = (response: Parameters<typeof HttpServerResponse.setHeader>[0]) =>
  HttpServerResponse.setHeader(response, 'cache-control', 'no-store');

/**
 * Registered before the handler body, so it decorates whatever response this request finally produces —
 * the success payload and the problem bodies alike, since a 403 or a 503 here is as personal as a 200.
 */
const registerNoStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(noStoreExplain(response)),
);

export const accessAdminExplainGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'accessAdminExplain',
  (handlers) =>
    handlers.handle(
      'explainAccess',
      Effect.fn('shell.accessExplain.explainAccess')(function* explainAccessHandler({ payload, request }) {
        yield* registerNoStore;
        const bff = yield* AccessExplainBff;
        return yield* bff.explain(headersOf(request.headers), payload);
      }),
    ),
);
