#!/usr/bin/env node
/**
 * Gives the exact staff logins eshop@akros.demo and expedice@akros.demo reviewed access to the AKROS seller
 * (tenant bceaa540…, company c0c78a3e…) through the Shell's own endpoints. Their AKROS Principals come from the
 * stage accounts bootstrap (`attachedLogins`), which also retires their former demo-tenant Principals
 * (`retiredPrincipals`), so each login signs in to AKROS and nowhere else; this command refuses a login that
 * still signs in anywhere else.
 *
 * Everything it decides on is read live, never from a hand-written inventory: each exact login signs in with
 * its own password and shows the tenants it resolves and its Principal in AKROS (only a `better_auth` staff
 * binding resolves, so an incompatible record never counts), and the AKROS administrator reads the company
 * directory, People, people options, roles and the catalog. Writes are the governed Shell calls only — company
 * membership, admit-member and assign of exact reviewed roles chosen by id — one at a time, re-reading stage
 * before each and reading every login back at the end.
 *
 *   printf '%s' '{"admin":"…","eshop@akros.demo":"…","expedice@akros.demo":"…"}' | \
 *     node scripts/demo/akros-staff-scope.mts --shell-url https://ontos-stage.web-revolution.cz \
 *       --admin-email <AKROS administrator> --eshop-role <roleId> --expedice-role <roleId> \
 *       --routing-role <roleId> [--apply]
 *
 * Without --apply it only reads and prints what it would send. Passwords come from stdin only and are never
 * printed. Exits: 0 done, 1 refused or failed, 3 blocked (access held but the AKROS seller is not selectable yet).
 */
import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Cause, Console, Duration, Effect, Exit, Layer, Match, Option, Ref, Schema, Stdio, Stream } from 'effect';
import type { Redacted } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import {
  AccessAdministrationApi,
  AccessCompanyIdSchema,
  AccessHumanIdSchema,
  AccessPeopleRevisionSchema,
  AccessRoleIdSchema,
  AccessRoleRevisionIdSchema,
} from '../../apps/shell-super-app/shared/access-admin-api.ts';
import type {
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
  ListAccessRolesResponseSchema,
  ListAccessRoleTemplatesResponseSchema,
} from '../../apps/shell-super-app/shared/access-admin-api.ts';
import {
  LegalEntityIdSchema,
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
  TenantIdSchema,
} from '../../apps/shell-super-app/shared/browser-api.ts';
import type { PeopleListResponseSchema } from '../../apps/shell-super-app/shared/people-api.ts';

export const AKROS = {
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
} as const;
const ESHOP = 'eshop@akros.demo';
const EXPEDICE = 'expedice@akros.demo';
export const EmailSchema = Schema.Literals([ESHOP, EXPEDICE]);
export type Email = typeof EmailSchema.Type;
export const EMAILS = EmailSchema.literals;
const STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const PAGE = 100;

export const FailureCodeSchema = Schema.Literals([
  'usage',
  'http_refused',
  'identity_missing',
  'identity_conflict',
  'foreign_tenant',
  'authority_missing',
  'reviewed_role_missing',
  'unsafe_permissions',
  'target_unreachable',
  'no_progress',
  'blocked',
]);
export class AkrosStaffScopeError extends Schema.TaggedError<AkrosStaffScopeError>()('AkrosStaffScopeError', {
  code: FailureCodeSchema,
  reason: Schema.String,
}) {}
const stop = (code: typeof FailureCodeSchema.Type, reason: string) => new AkrosStaffScopeError({ code, reason });

// --- the Shell session ---------------------------------------------------------------------------------

/** A refusal names the endpoint and the problem tag, never a body, cookie or password. */
const refusedAs =
  (what: string) =>
  ({ _tag }: { readonly _tag: string }) =>
    stop('http_refused', `${what}: ${_tag}`);
const checked = <A, E extends { readonly _tag: string }, R>(what: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout('60 seconds'), Effect.mapError(refusedAs(what)));

/** One cookie session per login: the generated Shell clients over a private cookie jar, closed on exit. */
export const openSession = (origin: string) =>
  Effect.gen(function* session() {
    const http = yield* HttpClient.HttpClient;
    const cookies = yield* Ref.make(Cookies.empty);
    const baseUrl = `${origin}${shellAuthenticationApiContract.apiPrefix}`;
    const client = http.pipe(
      HttpClient.withCookiesRef(cookies),
      HttpClient.mapRequest(HttpClientRequest.setHeader('origin', origin)),
    );
    const options = { baseUrl, transformClient: () => client };
    const shell = yield* makeEffectHttpApiClient(ShellAuthenticationApi, options);
    const access = yield* makeEffectHttpApiClient(AccessAdministrationApi, options);
    yield* Effect.addFinalizer(() => shell.authentication.signOut({}).pipe(Effect.ignore));
    return { access, baseUrl, client, shell };
  });
type Session = Effect.Success<ReturnType<typeof openSession>>;

const signIn = (session: Session, email: string, password: Redacted.Redacted) =>
  checked('sign-in', session.shell.authentication.signIn({ payload: { email, password } })).pipe(
    Effect.filterOrFail(
      ({ identity }) => identity.email.toLowerCase() === email.toLowerCase(),
      () => stop('identity_missing', `sign-in answered for another login than ${email}`),
    ),
  );

const tenantsOf = (session: Session) =>
  checked('tenants', session.shell.tenants.availableTenants({})).pipe(
    Effect.map(({ tenants }) => tenants.map(({ tenantId }) => String(tenantId))),
  );

/** Selects the tenant for this session only and answers the Principal the login resolves to there. */
const identityIn = Effect.fn('AkrosStaffScope.identityIn')(function* identityIn(session: Session, tenantId: string) {
  const switched = yield* checked(
    'tenant switch',
    session.shell.tenants.switchTenant({ payload: { tenantId: TenantIdSchema.make(tenantId) } }),
  );
  if (String(switched.selectedTenantId) !== tenantId) {
    return yield* stop('target_unreachable', 'tenant switch selected another tenant');
  }
  const current = yield* checked('session', session.shell.authentication.currentSession({}));
  if (current.state === 'anonymous' || String(current.identity.tenantId) !== tenantId) {
    return yield* stop('identity_missing', `the session resolves no identity in tenant ${tenantId}`);
  }
  return String(current.identity.principalId);
});

const selectSeller = Effect.fn('AkrosStaffScope.selectSeller')(function* selectSeller(session: Session) {
  const entities = yield* checked('legal entities', session.shell.legalEntities.availableLegalEntities({}));
  if (!entities.legalEntities.some(({ legalEntityId }) => String(legalEntityId) === AKROS.legalEntityId)) {
    return false;
  }
  if (String(entities.selectedLegalEntityId) !== AKROS.legalEntityId) {
    yield* checked(
      'select AKROS seller',
      session.shell.legalEntities.switchLegalEntity({
        payload: { legalEntityId: LegalEntityIdSchema.make(AKROS.legalEntityId) },
      }),
    );
  }
  return true;
});

// --- observation ---------------------------------------------------------------------------------------

export interface AccountObservation {
  readonly email: Email;
  /** The Principal the login resolves in AKROS through its own `better_auth` staff binding. */
  readonly principalId: string;
  readonly sellerSelectable: boolean;
  readonly tenants: readonly string[];
}

/** Proves through the login's own session that it signs in to AKROS and nowhere else, and reads its Principal. */
export const observeAccount = Effect.fn('AkrosStaffScope.observeAccount')(function* observeAccount(
  session: Session,
  email: Email,
) {
  const tenants = yield* tenantsOf(session);
  if (!tenants.includes(AKROS.tenantId)) {
    return yield* stop(
      'identity_missing',
      `${email} resolves no AKROS Principal; the stage accounts bootstrap attaches it (attachedLogins)`,
    );
  }
  if (tenants.length !== 1) {
    return yield* stop(
      'foreign_tenant',
      `${email} still signs in to another tenant than AKROS; the stage accounts bootstrap retires it (retiredPrincipals)`,
    );
  }
  const principalId = yield* identityIn(session, AKROS.tenantId);
  const sellerSelectable = yield* selectSeller(session);
  return { email, principalId, sellerSelectable, tenants } satisfies AccountObservation;
});

type Directory = (typeof PeopleListResponseSchema.Type)['items'];
type People = (typeof ListAccessPeopleResponseSchema.Type)['items'];
type Roles = (typeof ListAccessRolesResponseSchema.Type)['items'];
export interface TargetObservation {
  readonly catalog: (typeof ListAccessRoleTemplatesResponseSchema.Type)['entries'];
  readonly directory: Directory;
  readonly people: People;
  readonly revision: string;
  readonly roles: Roles;
  readonly writeAvailability: (typeof ListAccessPeopleOptionsResponseSchema.Type)['writeAvailability'];
}

/** The administrator's session, in the AKROS tenant with the AKROS seller selected. */
export const openAdmin = Effect.fn('AkrosStaffScope.openAdmin')(function* openAdmin(
  origin: string,
  email: string,
  password: Redacted.Redacted,
) {
  const session = yield* openSession(origin);
  yield* signIn(session, email, password);
  if (!(yield* tenantsOf(session)).includes(AKROS.tenantId)) {
    return yield* stop('authority_missing', 'the administrator login has no AKROS tenant');
  }
  yield* identityIn(session, AKROS.tenantId);
  if (!(yield* selectSeller(session))) {
    return yield* stop('authority_missing', 'the administrator cannot select the AKROS seller');
  }
  return session;
});

const cursorPage = (cursor: Option.Option<string>) =>
  Option.match(cursor, { onNone: () => ({ limit: PAGE }), onSome: (next) => ({ cursor: next, limit: PAGE }) });

const allPages = <Item, E>(
  read: (
    cursor: Option.Option<string>,
  ) => Effect.Effect<{ readonly items: readonly Item[]; readonly nextCursor: string | null }, E>,
  cursor: Option.Option<string> = Option.none(),
): Effect.Effect<readonly Item[], E> =>
  read(cursor).pipe(
    Effect.flatMap((page) =>
      page.nextCursor === null
        ? Effect.succeed(page.items)
        : allPages(read, Option.some(page.nextCursor)).pipe(Effect.map((rest) => [...page.items, ...rest])),
    ),
  );

const directoryPage = (admin: Session, offset: number) =>
  checked(
    'company directory',
    admin.shell.peopleAdministration.listCompanyPeople({ payload: { limit: PAGE, offset } }),
  ).pipe(
    Effect.filterOrFail(
      (page) =>
        Match.value(page.scope).pipe(
          Match.tag('company', ({ legalEntityId }) => legalEntityId === AKROS.legalEntityId),
          Match.orElse(() => false),
        ),
      () => stop('target_unreachable', 'the company directory answered for another company than AKROS'),
    ),
  );

const directoryFrom = (admin: Session, offset: number): Effect.Effect<Directory, AkrosStaffScopeError> =>
  directoryPage(admin, offset).pipe(
    Effect.flatMap((page) =>
      page.nextOffset === null
        ? Effect.succeed(page.items)
        : directoryFrom(admin, page.nextOffset).pipe(Effect.map((rest) => [...page.items, ...rest])),
    ),
  );

export const observeTarget = Effect.fn('AkrosStaffScope.observeTarget')(function* observeTarget(admin: Session) {
  const directory = yield* directoryFrom(admin, 0);
  const revisions = yield* Ref.make<ReadonlySet<string>>(new Set());
  const people = yield* allPages((cursor) =>
    checked('people/list', admin.access.accessAdminPeople.listAccessPeople({ payload: cursorPage(cursor) })).pipe(
      Effect.tap(({ revision }) => Ref.update(revisions, (seen) => new Set([...seen, String(revision)]))),
    ),
  );
  const options = yield* checked(
    'people/options',
    admin.access.accessAdminPeople.listAccessPeopleOptions({ payload: { limit: PAGE } }),
  );
  if ([...(yield* Ref.get(revisions))].some((revision) => revision !== String(options.revision))) {
    return yield* stop('no_progress', 'People changed while it was read; run again');
  }
  const roles = yield* allPages((cursor) =>
    checked('roles/list', admin.access.accessAdminRoles.listAccessRoles({ payload: cursorPage(cursor) })),
  );
  const templates = yield* checked(
    'roles/templates',
    admin.access.accessAdminRoles.listAccessRoleTemplates({ payload: { limit: PAGE } }),
  );
  return {
    catalog: templates.entries,
    directory,
    people,
    revision: String(options.revision),
    roles,
    writeAvailability: options.writeAvailability,
  } satisfies TargetObservation;
});

// --- planning ------------------------------------------------------------------------------------------

export interface RoleChoice {
  readonly [ESHOP]: Option.Option<string>;
  readonly [EXPEDICE]: Option.Option<string>;
  readonly routing: Option.Option<string>;
}
type Holder = Email | 'routing';
export const ScopeKindSchema = Schema.Literals(['company', 'tenant']);
type ScopeKind = typeof ScopeKindSchema.Type;
const sameScope = (scope: { readonly kind: string; readonly legalEntityId?: string }, kind: ScopeKind) =>
  scope.kind === kind && (kind === 'tenant' || scope.legalEntityId === AKROS.legalEntityId);

export const IdempotencyKeySchema = Schema.String.pipe(Schema.brand('AkrosStaffScopeIdempotencyKey'));
const stepBase = { email: EmailSchema, idempotencyKey: IdempotencyKeySchema, principalId: AccessHumanIdSchema };
export const StepSchema = Schema.Union([
  Schema.TaggedStruct('CompanyMembership', {
    ...stepBase,
    affiliation: Schema.Literals(['employee', 'external']),
    expectedRevision: Schema.Int,
  }),
  Schema.TaggedStruct('AdmitMember', { ...stepBase, expectedRevision: Schema.String }),
  Schema.TaggedStruct('AssignRole', {
    ...stepBase,
    expectedRevision: Schema.String,
    roleId: AccessRoleIdSchema,
    roleRevisionId: AccessRoleRevisionIdSchema,
    scope: ScopeKindSchema,
  }),
]);
export type Step = typeof StepSchema.Type;
export const BlockerSchema = Schema.Struct({
  code: Schema.Literal('seller_not_selectable'),
  detail: Schema.String,
  email: EmailSchema,
});
export type Blocker = typeof BlockerSchema.Type;
interface AccountPlan {
  readonly blockers: readonly Blocker[];
  readonly steps: readonly Step[];
}

const ROUTING_CAPABILITY = 'core.shell.tenant-module-target.resolve';
const ORDER_PAGE = 'demo.merchandise.page-orders.read';
const ORDER_RECORDS = 'demo.merchandise.api-records.read';
const EXPEDITION_KEYS: ReadonlySet<string> = new Set([
  ORDER_PAGE,
  ORDER_RECORDS,
  'demo.merchandise.api-media.read',
  'demo.merchandise.order-status.change',
]);
const ESHOP_MODULES: ReadonlySet<string> = new Set([
  'demo.merchandise',
  'demo.tagging',
  'commerce.market-catalog',
  'commerce.storefront-registry',
  'commerce.customer-context',
  'party.registry',
  'work.tasks',
  'demo.workforce',
]);

const cellAllowed = (holder: Holder, key: string) =>
  Match.value(holder).pipe(
    Match.when('routing', () => key === ROUTING_CAPABILITY),
    Match.when(EXPEDICE, () => EXPEDITION_KEYS.has(key)),
    Match.orElse(
      () => ESHOP_MODULES.has(key.split('.').slice(0, 2).join('.')) && !/bootstrap|cleanup|seed|admin/u.test(key),
    ),
  );

type Cell = Roles[number]['cells'][number];
const selectsAll = (cell: Cell) =>
  Match.value(cell.selector).pipe(
    Match.tag('all', () => true),
    Match.orElse(() => false),
  );
const cellUnsafe = (target: TargetObservation, holder: Holder, cell: Cell) => {
  const entry = target.catalog.find((candidate) => candidate.capabilityKey === cell.capabilityKey);
  return (
    entry === undefined ||
    !entry.modes.includes(cell.mode) ||
    entry.kind === 'admin' ||
    entry.risk === 'critical' ||
    cell.mode !== 'run' ||
    !selectsAll(cell) ||
    cell.amountCeiling !== undefined ||
    !cellAllowed(holder, String(cell.capabilityKey))
  );
};

/** The exact reviewed role, refused unless every cell is a plain catalog-backed operational cell of its lane. */
export const reviewedRole = Effect.fn('AkrosStaffScope.reviewedRole')(function* reviewedRole(
  target: TargetObservation,
  roleId: Option.Option<string>,
  holder: Holder,
) {
  const role = target.roles.find((candidate) => Option.contains(roleId, String(candidate.id)));
  if (role === undefined) {
    const chosen = Option.getOrElse(roleId, () => '(none chosen)');
    return yield* stop('reviewed_role_missing', `no existing AKROS role ${chosen} for ${holder}; choose one by id`);
  }
  const scopeOk =
    holder === 'routing'
      ? role.scope === 'tenant'
      : role.scope === 'company' && role.legalEntityId === AKROS.legalEntityId;
  const slots = new Set(role.cells.map((cell) => `${cell.capabilityKey} ${cell.mode}`));
  if (!scopeOk || role.cells.length === 0 || slots.size !== role.cells.length) {
    return yield* stop(
      'unsafe_permissions',
      `role ${role.id} has the wrong scope for ${holder}, no cells or a repeated cell`,
    );
  }
  const unsafe = role.cells.find((cell) => cellUnsafe(target, holder, cell));
  if (unsafe !== undefined) {
    return yield* stop(
      'unsafe_permissions',
      `role ${role.id}: ${unsafe.capabilityKey} is outside what ${holder} may hold`,
    );
  }
  const keys: ReadonlySet<string> = new Set(role.cells.map(({ capabilityKey }) => String(capabilityKey)));
  if (holder !== 'routing' && (!keys.has(ORDER_PAGE) || !keys.has(ORDER_RECORDS))) {
    return yield* stop('unsafe_permissions', `role ${role.id} lacks the order page or records read`);
  }
  return role;
});

const keyOf = (...parts: readonly (number | string)[]) =>
  IdempotencyKeySchema.make(
    `akros-staff-scope:v2:${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`,
  );

interface StepFacts {
  readonly email: Email;
  readonly principalId: string;
  readonly roles: { readonly company: Roles[number]; readonly routing: Roles[number] };
  readonly target: TargetObservation;
}

/** The company directory membership comes first: admit-member requires it active. */
const directoryStep = Effect.fn('AkrosStaffScope.directoryStep')(function* directoryStep({
  email,
  principalId,
  target,
}: StepFacts) {
  const directory = target.directory.find((entry) => entry.principalRef.principalId === principalId);
  if (directory !== undefined && (directory.kind !== 'human' || directory.principalStatus !== 'active')) {
    return yield* stop('identity_conflict', `${email}: the AKROS Principal is not an active human`);
  }
  const membership = Option.fromNullishOr(directory?.selectedCompanyMembership);
  if (Option.exists(membership, ({ status }) => status === 'active')) {
    return Option.none<Step>();
  }
  if (Option.exists(membership, ({ status }) => status !== 'invited')) {
    return yield* stop('identity_conflict', `${email}: an ended AKROS company membership is not revived here`);
  }
  const expectedRevision = Option.match(membership, { onNone: () => 0, onSome: ({ revision }) => revision });
  return Option.some(
    StepSchema.members[0].make({
      affiliation: Option.getOrElse(
        Option.flatMapNullishOr(membership, ({ affiliation }) => affiliation),
        () => 'employee' as const,
      ),
      email,
      expectedRevision,
      idempotencyKey: keyOf('company-membership', principalId, expectedRevision),
      principalId: AccessHumanIdSchema.make(principalId),
    }),
  );
});

/** Tenant and company member intent, written together by admit-member. */
const admissionStep = Effect.fn('AkrosStaffScope.admissionStep')(function* admissionStep({
  email,
  principalId,
  target,
}: StepFacts) {
  const person = target.people.find((candidate) => String(candidate.principalId) === principalId);
  const memberships = (person?.memberships ?? []).filter(({ status }) => status === 'active');
  if (memberships.some(({ kind, validUntil }) => kind !== 'member' || validUntil !== null)) {
    return yield* stop(
      'unsafe_permissions',
      `${email}: AKROS ownership, administration or a time-limited membership needs review`,
    );
  }
  const inCompany = memberships.some(({ scope }) => sameScope(scope, 'company'));
  const inTenant = memberships.some(({ scope }) => sameScope(scope, 'tenant'));
  if (inCompany && inTenant) {
    return Option.none<Step>();
  }
  if (inCompany) {
    return yield* stop('identity_conflict', `${email}: company-only access intent cannot be repaired by admit-member`);
  }
  if (!target.writeAvailability.canAdmitMember) {
    return yield* stop('authority_missing', 'the administrator cannot admit members');
  }
  return Option.some(
    StepSchema.members[1].make({
      email,
      expectedRevision: target.revision,
      idempotencyKey: keyOf('admit-member', principalId, target.revision),
      principalId: AccessHumanIdSchema.make(principalId),
    }),
  );
});

/** The reviewed company role and the tenant routing role, one assignment per call; nothing else is held. */
const assignmentStep = Effect.fn('AkrosStaffScope.assignmentStep')(function* assignmentStep({
  email,
  principalId,
  roles,
  target,
}: StepFacts) {
  const person = target.people.find((candidate) => String(candidate.principalId) === principalId);
  const assignments = (person?.assignments ?? []).filter(({ status }) => status === 'active');
  const wanted = [
    { role: roles.company, scope: 'company' },
    { role: roles.routing, scope: 'tenant' },
  ] as const;
  const matches = (assignment: (typeof assignments)[number], roleId: string, scope: ScopeKind) =>
    String(assignment.roleId) === roleId && sameScope(assignment.scope, scope);
  const foreign = assignments.some(
    (assignment) =>
      assignment.validUntil !== null || !wanted.some(({ role, scope }) => matches(assignment, String(role.id), scope)),
  );
  if (foreign) {
    return yield* stop(
      'unsafe_permissions',
      `${email}: other or time-limited AKROS assignments exist; nothing is revoked or broadened`,
    );
  }
  const missing = wanted.find(
    ({ role, scope }) => !assignments.some((assignment) => matches(assignment, String(role.id), scope)),
  );
  if (missing === undefined) {
    return Option.none<Step>();
  }
  if (!target.writeAvailability.canAssign) {
    return yield* stop('authority_missing', 'the administrator cannot assign roles');
  }
  return Option.some(
    StepSchema.members[2].make({
      email,
      expectedRevision: target.revision,
      idempotencyKey: keyOf('assign-role', principalId, String(missing.role.id), missing.scope, target.revision),
      principalId: AccessHumanIdSchema.make(principalId),
      roleId: missing.role.id,
      roleRevisionId: missing.role.revisionId,
      scope: missing.scope,
    }),
  );
});

/** The next governed call for one login, or none when its access is complete. */
const nextStepOf = (facts: StepFacts): Effect.Effect<Option.Option<Step>, AkrosStaffScopeError> =>
  directoryStep(facts).pipe(
    Effect.flatMap((step) => (Option.isSome(step) ? Effect.succeed(step) : admissionStep(facts))),
    Effect.flatMap((step) => (Option.isSome(step) ? Effect.succeed(step) : assignmentStep(facts))),
  );

const accountPlan = Effect.fn('AkrosStaffScope.accountPlan')(function* accountPlan(
  account: AccountObservation,
  target: TargetObservation,
  roles: StepFacts['roles'],
): Effect.fn.Return<AccountPlan, AkrosStaffScopeError> {
  const { principalId, sellerSelectable } = account;
  const step = yield* nextStepOf({ email: account.email, principalId, roles, target });
  const blockers: readonly Blocker[] =
    Option.isNone(step) && !sellerSelectable
      ? [
          {
            code: 'seller_not_selectable',
            detail: `${account.email} holds the access but cannot select the AKROS seller yet`,
            email: account.email,
          },
        ]
      : [];
  return { blockers, steps: Option.toArray(step) };
});

/** The next governed calls and what blocks the rest. The same observation always gives the same steps. */
export const planStaffScope = Effect.fn('AkrosStaffScope.planStaffScope')(function* planStaffScope(
  accounts: readonly AccountObservation[],
  target: TargetObservation,
  choice: RoleChoice,
): Effect.fn.Return<AccountPlan, AkrosStaffScopeError> {
  const routing = yield* reviewedRole(target, choice.routing, 'routing');
  const principals = accounts.map(({ principalId }) => principalId);
  if (new Set(principals).size !== principals.length) {
    return yield* stop('identity_conflict', 'both logins resolve the same AKROS Principal');
  }
  const plans = yield* Effect.forEach(
    accounts,
    (account) =>
      reviewedRole(target, choice[account.email], account.email).pipe(
        Effect.flatMap((company) => accountPlan(account, target, { company, routing })),
      ),
    { concurrency: 1 },
  );
  return { blockers: plans.flatMap(({ blockers }) => blockers), steps: plans.flatMap(({ steps }) => steps) };
});

// --- execution -----------------------------------------------------------------------------------------

const send = (admin: Session, step: Step) =>
  Match.value(step).pipe(
    Match.tag('CompanyMembership', ({ affiliation, expectedRevision, idempotencyKey, principalId }) =>
      checked(
        step._tag,
        admin.shell.peopleAdministration.setPeopleCompanyMembership({
          headers: { 'idempotency-key': idempotencyKey },
          payload: {
            affiliation,
            expectedRevision,
            principalRef: { principalId, tenantId: AKROS.tenantId },
            reason: 'AKROS staff login works for the AKROS seller',
            status: 'active',
          },
        }),
      ),
    ),
    Match.tag('AdmitMember', ({ expectedRevision, idempotencyKey, principalId }) =>
      checked(
        step._tag,
        admin.access.accessAdminPeople.admitAccessMember({
          headers: { 'idempotency-key': idempotencyKey },
          payload: {
            expectedRevision: AccessPeopleRevisionSchema.make(expectedRevision),
            principalId,
            scope: { kind: 'company', legalEntityId: AccessCompanyIdSchema.make(AKROS.legalEntityId) },
          },
        }),
      ),
    ),
    Match.tag('AssignRole', ({ expectedRevision, idempotencyKey, principalId, roleId, roleRevisionId, scope }) =>
      checked(
        step._tag,
        admin.access.accessAdminPeople.assignAccessRole({
          headers: { 'idempotency-key': idempotencyKey },
          payload: {
            expectedRevision: AccessPeopleRevisionSchema.make(expectedRevision),
            expectedRoleRevisionId: roleRevisionId,
            principalId,
            roleId,
            scope:
              scope === 'tenant'
                ? { kind: 'tenant' }
                : { kind: 'company', legalEntityId: AccessCompanyIdSchema.make(AKROS.legalEntityId) },
          },
        }),
      ),
    ),
    Match.exhaustive,
    Effect.asVoid,
  );

export interface RunOptions {
  readonly adminEmail: string;
  readonly apply: boolean;
  readonly origin: string;
  readonly passwords: Readonly<Record<'admin' | Email, Redacted.Redacted>>;
  readonly roles: RoleChoice;
  /** How long a write that has not shown up yet is given before the next read; at most five such waits. */
  readonly settle: Duration.Input;
}

const roleSummary = (role: Roles[number]) => {
  const cells = role.cells.map(({ capabilityKey, mode }) => [capabilityKey, mode].join(' ')).join(', ');
  return `${role.id} ${role.scope} "${role.name}": ${cells}`;
};

interface Observed {
  readonly accounts: readonly AccountObservation[];
  readonly target: TargetObservation;
}
interface Converging {
  readonly admin: Session;
  readonly observe: Effect.Effect<Observed, AkrosStaffScopeError>;
  readonly options: RunOptions;
}
interface Converged {
  readonly observed: Observed;
  readonly sent: readonly Step[];
}
const MAX_WAITS = 5;

/** Send the first planned write, re-read, re-plan; wait for a write that has not shown up yet, at most five times. */
const converge = (
  run: Converging,
  observed: Observed,
  sent: readonly Step[],
  waits: number,
): Effect.Effect<Converged, AkrosStaffScopeError> =>
  planStaffScope(observed.accounts, observed.target, run.options.roles).pipe(
    Effect.flatMap(({ steps }) => {
      const [step] = steps;
      if (step === undefined) {
        return Effect.succeed({ observed, sent });
      }
      const repeated = sent.some(({ idempotencyKey }) => idempotencyKey === step.idempotencyKey);
      if (repeated && waits >= MAX_WAITS) {
        return Effect.fail(
          stop('no_progress', `${step._tag} for ${step.email} is still planned after it was accepted`),
        );
      }
      const act = repeated ? Effect.sleep(run.options.settle) : send(run.admin, step);
      const nextSent = repeated ? sent : [...sent, step];
      return act.pipe(
        Effect.andThen(run.observe),
        Effect.flatMap((next) => converge(run, next, nextSent, repeated ? waits + 1 : 0)),
      );
    }),
  );

/** Plan: read and report. Apply: one governed write at a time, re-reading stage before every decision. */
export const runAkrosStaffScope = (options: RunOptions) =>
  Effect.scoped(
    Effect.gen(function* run() {
      const admin = yield* openAdmin(options.origin, options.adminEmail, options.passwords.admin);
      const logins = yield* Effect.forEach(
        EMAILS,
        (email) =>
          openSession(options.origin).pipe(
            Effect.tap((session) => signIn(session, email, options.passwords[email])),
            Effect.map((session) => ({ email, session })),
          ),
        { concurrency: 1 },
      );
      const observe = Effect.all({
        accounts: Effect.forEach(logins, ({ email, session }) => observeAccount(session, email), { concurrency: 1 }),
        target: observeTarget(admin),
      });
      const first = yield* observe;
      if (!options.apply) {
        const plan = yield* planStaffScope(first.accounts, first.target, options.roles).pipe(Effect.option);
        return {
          accounts: first.accounts,
          blockers: Option.match(plan, { onNone: () => [], onSome: ({ blockers }) => blockers }),
          mode: 'plan' as const,
          roleCandidates: Option.isNone(plan) ? first.target.roles.map(roleSummary) : [],
          sent: [],
          steps: Option.match(plan, { onNone: (): readonly Step[] => [], onSome: ({ steps }) => steps }),
        };
      }
      const done = yield* converge({ admin, observe, options }, first, [], 0);
      const { blockers } = yield* planStaffScope(done.observed.accounts, done.observed.target, options.roles);
      return {
        accounts: done.observed.accounts,
        blockers,
        mode: 'apply' as const,
        roleCandidates: [],
        sent: done.sent,
        steps: [],
      };
    }),
  );

// --- the command ---------------------------------------------------------------------------------------

/** Only the stage origin over HTTPS or a loopback origin, without credentials, path, query or fragment. */
export const validateShellUrl = (raw: string) => {
  const url = URL.parse(raw);
  const plain =
    url !== null &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname === '/';
  const allowed = url !== null && (url.origin === STAGE_ORIGIN || LOOPBACK_HOSTS.has(url.hostname));
  return plain && allowed
    ? Effect.succeed(url.origin)
    : Effect.fail(stop('usage', `--shell-url must be ${STAGE_ORIGIN} or a localhost origin`));
};

const SecretSchema = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1)));
export const PasswordsSchema = Schema.fromJsonString(
  Schema.Struct({ admin: SecretSchema, 'eshop@akros.demo': SecretSchema, 'expedice@akros.demo': SecretSchema }),
);

/** The passwords JSON, from a pipe only: an interactive terminal would echo it. */
const readPasswords = Effect.gen(function* passwordsFromStdin() {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* stop('usage', 'pipe the passwords JSON into stdin; it is never read from a terminal, argv or env');
  }
  const text = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError(() => stop('usage', 'stdin could not be read')),
  );
  return yield* Schema.decodeUnknownEffect(PasswordsSchema)(text.trim()).pipe(
    Effect.mapError(() => stop('usage', `stdin must be JSON with passwords for admin, ${EMAILS.join(', ')}`)),
  );
});

const report = (result: Effect.Success<ReturnType<typeof runAkrosStaffScope>>) =>
  Effect.forEach(
    [
      `mode: ${result.mode}`,
      ...result.accounts.map(
        ({ email, principalId, sellerSelectable }) =>
          `${email}: AKROS only, Principal ${principalId}; seller selectable ${sellerSelectable}`,
      ),
      ...result.steps.map((step) => `would send ${step._tag} for ${step.email} (${step.idempotencyKey})`),
      ...result.sent.map((step) => `sent ${step._tag} for ${step.email} (${step.idempotencyKey})`),
      ...result.roleCandidates.map((role) => `role candidate ${role}`),
      ...result.blockers.map(({ code, detail }) => `blocked ${code}: ${detail}`),
    ],
    (line) => Console.log(line),
    { concurrency: 1, discard: true },
  );

export const akrosStaffScopeCommand = Command.make(
  'akros-staff-scope',
  {
    adminEmail: Flag.String('admin-email'),
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    eshopRole: Flag.String('eshop-role').pipe(Flag.optional),
    expediceRole: Flag.String('expedice-role').pipe(Flag.optional),
    routingRole: Flag.String('routing-role').pipe(Flag.optional),
    shellUrl: Flag.String('shell-url'),
  },
  (flags) =>
    Effect.gen(function* main() {
      const origin = yield* validateShellUrl(flags.shellUrl);
      const passwords = yield* readPasswords;
      const result = yield* runAkrosStaffScope({
        adminEmail: flags.adminEmail,
        apply: flags.apply,
        origin,
        passwords,
        roles: {
          'eshop@akros.demo': flags.eshopRole,
          'expedice@akros.demo': flags.expediceRole,
          routing: flags.routingRole,
        },
        settle: Duration.seconds(2),
      });
      yield* report(result);
      if (result.blockers.length > 0) {
        return yield* stop('blocked', `${result.blockers.length} login(s) are blocked`);
      }
      return result.mode;
    }),
);

export const exitCodeOf = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.match(exit, {
    onFailure: (cause) =>
      Option.match(Option.filter(Cause.findErrorOption(cause), Schema.is(AkrosStaffScopeError)), {
        onNone: () => 1,
        onSome: ({ code }) => (code === 'blocked' ? 3 : 1),
      }),
    onSuccess: () => 0,
  });

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(akrosStaffScopeCommand, { version: '1.0.0' }).pipe(
      Effect.tapError((error) =>
        Schema.is(AkrosStaffScopeError)(error) ? Console.error(`stopped ${error.code}: ${error.reason}`) : Effect.void,
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = exitCodeOf(exit);
}
