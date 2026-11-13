import { Result, Schema } from 'effect';

import { withOptional } from '../access/decision/optional.ts';
import type { ModuleEntrypointDescriptor } from '../modules/module-entrypoint.ts';
import { AccessCatalogError } from './access-catalog-error.ts';
import { AccessDeclarationError } from './access-declaration-error.ts';

/** One scalar money value of the governed command in minor units (O18); decoded from the payload. */
export type { AccessAmount } from '../access/decision/contract.ts';

/**
 * One business record of the request when a capability is record-scoped (O9, O27): the immutable
 * record id inside the module that owns the record. The decision engine brands and re-checks both
 * halves inside the resolved scope, so an authoring mistake fails closed instead of reaching a
 * foreign tenant's record.
 */
export interface AccessTarget {
  readonly moduleKey: string;
  readonly recordKey: string;
}

export const ACCESS_KINDS = ['action', 'read', 'field_read', 'field_write', 'export', 'admin'] as const;
export const ACCESS_RISKS = ['routine', 'sensitive', 'critical'] as const;
export const ACCESS_PLACEMENT_LEVELS = ['basic', 'extended', 'manage'] as const;
export const ACCESS_SELECTORS = ['all', 'assigned', 'entrusted', 'team'] as const;
export const ACCESS_MODES = ['run', 'propose', 'approve'] as const;
export const AGENT_POLICIES = ['run', 'propose_only', 'never'] as const;

/** Verbs that are never routine (D29), plus `retire` (O13). */
export const DANGEROUS_ACCESS_VERBS = [
  'anonymize',
  'approve',
  'cancel',
  'close-period',
  'credit-note',
  'delete',
  'erase',
  'export',
  'grant',
  'impersonate',
  'merge',
  'pay',
  'payout',
  'publish',
  'purge',
  'refund',
  'remove',
  'retire',
  'revoke',
  'transfer',
  'void',
  'write-off',
] as const;

/** Terminal state changes are at least sensitive (O13); a routine one is surfaced for review. */
export const TERMINAL_ACCESS_VERBS = ['archive', 'close', 'deactivate'] as const;

/** Field classes with a sensitive floor (O19). Other lowercase classes are allowed and reviewed. */
export const SENSITIVE_FIELD_CLASSES = [
  'authority_metadata',
  'bank_details',
  'credit_limits',
  'financial_amounts',
  'margins',
  'personal_data',
  'purchase_prices',
  'salaries',
  'tax_identifiers',
] as const;

/** Lowercase words of any spelling: case, separators and camelCase boundaries carry no meaning. */
const identifierWords = (value: string): readonly string[] =>
  value
    .normalize('NFKC')
    .replaceAll(/(?<before>[\p{Ll}\p{N}])(?<after>\p{Lu})/gu, '$<before> $<after>')
    .replaceAll(/(?<before>\p{Lu})(?<after>\p{Lu}\p{Ll})/gu, '$<before> $<after>')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);

const vocabulary = (entries: readonly string[]): ReadonlySet<string> =>
  new Set(entries.map((entry) => identifierWords(entry).join('')));
const dangerousVerbSpellings = vocabulary([...DANGEROUS_ACCESS_VERBS, 'anonymise']);
const terminalVerbSpellings = vocabulary(TERMINAL_ACCESS_VERBS);
const sensitiveFieldClasses: ReadonlySet<string> = new Set(SENSITIVE_FIELD_CLASSES);
const longestSpelling = Math.max(...[...dangerousVerbSpellings, ...terminalVerbSpellings].map(({ length }) => length));

/** One word, or adjacent words joined into a compound, spells a vocabulary entry. */
const spellsVocabularyWord = (words: readonly string[], spellings: ReadonlySet<string>): boolean =>
  words.some((_, start) => {
    let joined = '';
    for (const word of words.slice(start)) {
      joined += word;
      if (spellings.has(joined)) {
        return true;
      }
      if (joined.length >= longestSpelling) {
        return false;
      }
    }
    return false;
  });

/** Whole words or joined compounds only, in any case, separator or camelCase spelling (D29, O6). */
export const hasDangerousAccessVerb = (identifier: string): boolean =>
  spellsVocabularyWord(identifierWords(identifier), dangerousVerbSpellings);

/** The verb and qualifier segments after `<module>.<resource>`, or undefined for a foreign key. */
const accessKeyVerbSegments = (key: string, moduleKey: string): string | undefined => {
  if (!key.startsWith(`${moduleKey}.`)) {
    return undefined;
  }
  const segments = key.slice(moduleKey.length + 1).split('.');
  return segments.length < 2 ? undefined : segments.slice(1).join('.');
};

/** Lowercase kebab segments `<module>.<resource>.<verb>[.<qualifier>]`; module IDs may be dotted. */
/** Lowercase kebab segments `<module>.<resource>.<verb>[.<qualifier>]`; module IDs may be dotted. */
const accessKeySyntax = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$/u),
);
/** The key grammar alone, for authored descriptors that still carry the key as a plain string. */
export const AccessKeySyntaxSchema = accessKeySyntax;
export const AccessKeySchema = accessKeySyntax.pipe(Schema.brand('AccessKey'));
export type AccessKey = typeof AccessKeySchema.Type;

const accessFieldClassSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u),
);
/** A bounded property path into a payload or result object, e.g. `priceRevisions.amount` (O18). */
const accessPathSchema = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/u),
);
const accessPlacementSchema = Schema.Struct({
  /** Suggested editor row; a suggestion, never a grant (P2). */
  group: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)),
  level: Schema.Literals(ACCESS_PLACEMENT_LEVELS),
});
const accessModesSchema = Schema.Array(Schema.Literals(ACCESS_MODES)).check(Schema.isMinLength(1), Schema.isUnique());
const accessSelectorsSchema = Schema.Array(Schema.Literals(ACCESS_SELECTORS)).check(Schema.isUnique());

const accessDeclarationFields = Schema.Struct({
  /**
   * A surface entry of the access-administration UI, never an operation (O88): the declaration of an
   * admin page, which a person who administers access in at least one company may enter before they
   * have chosen one. It admits the surface and nothing else — a tenant role, an owner operation and
   * every company's data stay decided on their own keys in their own scope — so it is exactly `true`
   * or absent, and only a page carrier may write it.
   */
  admitsAdminSurface: Schema.optionalKey(Schema.Literal(true)),
  /** One scalar money value of the Action payload, or a server-derived total for composites (O18). */
  amountInput: Schema.optionalKey(accessPathSchema),
  /** A short-lived proof that cannot wait for an approval (O22). */
  ephemeral: Schema.optionalKey(Schema.Boolean),
  fieldClass: Schema.optionalKey(accessFieldClassSchema),
  key: AccessKeySchema,
  kind: Schema.Literals(ACCESS_KINDS),
  lineage: Schema.optionalKey(
    Schema.Struct({
      renamedFrom: Schema.optionalKey(Schema.Array(AccessKeySchema).check(Schema.isMinLength(1), Schema.isUnique())),
      splitFrom: Schema.optionalKey(AccessKeySchema),
    }),
  ),
  modes: accessModesSchema,
  placement: accessPlacementSchema,
  risk: Schema.Literals(ACCESS_RISKS),
  selectors: accessSelectorsSchema,
});
type AccessDeclarationFields = typeof accessDeclarationFields.Type;
type AccessLineage = NonNullable<AccessDeclarationFields['lineage']>;

const isRunOnly = (modes: AccessDeclarationFields['modes']): boolean => modes.length === 1 && modes[0] === 'run';

/**
 * Agents only propose sensitive or critical Actions, so those must accept proposals (O14, O22).
 * Administration is never available to agents, so an admin declaration needs no proposal path (O43).
 */
const requiresProposal = (
  declaration: Pick<AccessDeclarationFields, 'ephemeral' | 'kind' | 'modes' | 'risk'>,
): boolean =>
  declaration.kind !== 'admin' &&
  declaration.risk !== 'routine' &&
  declaration.ephemeral !== true &&
  !declaration.modes.includes('propose');

const lineageParents = (
  lineage: { readonly renamedFrom?: readonly string[]; readonly splitFrom?: string } | undefined,
): readonly string[] => {
  const renamedFrom = lineage?.renamedFrom ?? [];
  return lineage?.splitFrom === undefined ? renamedFrom : [...renamedFrom, lineage.splitFrom];
};

const lineageIssue = (declaration: AccessDeclarationFields): string | undefined => {
  const { lineage } = declaration;
  if (lineage === undefined) {
    return undefined;
  }
  if (lineage.renamedFrom === undefined && lineage.splitFrom === undefined) {
    return 'lineage must name renamedFrom or splitFrom';
  }
  if (lineageParents(lineage).includes(declaration.key)) {
    return 'lineage cannot reference its own access key';
  }
  return lineage.splitFrom !== undefined && lineage.renamedFrom?.includes(lineage.splitFrom) === true
    ? 'an access key cannot be renamed from and split from the same key'
    : undefined;
};

const modesIssue = (declaration: AccessDeclarationFields): string | undefined => {
  const { kind, modes } = declaration;
  if ((kind === 'read' || kind === 'field_read' || declaration.ephemeral === true) && !isRunOnly(modes)) {
    return 'reads and ephemeral Actions support only run mode';
  }
  if (modes.includes('approve') && !modes.includes('propose')) {
    return 'approve mode requires propose mode';
  }
  return kind === 'action' && requiresProposal(declaration)
    ? 'sensitive and critical Actions must support propose mode'
    : undefined;
};

/** Owner-independent classification rules; owner-bound rules live in accessDeclarationEntrypointIssue. */
const declarationIssue = (declaration: AccessDeclarationFields): string | undefined => {
  const { fieldClass, kind, risk } = declaration;
  if (risk === 'routine' && (kind === 'export' || kind === 'admin')) {
    return 'export and admin declarations require at least sensitive risk';
  }
  if ((kind === 'field_read' || kind === 'field_write') !== (fieldClass !== undefined)) {
    return 'fieldClass is required by field_read and field_write declarations and forbidden otherwise';
  }
  if (risk === 'routine' && fieldClass !== undefined && sensitiveFieldClasses.has(fieldClass)) {
    return `field class ${fieldClass} requires at least sensitive risk`;
  }
  if (kind !== 'action' && (declaration.amountInput !== undefined || declaration.ephemeral !== undefined)) {
    return 'amountInput and ephemeral are supported only by action declarations';
  }
  return modesIssue(declaration) ?? lineageIssue(declaration);
};

const freezeLineage = (lineage: AccessLineage): AccessLineage =>
  Object.freeze(
    lineage.renamedFrom === undefined
      ? { ...lineage }
      : { ...lineage, renamedFrom: Object.freeze([...lineage.renamedFrom]) },
  );

const freezeAccessDeclaration = (declaration: AccessDeclarationFields): AccessDeclarationFields => {
  const frozen = {
    ...declaration,
    modes: Object.freeze([...declaration.modes]),
    placement: Object.freeze({ ...declaration.placement }),
    selectors: Object.freeze([...declaration.selectors]),
  };
  return Object.freeze(
    declaration.lineage === undefined ? frozen : { ...frozen, lineage: freezeLineage(declaration.lineage) },
  );
};

/**
 * Metadata only: a declaration never grants anything and becomes usable only after adoption.
 * Structural rules are owner-independent; the carrying entrypoint is validated by
 * `accessDeclarationEntrypointIssue` inside `decodeAccessDeclaration`.
 */
export const AccessDeclarationSchema = accessDeclarationFields.check(Schema.makeFilter(declarationIssue));
/** A decoded declaration; `decodeAccessDeclaration` returns it deeply frozen. */
export type AccessDeclaration = typeof AccessDeclarationSchema.Type;
/** The shape a module author writes on a descriptor. */
export type AccessDeclarationInput = typeof AccessDeclarationSchema.Encoded;
/** The entrypoint that carries a declaration; the role decides whether it is an Action carrier. */
export type AccessDeclarationOwner = Pick<
  ModuleEntrypointDescriptor,
  'access' | 'authorization' | 'moduleKey' | 'role'
>;
export type AgentPolicy = (typeof AGENT_POLICIES)[number];

/**
 * `protected` is one classification for Actions and for direct surfaces alike, so every carrier rule
 * below reads the role when the kind alone cannot tell them apart (CUTOVER-PLAN §4.2).
 */
const isActionCarrier = (owner: AccessDeclarationOwner): boolean =>
  owner.authorization.kind === 'action_execution' ||
  (owner.authorization.kind === 'protected' && owner.role === 'action');

/**
 * A governed read (O72): the direct API or report surface of a read descriptor. Pages, shell
 * contributions (navigation, components, search), write surfaces and every unprotected entrypoint
 * are never a governed read.
 */
const isGovernedReadCarrier = (owner: AccessDeclarationOwner): boolean =>
  owner.authorization.kind === 'protected' &&
  (owner.role === 'api' || owner.role === 'report') &&
  (owner.access === 'read' || owner.access === 'historical_read');

const isDirectCarrier = (owner: AccessDeclarationOwner): boolean =>
  owner.authorization.kind === 'context_permission' ||
  (owner.authorization.kind === 'protected' && owner.role !== 'action');

/**
 * The entrypoint classifications that carry access metadata (CUTOVER-PLAN §4.2): the v2 `protected`
 * kind and, until L03b removes them, the two legacy protected kinds (O62, O68). Every other
 * classification is unprotected: public, `authenticated_principal`, `owner_local_background` and
 * `capability_issuance` entrypoints carry no access at all.
 */
export const isProtectedAccessEntrypoint = (owner: AccessDeclarationOwner): boolean =>
  owner.authorization.kind === 'protected' ||
  owner.authorization.kind === 'action_execution' ||
  owner.authorization.kind === 'context_permission';

const actionEntrypointIssue = (declaration: AccessDeclarationInput): string | undefined => {
  if (declaration.kind === 'read' || declaration.kind === 'field_read') {
    return 'Actions cannot declare read access';
  }
  return requiresProposal(declaration) ? 'sensitive and critical Actions must support propose mode' : undefined;
};

/** Pages, components, APIs, search, reports and governed reads execute directly, never by proposal. */
const directEntrypointIssue = (
  declaration: AccessDeclarationInput,
  owner: AccessDeclarationOwner,
): string | undefined => {
  if (!isRunOnly(declaration.modes) || declaration.ephemeral !== undefined) {
    return 'only Actions support propose, approve and ephemeral declarations';
  }
  const writes = declaration.kind === 'action' || declaration.kind === 'field_write';
  if (owner.access !== 'write' && writes) {
    return 'read-only entrypoints cannot declare write access';
  }
  return owner.access === 'write' && (declaration.kind === 'read' || declaration.kind === 'field_read')
    ? 'write entrypoints cannot declare read access'
    : undefined;
};

/**
 * The surface marker is a page admission, never an operation (O88): it belongs to an admin page, so an
 * Action, a governed read, a BFF operation and every non-admin declaration are illegal carriers and
 * fail at definition time instead of becoming an unnoticed widening of tenant authority.
 */
const adminSurfaceIssue = (declaration: AccessDeclarationInput, owner: AccessDeclarationOwner): string | undefined => {
  if (declaration.admitsAdminSurface !== true) {
    return undefined;
  }
  if (declaration.kind !== 'admin') {
    return 'admitsAdminSurface is supported only by an admin declaration (O88)';
  }
  return owner.role === 'page'
    ? undefined
    : 'admitsAdminSurface is supported only by a page carrier: it admits the administration surface, never an operation (O88)';
};

/**
 * Rules that need the carrying entrypoint. Only protected entrypoints carry access metadata: the two
 * legacy protected kinds and the v2 `protected` classification, which L03b leaves alone (O62, O68).
 */
export const accessDeclarationEntrypointIssue = (
  declaration: AccessDeclarationInput,
  owner: AccessDeclarationOwner,
): string | undefined => {
  const { authorization, moduleKey } = owner;
  if (!isProtectedAccessEntrypoint(owner)) {
    return `${authorization.kind} entrypoints cannot carry accessDeclaration`;
  }
  const verbSegments = accessKeyVerbSegments(declaration.key, moduleKey);
  if (verbSegments === undefined) {
    return `access key ${declaration.key} must be ${moduleKey}.<resource>.<verb>`;
  }
  if (lineageParents(declaration.lineage).some((key) => accessKeyVerbSegments(key, moduleKey) === undefined)) {
    return 'access lineage must stay within the owning module';
  }
  if (declaration.risk === 'routine' && hasDangerousAccessVerb(verbSegments)) {
    return `dangerous verb in ${declaration.key} cannot have routine risk`;
  }
  const surfaceIssue = adminSurfaceIssue(declaration, owner);
  if (surfaceIssue !== undefined) {
    return surfaceIssue;
  }
  return isActionCarrier(owner) ? actionEntrypointIssue(declaration) : directEntrypointIssue(declaration, owner);
};

const decodeAccessDeclarationFields = Schema.decodeUnknownResult(AccessDeclarationSchema, {
  onExcessProperty: 'error',
});

const invalidDeclaration = (reason: string): AccessDeclarationError =>
  new AccessDeclarationError({ code: 'access_declaration_invalid', reason });

/** Non-throwing decoder for runtime and catalog tooling (O5). */
export const decodeAccessDeclaration = <Input>(
  input: Input,
  owner: AccessDeclarationOwner,
): Result.Result<AccessDeclaration, AccessDeclarationError> =>
  decodeAccessDeclarationFields(input).pipe(
    Result.mapError((issue) => invalidDeclaration(issue.message)),
    Result.map((declaration) => freezeAccessDeclaration(declaration)),
    Result.flatMap((declaration) => {
      const reason = accessDeclarationEntrypointIssue(declaration, owner);
      return reason === undefined ? Result.succeed(declaration) : Result.fail(invalidDeclaration(reason));
    }),
  );

/** Definition-time constructor (O5): like the entrypoint constructors, it throws the tagged error. */
export const decodeAccessDeclarationOrThrow = <Input>(input: Input, owner: AccessDeclarationOwner): AccessDeclaration =>
  Result.getOrThrow(decodeAccessDeclaration(input, owner));

/** Definition-time decoder for a protected descriptor carrier (O5). */
export const decodeProtectedAccessDeclaration = <Input>(
  input: Input,
  owner: AccessDeclarationOwner,
): AccessDeclaration => decodeAccessDeclarationOrThrow(input, owner);

/**
 * Definition-time carrier spread: the declaration is decoded, validated against its entrypoint and
 * frozen, while an absent declaration stays absent instead of becoming an explicit undefined value.
 */
export const declaredAccessDeclaration = (descriptor: {
  readonly accessDeclaration?: AccessDeclarationInput;
  readonly entrypoint: AccessDeclarationOwner;
}): { readonly accessDeclaration?: AccessDeclaration } => {
  const declared = descriptor.accessDeclaration;
  return declared === undefined
    ? {}
    : { accessDeclaration: decodeProtectedAccessDeclaration(declared, descriptor.entrypoint) };
};

/** Field groups govern reads on a read carrier and writes on an Action carrier (O58). */
export const ACCESS_FIELD_GROUP_KINDS = ['field_read', 'field_write'] as const;

const accessFieldGroupFields = Schema.Struct({
  /** Required: a group without a class cannot be placed or reviewed (O19). */
  fieldClass: accessFieldClassSchema,
  /** Result or payload paths this group governs; never empty, never repeated. */
  fields: Schema.Array(accessPathSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  key: AccessKeySchema,
  kind: Schema.Literals(ACCESS_FIELD_GROUP_KINDS),
  modes: accessModesSchema,
  placement: accessPlacementSchema,
  risk: Schema.Literals(ACCESS_RISKS),
  /** Field class switches are not record scopes: the parent declaration carries the selectors. */
  selectors: accessSelectorsSchema.check(
    Schema.makeFilter((selectors) =>
      selectors.length === 0 ? undefined : 'a field group is never record-scoped: keep selectors empty',
    ),
  ),
});
type AccessFieldGroupFields = typeof accessFieldGroupFields.Type;

/** `['run', 'propose', 'approve']` in any order: the only non-run-only shape a group may use (O44). */
const isProposableAndApprovable = (modes: AccessFieldGroupFields['modes']): boolean =>
  modes.length === 3 && ['approve', 'propose', 'run'].every((mode) => modes.some((declared) => declared === mode));

const fieldGroupIssue = (group: AccessFieldGroupFields): string | undefined => {
  if (group.risk === 'routine' && sensitiveFieldClasses.has(group.fieldClass)) {
    return `field class ${group.fieldClass} requires at least sensitive risk`;
  }
  if (group.kind === 'field_read' && !isRunOnly(group.modes)) {
    return 'field_read groups support only run mode';
  }
  if (group.kind === 'field_write' && !isRunOnly(group.modes) && !isProposableAndApprovable(group.modes)) {
    return "field_write groups support run only, or run with 'propose' and 'approve' (O44)";
  }
  return group.modes.includes('approve') && !group.modes.includes('propose')
    ? 'approve mode requires propose mode'
    : undefined;
};

/**
 * One sensitive field group of a descriptor (O58): owner-independent rules here, carrier and
 * parent rules in `accessFieldGroupEntrypointIssue`. A group never grants anything.
 */
export const AccessFieldGroupSchema = accessFieldGroupFields.check(Schema.makeFilter(fieldGroupIssue));
/** A decoded field group; `decodeAccessFieldGroups` returns these deeply frozen. */
export type AccessFieldGroup = typeof AccessFieldGroupSchema.Type;
/** The shape a module author writes beside `accessDeclaration`. */
export type AccessFieldGroupInput = typeof AccessFieldGroupSchema.Encoded;

const freezeAccessFieldGroup = (group: AccessFieldGroupFields): AccessFieldGroup =>
  Object.freeze({
    ...group,
    fields: Object.freeze([...group.fields]),
    modes: Object.freeze([...group.modes]),
    placement: Object.freeze({ ...group.placement }),
    selectors: Object.freeze([...group.selectors]),
  });

const fieldGroupCarrierKind = (owner: AccessDeclarationOwner): 'field_read' | 'field_write' | undefined => {
  if (isActionCarrier(owner)) {
    return 'field_write';
  }
  return isDirectCarrier(owner) ? 'field_read' : undefined;
};

/** Rules that need the carrying entrypoint and the key of its own declaration (O58). */
export const accessFieldGroupEntrypointIssue = (
  group: AccessFieldGroupInput,
  owner: AccessDeclarationOwner,
  parentKey: string,
): string | undefined => {
  const carrierKind = fieldGroupCarrierKind(owner);
  if (carrierKind === undefined) {
    return `${owner.authorization.kind} entrypoints cannot carry accessFieldGroups`;
  }
  if (group.kind !== carrierKind) {
    return `${carrierKind === 'field_write' ? 'Action' : 'read'} descriptors must declare field groups as ${carrierKind}`;
  }
  if (group.key === parentKey) {
    return `field group ${group.key} must declare its own key, not the key of its parent declaration`;
  }
  const verbSegments = accessKeyVerbSegments(group.key, owner.moduleKey);
  if (verbSegments === undefined) {
    return `field group key ${group.key} must be ${owner.moduleKey}.<resource>.<verb>`;
  }
  return group.risk === 'routine' && hasDangerousAccessVerb(verbSegments)
    ? `dangerous verb in field group ${group.key} cannot have routine risk`
    : undefined;
};

const decodeAccessFieldGroupFields = Schema.decodeUnknownResult(AccessFieldGroupSchema, {
  onExcessProperty: 'error',
});

export interface AccessFieldGroupCarrier {
  readonly accessDeclaration?: AccessDeclarationInput;
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  readonly entrypoint: AccessDeclarationOwner;
}

/** Non-throwing decoder for every group of one descriptor (O5, O58). */
export const decodeAccessFieldGroups = <Input>(
  inputs: readonly Input[],
  owner: AccessDeclarationOwner,
  parentKey: string,
): Result.Result<readonly AccessFieldGroup[], AccessDeclarationError> => {
  const groups: AccessFieldGroup[] = [];
  const keys = new Set<string>();
  for (const input of inputs) {
    const decoded = decodeAccessFieldGroupFields(input);
    if (Result.isFailure(decoded)) {
      return Result.fail(invalidDeclaration(`accessFieldGroups: ${decoded.failure.message}`));
    }
    const group = freezeAccessFieldGroup(decoded.success);
    const reason = accessFieldGroupEntrypointIssue(group, owner, parentKey);
    if (reason !== undefined) {
      return Result.fail(invalidDeclaration(`accessFieldGroups: ${reason}`));
    }
    if (keys.has(group.key)) {
      return Result.fail(
        invalidDeclaration(`accessFieldGroups: field group key ${group.key} is declared twice on ${parentKey}`),
      );
    }
    keys.add(group.key);
    groups.push(group);
  }
  return Result.succeed(Object.freeze(groups));
};

/**
 * One registered workload identity (O73): `<module-namespace>.<kebab-name>` (for example
 * `core.identity-provider`). A direct `accessWorkload` stays in its carrier module's root namespace.
 * An `accessActor` subject workload keeps the calling flow's namespace, not the receiving owner's.
 */
export const WorkloadKeySchema = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u),
).pipe(Schema.brand('WorkloadKey'));
export type WorkloadKey = typeof WorkloadKeySchema.Type;

/**
 * A trusted machine workload instead of a human capability (O29, O59, O73). It never enters the
 * configurable catalog and is never granted to a human or an agent. `workloads` names exactly which
 * registered workload identities may run the carrier: a `service`/`integration`/`system` principal
 * is admitted only when Core holds an active binding for one of these keys (O73).
 */
export const AccessWorkloadSchema = Schema.Struct({
  /** Why no human or agent may run this Action; the only human-readable field. */
  reason: Schema.String.check(Schema.isMaxLength(400), Schema.isMinLength(1), Schema.isTrimmed()),
  /** The registered workloads allowed to run this carrier; at least one, never repeated (O73). */
  workloads: Schema.NonEmptyArray(WorkloadKeySchema).check(Schema.isUnique()),
});
/** A decoded workload marker; `decodeAccessWorkload` returns it frozen. */
export type AccessWorkload = typeof AccessWorkloadSchema.Type;
export type AccessWorkloadInput = typeof AccessWorkloadSchema.Encoded;

/**
 * The module namespace a workload key belongs to (O73): the root segment of the carrier's module key.
 * A module with key `example.operations` owns workload keys in `example.*`.
 */
const workloadModuleRoot = (moduleKey: string): string => moduleKey.split('.')[0] ?? moduleKey;

/** Whether a workload key sits in the carrier module's own namespace (O73). */
export const workloadKeyBelongsToModule = (key: string, moduleKey: string): boolean =>
  key.startsWith(`${workloadModuleRoot(moduleKey)}.`);

const decodeAccessWorkloadFields = Schema.decodeUnknownResult(AccessWorkloadSchema, {
  onExcessProperty: 'error',
});

/**
 * A workload marks a human capability gap, so only an Action or a governed read can carry one (O59,
 * O72). A page, a shell contribution and an unprotected read never do.
 */
export const accessWorkloadEntrypointIssue = (owner: AccessDeclarationOwner): string | undefined =>
  isActionCarrier(owner) || isGovernedReadCarrier(owner)
    ? undefined
    : `${owner.authorization.kind} ${owner.role} entrypoints cannot carry accessWorkload: only an Action or a governed read can be a workload`;

/** Non-throwing decoder for runtime and catalog tooling (O5, O59). */
export const decodeAccessWorkload = <Input>(
  input: Input,
  owner: AccessDeclarationOwner,
): Result.Result<AccessWorkload, AccessDeclarationError> =>
  decodeAccessWorkloadFields(input).pipe(
    Result.mapError((issue) => invalidDeclaration(`accessWorkload: ${issue.message}`)),
    Result.map((workload) => Object.freeze({ reason: workload.reason, workloads: Object.freeze(workload.workloads) })),
    Result.flatMap((workload) => {
      const reason = accessWorkloadEntrypointIssue(owner);
      if (reason !== undefined) {
        return Result.fail(invalidDeclaration(reason));
      }
      const foreign = workload.workloads.find((key) => !workloadKeyBelongsToModule(key, owner.moduleKey));
      return foreign === undefined
        ? Result.succeed(workload)
        : Result.fail(
            invalidDeclaration(`accessWorkload: ${foreign} does not belong to the module of ${owner.moduleKey} (O73)`),
          );
    }),
  );

/**
 * The topology app IDs a module call may name, in the same shape the Shell gateway audience uses. The
 * exact app IDs are the topology's; the carrier only has to name a stable app ID.
 */
const TopologyAppIdSchema = Schema.String.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('TopologyAppId'));

/**
 * Module-to-module calls (DESIGN D5). The calling module is the actor, named by the Shell-signed `act`
 * claim; `callers` lists the topology apps that may act on this carrier. `subject` says how a person the
 * call is done for is decided: `rights` runs the subject's own `accessDeclaration` decision (the carrier
 * already checked the user's rights, a relay), `identity` admits the verified subject without a capability
 * check (module plumbing that never checked the user's rights before). A registered workload named in
 * `subjectWorkloads` is admitted by its binding on either mode. `workload` admits only those registered
 * workload subjects, never a person, and carries no human capability. Only governs calls that carry `act`.
 */
export const AccessActorSchema = Schema.Struct({
  /** The calling topology apps; at least one, never repeated. */
  callers: Schema.NonEmptyArray(TopologyAppIdSchema).check(Schema.isUnique()),
  /** Why modules call this carrier; the only human-readable field. */
  reason: Schema.String.check(Schema.isMaxLength(400), Schema.isMinLength(1), Schema.isTrimmed()),
  subject: Schema.Literals(['identity', 'rights', 'workload']),
  /**
   * The registered workloads that may stand as the subject of a module call (workload subject): a workload
   * subject is admitted only when Core holds an active binding for one of these keys, whatever `subject` says
   * about a person. Its keys use the workload key format; the namespace belongs to the calling flow, not the
   * carrier.
   */
  subjectWorkloads: Schema.optionalKey(Schema.NonEmptyArray(WorkloadKeySchema).check(Schema.isUnique())),
  /**
   * The callers that may bring one of `subjectWorkloads` as the subject; absent, every caller may. A caller outside
   * it is refused a workload subject exactly as a carrier that names no workload refuses one.
   */
  subjectWorkloadCallers: Schema.optionalKey(Schema.NonEmptyArray(TopologyAppIdSchema).check(Schema.isUnique())),
}).check(
  Schema.makeFilter((actor) =>
    actor.subject === 'workload' && actor.subjectWorkloads === undefined
      ? 'a workload-only module actor requires subjectWorkloads'
      : undefined,
  ),
  // A narrowing of the workload-subject callers needs workload keys and may name only callers.
  Schema.makeFilter((actor) =>
    actor.subjectWorkloadCallers !== undefined && actor.subjectWorkloads === undefined
      ? 'subjectWorkloadCallers needs subjectWorkloads'
      : undefined,
  ),
  Schema.makeFilter((actor) =>
    actor.subjectWorkloadCallers?.some((caller) => !actor.callers.includes(caller)) === true
      ? 'subjectWorkloadCallers must be callers'
      : undefined,
  ),
);
/** A decoded actor declaration; `decodeAccessActor` returns it frozen. */
export type AccessActor = typeof AccessActorSchema.Type;
export type AccessActorInput = typeof AccessActorSchema.Encoded;

const decodeAccessActorFields = Schema.decodeUnknownResult(AccessActorSchema, {
  onExcessProperty: 'error',
});

/**
 * A module actor is declared only by an Action or a governed read: a page, a shell contribution and an
 * unprotected read never receive module calls.
 */
export const accessActorEntrypointIssue = (owner: AccessDeclarationOwner): string | undefined =>
  isActionCarrier(owner) || isGovernedReadCarrier(owner)
    ? undefined
    : `${owner.authorization.kind} ${owner.role} entrypoints cannot carry accessActor: only an Action or a governed read can receive a module call`;

/** Non-throwing decoder for `accessActor` (DESIGN D5). */
export const decodeAccessActor = <Input>(
  input: Input,
  owner: AccessDeclarationOwner,
): Result.Result<AccessActor, AccessDeclarationError> =>
  decodeAccessActorFields(input).pipe(
    Result.mapError((issue) => invalidDeclaration(`accessActor: ${issue.message}`)),
    Result.map((actor): AccessActor =>
      Object.freeze(
        withOptional(
          withOptional(
            { callers: Object.freeze(actor.callers), reason: actor.reason, subject: actor.subject },
            'subjectWorkloads',
            actor.subjectWorkloads === undefined ? undefined : Object.freeze(actor.subjectWorkloads),
          ),
          'subjectWorkloadCallers',
          actor.subjectWorkloadCallers === undefined ? undefined : Object.freeze(actor.subjectWorkloadCallers),
        ),
      ),
    ),
    Result.flatMap((actor) => {
      const reason = accessActorEntrypointIssue(owner);
      return reason === undefined ? Result.succeed(actor) : Result.fail(invalidDeclaration(reason));
    }),
  );

/** A descriptor whose access carriers are being checked; only presence matters here. */
export interface AccessCarrierPresence {
  readonly accessActor?: object;
  readonly accessDeclaration?: object;
  readonly accessWorkload?: object;
  readonly entrypoint: AccessDeclarationOwner & { readonly entrypointKey?: string };
}

/**
 * O62 makes declarations mandatory: a protected entrypoint without `accessDeclaration` or
 * `accessWorkload` is a definition-time error, never a reported gap. An unprotected entrypoint
 * carries neither and is not asked for one.
 */
export const missingAccessCarrierIssue = (carrier: AccessCarrierPresence): string | undefined =>
  isProtectedAccessEntrypoint(carrier.entrypoint) &&
  carrier.accessDeclaration === undefined &&
  carrier.accessWorkload === undefined &&
  carrier.accessActor === undefined
    ? `${carrier.entrypoint.entrypointKey ?? carrier.entrypoint.moduleKey} is ${carrier.entrypoint.authorization.kind}: a protected entrypoint must declare accessDeclaration, accessWorkload or accessActor (O62)`
    : undefined;

/** One descriptor carrying the access metadata of its entrypoint; at most one carrier kind beside a workload. */
export interface AccessCarrierInput {
  readonly accessActor?: AccessActorInput;
  readonly accessDeclaration?: AccessDeclarationInput;
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  readonly accessWorkload?: AccessWorkloadInput;
  readonly entrypoint: AccessDeclarationOwner;
}

/** The decoded, frozen carriers of one descriptor; an absent carrier stays absent. */
export interface DeclaredAccessCarrier {
  readonly accessActor?: AccessActor;
  readonly accessDeclaration?: AccessDeclaration;
  readonly accessFieldGroups?: readonly AccessFieldGroup[];
  readonly accessWorkload?: AccessWorkload;
}

/**
 * Definition-time carrier spread (O5, O58, O59, O67-Q4, O72): an Action or a governed read may carry
 * a workload marker beside its declaration (the workload path never admits humans and the
 * declaration path never admits workloads), every other carrier kind is mutually exclusive with a
 * workload, field access needs the parent record access, and everything is decoded and frozen.
 */
/** Nothing declared: one shared empty list, never a fresh mutable array. */
const NO_FIELD_GROUPS: readonly AccessFieldGroup[] = Object.freeze([]);

/** An exclusive module workload has neither human capabilities nor a direct-call admission. */
const workloadActorCarrierIssue = (descriptor: AccessCarrierInput): string | undefined => {
  if (descriptor.accessActor?.subject !== 'workload') {
    return undefined;
  }
  if (
    descriptor.accessDeclaration !== undefined ||
    descriptor.accessWorkload !== undefined ||
    (descriptor.accessFieldGroups?.length ?? 0) > 0
  ) {
    return 'a workload-only module actor cannot carry accessDeclaration, accessWorkload or accessFieldGroups';
  }
  return undefined;
};

/**
 * The decoded `accessActor` of one descriptor (D5). A `rights` actor reads the subject's own declaration,
 * so it needs one on the same carrier.
 */
const decodeActorCarrier = (
  descriptor: AccessCarrierInput,
): Result.Result<{ readonly accessActor?: AccessActor }, AccessDeclarationError> => {
  const { accessActor: actor, accessDeclaration, entrypoint } = descriptor;
  if (actor === undefined) {
    return Result.succeed({});
  }
  const decoded = decodeAccessActor(actor, entrypoint);
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure);
  }
  const exclusivityIssue = workloadActorCarrierIssue(descriptor);
  if (exclusivityIssue !== undefined) {
    return Result.fail(invalidDeclaration(exclusivityIssue));
  }
  if (decoded.success.subject === 'rights' && accessDeclaration === undefined) {
    return Result.fail(
      invalidDeclaration('accessActor subject "rights" requires accessDeclaration on the same carrier (D5)'),
    );
  }
  return Result.succeed({ accessActor: decoded.success });
};

/** Non-throwing carrier decoding, so a Schema filter can report a reason instead of throwing (O5). */
const decodeAccessCarriers = (
  descriptor: AccessCarrierInput,
): Result.Result<DeclaredAccessCarrier, AccessDeclarationError> => {
  const { accessDeclaration, entrypoint } = descriptor;
  const groups = descriptor.accessFieldGroups ?? [];
  const workload = descriptor.accessWorkload;
  const missing = missingAccessCarrierIssue(descriptor);
  if (missing !== undefined) {
    return Result.fail(invalidDeclaration(missing));
  }
  const actorCarrier = decodeActorCarrier(descriptor);
  if (Result.isFailure(actorCarrier)) {
    return Result.fail(actorCarrier.failure);
  }
  if (workload !== undefined && groups.length > 0) {
    return Result.fail(
      invalidDeclaration('accessWorkload carries no field groups: a workload writes no human-owned field'),
    );
  }
  if (
    workload !== undefined &&
    accessDeclaration !== undefined &&
    !isActionCarrier(entrypoint) &&
    !isGovernedReadCarrier(entrypoint)
  ) {
    return Result.fail(
      invalidDeclaration(
        'accessWorkload may accompany accessDeclaration only on an Action or a governed read: the declaration path of a page or shell surface never admits a workload (O67-Q4, O72)',
      ),
    );
  }
  if (groups.length > 0 && accessDeclaration === undefined) {
    return Result.fail(
      invalidDeclaration('accessFieldGroups require the descriptor to declare its own accessDeclaration (O58)'),
    );
  }
  let decodedWorkload: AccessWorkload | undefined;
  if (workload !== undefined) {
    const decoded = decodeAccessWorkload(workload, entrypoint);
    if (Result.isFailure(decoded)) {
      return Result.fail(decoded.failure);
    }
    decodedWorkload = decoded.success;
  }
  const workloadCarrier: { readonly accessWorkload?: AccessWorkload } =
    decodedWorkload === undefined ? {} : { accessWorkload: decodedWorkload };
  if (accessDeclaration === undefined) {
    return Result.succeed({ ...workloadCarrier, ...actorCarrier.success });
  }
  const decodedDeclaration = decodeAccessDeclaration(accessDeclaration, entrypoint);
  if (Result.isFailure(decodedDeclaration)) {
    return Result.fail(decodedDeclaration.failure);
  }
  const declared = decodedDeclaration.success;
  const declaredGroups =
    groups.length === 0 ? Result.succeed(NO_FIELD_GROUPS) : decodeAccessFieldGroups(groups, entrypoint, declared.key);
  if (Result.isFailure(declaredGroups)) {
    return Result.fail(declaredGroups.failure);
  }
  const groupCarrier: { readonly accessFieldGroups?: readonly AccessFieldGroup[] } =
    declaredGroups.success.length === 0 ? {} : { accessFieldGroups: declaredGroups.success };
  return Result.succeed({
    ...groupCarrier,
    ...workloadCarrier,
    ...actorCarrier.success,
    accessDeclaration: declared,
  });
};

/** Definition-time decoder (O5, O62): a carrier that cannot be read as written fails loudly. */
export const declaredAccessCarrier = (descriptor: AccessCarrierInput): DeclaredAccessCarrier =>
  Result.getOrThrow(decodeAccessCarriers(descriptor));

/** Non-throwing carrier check for schema filters and tooling: the first actionable reason, if any. */
export const accessCarrierIssue = (descriptor: AccessCarrierInput): string | undefined => {
  const decoded = decodeAccessCarriers(descriptor);
  return Result.isFailure(decoded) ? decoded.failure.reason : undefined;
};

/**
 * Derived, never declared (P4, D2, O45): agents run routine work, only propose sensitive or critical
 * Actions, and never administer. Only an Action can be proposed, so a sensitive read, field access or
 * export is never available to an agent. An ephemeral proof cannot wait for approval (O22).
 */
export const deriveAgentPolicy = (
  declaration: Pick<AccessDeclarationInput, 'ephemeral' | 'kind' | 'risk'>,
): AgentPolicy => {
  if (declaration.kind === 'admin') {
    return 'never';
  }
  if (declaration.risk === 'routine') {
    return 'run';
  }
  return declaration.kind === 'action' && declaration.ephemeral !== true ? 'propose_only' : 'never';
};

/**
 * An agent never runs a workload (O29, O59, O67-Q4): a trusted machine identity is not an agent
 * capability. A dual Action or a dual governed read follows its declaration, because the declaration
 * is the human and agent capability of the descriptor; a descriptor without any carrier is never
 * available to an agent.
 */
export const deriveCarrierAgentPolicy = (carrier: {
  readonly accessDeclaration?: Pick<AccessDeclarationInput, 'ephemeral' | 'kind' | 'risk'>;
  readonly accessWorkload?: AccessWorkloadInput;
}): AgentPolicy => (carrier.accessDeclaration === undefined ? 'never' : deriveAgentPolicy(carrier.accessDeclaration));

export interface AccessCatalogDescriptor {
  readonly accessActor?: AccessActorInput;
  readonly accessDeclaration?: AccessDeclarationInput;
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  readonly accessWorkload?: AccessWorkloadInput;
  readonly entrypoint: ModuleEntrypointDescriptor;
}

/** One module's protected descriptors: Actions, governed reads and Shell contributions. */
export interface AccessCatalogModule {
  readonly descriptors: readonly AccessCatalogDescriptor[];
  readonly moduleId: string;
}

/** A descriptor declaration or one of its field groups; a group entry is tied to its parent. */
export type AccessCatalogEntryDeclaration = AccessDeclaration | AccessFieldGroup;

export interface AccessCatalogEntry {
  readonly accessDeclaration: AccessCatalogEntryDeclaration;
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly moduleId: string;
  /** The parent declaration key of a field group entry; null for a descriptor declaration. */
  readonly parentKey: string | null;
}

/** Non-fatal review items: unlisted field classes (O19) and routine terminal verbs (O13). */
export interface AccessCatalogFinding {
  readonly code: 'routine_terminal_verb' | 'unlisted_field_class';
  readonly key: AccessKey;
  readonly moduleId: string;
  readonly reason: string;
}

export interface AccessCatalog {
  readonly entries: readonly AccessCatalogEntry[];
  readonly findings: readonly AccessCatalogFinding[];
}

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const catalogError = (code: AccessCatalogError['code'], moduleId: string, reason: string): AccessCatalogError =>
  new AccessCatalogError({ code, moduleId, reason });

/** Field groups carry no lineage; they are reviewed as part of their parent declaration. */
const lineageOf = (
  declaration: AccessCatalogEntryDeclaration,
): { readonly renamedFrom?: readonly string[]; readonly splitFrom?: string } | undefined =>
  'fields' in declaration ? undefined : declaration.lineage;

const findLineageCycle = (live: ReadonlyMap<string, AccessCatalogEntryDeclaration>): readonly string[] | undefined => {
  const settled = new Set<string>();
  const visit = (key: string, path: readonly string[]): readonly string[] | undefined => {
    if (path.includes(key)) {
      return [...path.slice(path.indexOf(key)), key];
    }
    const declaration = live.get(key);
    if (settled.has(key) || declaration === undefined) {
      return undefined;
    }
    for (const parent of lineageParents(lineageOf(declaration))) {
      const cycle = visit(parent, [...path, key]);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    settled.add(key);
    return undefined;
  };
  for (const key of live.keys()) {
    const cycle = visit(key, []);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
};

/** Renames are one-to-one, splits may share a parent, and a predecessor is never still declared. */
const lineageConflict = (live: ReadonlyMap<string, AccessCatalogEntryDeclaration>): string | undefined => {
  const renamedPredecessors = new Set<string>();
  const splitPredecessors = new Set<string>();
  for (const [key, declaration] of live) {
    const lineage = lineageOf(declaration);
    for (const predecessor of lineageParents(lineage)) {
      if (live.has(predecessor)) {
        return `${key} names ${predecessor} as a predecessor, but ${predecessor} is still declared`;
      }
    }
    for (const predecessor of lineage?.renamedFrom ?? []) {
      if (renamedPredecessors.has(predecessor) || splitPredecessors.has(predecessor)) {
        return `${predecessor} is renamed into more than one successor`;
      }
      renamedPredecessors.add(predecessor);
    }
    const splitFrom = lineage?.splitFrom;
    if (splitFrom !== undefined && renamedPredecessors.has(splitFrom)) {
      return `${splitFrom} is both renamed and split`;
    }
    if (splitFrom !== undefined) {
      splitPredecessors.add(splitFrom);
    }
  }
  return undefined;
};

const moduleCatalogError = (
  moduleId: string,
  entries: readonly AccessCatalogEntry[],
): AccessCatalogError | undefined => {
  const live = new Map<string, AccessCatalogEntryDeclaration>();
  for (const { accessDeclaration } of entries) {
    if (live.has(accessDeclaration.key)) {
      return catalogError(
        'access_catalog_duplicate_key',
        moduleId,
        `access key ${accessDeclaration.key} is declared twice`,
      );
    }
    live.set(accessDeclaration.key, accessDeclaration);
  }
  const cycle = findLineageCycle(live);
  if (cycle !== undefined) {
    return catalogError('access_catalog_lineage_cycle', moduleId, `access lineage cycle ${cycle.join(' -> ')}`);
  }
  const conflict = lineageConflict(live);
  return conflict === undefined ? undefined : catalogError('access_catalog_lineage_conflict', moduleId, conflict);
};

const reviewFindings = ({
  accessDeclaration,
  entrypoint,
  moduleId,
}: AccessCatalogEntry): readonly AccessCatalogFinding[] => {
  const findings: AccessCatalogFinding[] = [];
  const { fieldClass, key } = accessDeclaration;
  if (fieldClass !== undefined && !sensitiveFieldClasses.has(fieldClass)) {
    findings.push({ code: 'unlisted_field_class', key, moduleId, reason: `field class ${fieldClass} is not listed` });
  }
  const verbSegments = accessKeyVerbSegments(key, entrypoint.moduleKey) ?? '';
  if (
    accessDeclaration.risk === 'routine' &&
    spellsVocabularyWord(identifierWords(verbSegments), terminalVerbSpellings)
  ) {
    findings.push({
      code: 'routine_terminal_verb',
      key,
      moduleId,
      reason: 'a terminal or irreversible state change is at least sensitive; confirm it can be undone',
    });
  }
  return findings.map((finding) => Object.freeze(finding));
};

const catalogEntry = (
  moduleId: string,
  descriptor: AccessCatalogDescriptor,
  accessDeclaration: AccessCatalogEntryDeclaration,
  parentKey: string | null,
): AccessCatalogEntry =>
  Object.freeze({
    accessDeclaration,
    entrypoint: Object.freeze({
      ...descriptor.entrypoint,
      authorization: Object.freeze({ ...descriptor.entrypoint.authorization }),
    }),
    moduleId,
    parentKey,
  });

/** One field group is its own catalog entry, tied to the declaration of its descriptor (O58). */
const fieldGroupEntry = (
  moduleId: string,
  descriptor: AccessCatalogDescriptor,
  parentKey: string,
  group: AccessFieldGroup,
): AccessCatalogEntry => catalogEntry(moduleId, descriptor, group, parentKey);

const collectDescriptorEntries = (
  module: AccessCatalogModule,
  descriptor: AccessCatalogDescriptor,
): Result.Result<readonly AccessCatalogEntry[], AccessCatalogError> => {
  if (descriptor.accessActor?.subject === 'workload') {
    const issue = accessCarrierIssue(descriptor);
    return issue === undefined
      ? Result.succeed([])
      : Result.fail(
          catalogError(
            'access_catalog_declaration_invalid',
            module.moduleId,
            `${descriptor.entrypoint.entrypointKey}: ${issue}`,
          ),
        );
  }
  const { accessDeclaration, entrypoint } = descriptor;
  const groups = descriptor.accessFieldGroups ?? [];
  if (groups.length > 0 && accessDeclaration === undefined) {
    return Result.fail(
      catalogError(
        'access_catalog_declaration_invalid',
        module.moduleId,
        `${entrypoint.entrypointKey}: accessFieldGroups require the descriptor to declare its own accessDeclaration`,
      ),
    );
  }
  if (accessDeclaration === undefined) {
    return Result.succeed([]);
  }
  const decoded = decodeAccessDeclaration(accessDeclaration, entrypoint);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      catalogError(
        'access_catalog_declaration_invalid',
        module.moduleId,
        `${entrypoint.entrypointKey}: ${decoded.failure.reason}`,
      ),
    );
  }
  const decodedGroups = decodeAccessFieldGroups(groups, entrypoint, decoded.success.key);
  if (Result.isFailure(decodedGroups)) {
    return Result.fail(
      catalogError(
        'access_catalog_declaration_invalid',
        module.moduleId,
        `${entrypoint.entrypointKey}: ${decodedGroups.failure.reason}`,
      ),
    );
  }
  return Result.succeed([
    catalogEntry(module.moduleId, descriptor, decoded.success, null),
    ...decodedGroups.success.map((group) => fieldGroupEntry(module.moduleId, descriptor, decoded.success.key, group)),
  ]);
};

const collectModuleEntries = (
  module: AccessCatalogModule,
): Result.Result<readonly AccessCatalogEntry[], AccessCatalogError> => {
  const entries: AccessCatalogEntry[] = [];
  for (const descriptor of module.descriptors) {
    const { entrypoint } = descriptor;
    if (entrypoint.moduleKey !== module.moduleId) {
      return Result.fail(
        catalogError(
          'access_catalog_foreign_entrypoint',
          module.moduleId,
          `entrypoint ${entrypoint.entrypointKey} belongs to ${entrypoint.moduleKey}`,
        ),
      );
    }
    const collected = collectDescriptorEntries(module, descriptor);
    if (Result.isFailure(collected)) {
      return Result.fail(collected.failure);
    }
    entries.push(...collected.success);
  }
  return Result.succeed(entries);
};

/**
 * Pure, report-only catalog derivation. Keys are unique per module and lineage is acyclic,
 * one-to-one for renames and never points at a key that is still declared.
 */
export const collectAccessCatalog = (
  modules: readonly AccessCatalogModule[],
): Result.Result<AccessCatalog, AccessCatalogError> => {
  const byModule = new Map<string, AccessCatalogEntry[]>();
  for (const module of modules) {
    const collected = collectModuleEntries(module);
    if (Result.isFailure(collected)) {
      return Result.fail(collected.failure);
    }
    byModule.set(module.moduleId, [...(byModule.get(module.moduleId) ?? []), ...collected.success]);
  }
  for (const [moduleId, entries] of byModule) {
    const error = moduleCatalogError(moduleId, entries);
    if (error !== undefined) {
      return Result.fail(error);
    }
  }
  const entries = [...byModule.values()]
    .flat()
    .toSorted(
      (left, right) =>
        compareText(left.moduleId, right.moduleId) ||
        compareText(left.accessDeclaration.key, right.accessDeclaration.key),
    );
  return Result.succeed(
    Object.freeze({
      entries: Object.freeze(entries),
      findings: Object.freeze(entries.flatMap(reviewFindings)),
    }),
  );
};
