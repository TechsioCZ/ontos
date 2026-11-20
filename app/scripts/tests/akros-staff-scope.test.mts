import { Effect, Exit, Layer, Match, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  AKROS,
  PasswordsSchema,
  runAkrosStaffScope,
  ScopeKindSchema,
  validateShellUrl,
} from '../demo/akros-staff-scope.mts';
import type { RoleChoice, RunOptions } from '../demo/akros-staff-scope.mts';
import { AccessHumanIdSchema, AccessRoleIdSchema } from '../../apps/shell-super-app/shared/access-admin-api.ts';
import { TenantIdSchema } from '../../apps/shell-super-app/shared/browser-api.ts';

const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORIGIN = 'https://ontos-stage.web-revolution.cz';
const FORMER_TENANT = '70000000-0000-4000-8000-000000000020';
const API = '/shell-super-app-api';
const ADMIN = 'admin@akros.playground';
const ESHOP = 'eshop@akros.demo';
const EXPEDICE = 'expedice@akros.demo';
const ADMIN_PRINCIPAL = id(1);
const SECRETS = { admin: 'admin-secret-1', [ESHOP]: 'eshop-secret-1', [EXPEDICE]: 'expedice-secret-1' } as const;
const ESHOP_ROLE = id(901);
const EXPEDICE_ROLE = id(902);
const ROUTING_ROLE = id(903);
const at = '2026-11-19T12:00:00.000Z';
const ORDER_PAGE = 'demo.merchandise.page-orders.read';
const ORDER_RECORDS = 'demo.merchandise.api-records.read';
const ROUTING = 'core.shell.tenant-module-target.resolve';
const ORDER_STATUS = 'demo.merchandise.order-status.change';
const TASK_READ = 'work.tasks.task.read';
const ASSIGN = '/shell/access/people/assign';
const ADMIT = '/shell/access/people/admit-member';
const MEMBERSHIP = '/auth/identity/people/company-membership';
const OTHER_COMPANY = id(950);

type ScopeKind = typeof ScopeKindSchema.Type;
interface Person {
  assignments: { readonly roleId: string; readonly scope: ScopeKind }[];
  directory: Option.Option<{ readonly revision: number; readonly status: string }>;
  memberships: { readonly kind: string; readonly scope: ScopeKind }[];
}
interface Login {
  readonly password: string;
  readonly tenants: Map<string, string>;
}
interface Write {
  readonly key: string;
  readonly path: string;
  readonly principalId: string;
  readonly scope: string;
}
type Json = typeof Schema.Json.Type;

const COMPANY: ScopeKind = 'company';
const TENANT: ScopeKind = 'tenant';
const SIGN_IN = '/auth/sign-in';
const scopeOf = (kind: ScopeKind): Json => (kind === TENANT ? { kind } : { kind, legalEntityId: AKROS.legalEntityId });
const cell = (capabilityKey: string) => ({ capabilityKey, mode: 'run', selector: { _tag: 'all' } });
const entry = (capabilityKey: string, kind = 'read', risk = 'routine') => ({
  capabilityKey,
  kind,
  modes: ['run'],
  moduleKey: capabilityKey.split('.').slice(0, 2).join('.'),
  placement: { group: 'g', level: 'basic' },
  risk,
  selectors: ['all'],
});
const roleBase = (roleId: string, keys: readonly string[]) => ({
  catalogSnapshotId: id(800),
  cells: keys.map(cell),
  holderCount: 0,
  id: roleId,
  name: `role ${roleId.slice(-3)}`,
  provenance: 'manual',
  revision: 1,
  revisionId: id(Number(roleId.slice(-3)) + 100),
});
const companyRole = (roleId: string, keys: readonly string[]) => ({
  ...roleBase(roleId, keys),
  legalEntityId: AKROS.legalEntityId,
  scope: COMPANY,
});
const tenantRole = (roleId: string, keys: readonly string[]) => ({ ...roleBase(roleId, keys), scope: TENANT });
const reviewedRoles = [
  companyRole(ESHOP_ROLE, [ORDER_PAGE, ORDER_RECORDS, TASK_READ]),
  companyRole(EXPEDICE_ROLE, [ORDER_PAGE, ORDER_RECORDS, ORDER_STATUS]),
  tenantRole(ROUTING_ROLE, [ROUTING]),
];
const catalog = [
  entry(ORDER_PAGE),
  entry(ORDER_RECORDS),
  entry(ORDER_STATUS, 'action'),
  entry(TASK_READ),
  entry(ROUTING),
  entry('core.access.people.manage', 'admin', 'critical'),
];

const SignInBody = Schema.fromJsonString(Schema.Struct({ email: Schema.String, password: Schema.String }));
const TenantBody = Schema.fromJsonString(Schema.Struct({ tenantId: TenantIdSchema }));
const MembershipBody = Schema.fromJsonString(
  Schema.Struct({ principalRef: Schema.Struct({ principalId: AccessHumanIdSchema }), status: Schema.String }),
);
const AdmitBody = Schema.fromJsonString(
  Schema.Struct({ expectedRevision: Schema.String, principalId: AccessHumanIdSchema }),
);
const AssignBody = Schema.fromJsonString(
  Schema.Struct({
    expectedRevision: Schema.String,
    principalId: AccessHumanIdSchema,
    roleId: AccessRoleIdSchema,
    scope: Schema.Struct({ kind: ScopeKindSchema }),
  }),
);
const textOf = (request: HttpClientRequest.HttpClientRequest) =>
  Match.value(request.body).pipe(
    Match.tag('Uint8Array', ({ body }) => new TextDecoder().decode(body)),
    Match.orElse(() => ''),
  );
const answer = (
  request: HttpClientRequest.HttpClientRequest,
  body: Json,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
) => HttpClientResponse.fromWeb(request, Response.json(body, { headers, status }));
const problem = (request: HttpClientRequest.HttpClientRequest, status: number, tag: string) =>
  answer(request, { _tag: tag, detail: tag, status, title: tag, type: 'https://ontos.dev/problems/test' }, status);

interface ShellSettings {
  /** The stage accounts bootstrap attached both logins to AKROS. */
  readonly bound?: boolean;
  /** A write the Shell accepts but never records, so the next read still plans it. */
  readonly lossyPath?: string;
  /** Another company of the tenant the administrator, or each staff login, may also select. */
  readonly otherCompanyFor?: 'admin' | 'staff';
  /** The bootstrap has not retired the logins' former demo-tenant Principals yet. */
  readonly retained?: boolean;
  readonly roles?: readonly Json[];
  /** The Shell answers a seller switch with another company than the one asked for. */
  readonly switchesElsewhere?: boolean;
}
interface FakeState {
  readonly bodies: string[];
  readonly logins: Map<string, Login>;
  readonly paths: string[];
  readonly people: Map<string, Person>;
  readonly revision: { value: number };
  readonly sessions: Map<string, { readonly email: string; tenantId: string }>;
  readonly settings: ShellSettings;
  readonly writes: Write[];
}
interface Call {
  readonly login: Login;
  readonly me: string;
  readonly path: string;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly session: { readonly email: string; tenantId: string };
  readonly state: FakeState;
  readonly text: string;
  readonly token: string;
}
type Handler = (call: Call) => Effect.Effect<HttpClientResponse.HttpClientResponse>;

const keyOf = (request: HttpClientRequest.HttpClientRequest) => request.headers['idempotency-key'] ?? '';
const isStale = (state: FakeState, expected: string) => expected !== String(state.revision.value);
const seller = ({ me, session, state }: Call) =>
  session.tenantId === AKROS.tenantId &&
  (me === ADMIN_PRINCIPAL ||
    Option.exists(Option.fromNullishOr(state.people.get(me)), ({ memberships }) =>
      memberships.some(({ scope }) => scope === COMPANY),
    ));
const directoryItem = ([principalId, person]: readonly [string, Person]): Json => ({
  displayName: principalId,
  invitationDelivery: null,
  kind: 'human',
  principalRef: { principalId, tenantId: AKROS.tenantId },
  principalStatus: 'active',
  selectedCompanyMembership: Option.match(person.directory, {
    onNone: () => null,
    onSome: ({ revision, status }) => ({
      affiliation: 'employee',
      legalEntityId: AKROS.legalEntityId,
      principalRef: { principalId, tenantId: AKROS.tenantId },
      revision,
      status,
    }),
  }),
});
const accessPerson = ([principalId, person]: readonly [string, Person], index: number): Json => ({
  assignments: person.assignments.map(({ roleId, scope }, n) => ({
    incarnationId: id(500 + index * 10 + n),
    principalId,
    roleId,
    roleName: 'r',
    scope: scopeOf(scope),
    status: 'active',
    validFrom: at,
    validUntil: null,
  })),
  delegations: [],
  displayName: principalId,
  memberships: person.memberships.map(({ kind, scope }, n) => ({
    kind,
    membershipId: id(600 + index * 10 + n),
    scope: scopeOf(scope),
    status: 'active',
    validFrom: at,
    validUntil: null,
  })),
  ownership: { administersScopes: [], soleAdministratorScopes: [] },
  principalId,
  suspended: false,
  teams: [],
});
const writeAvailability = {
  canAdmitMember: true,
  canAssign: true,
  canDelegate: false,
  canEndMembership: true,
  canManageTeams: false,
  canRevokeDelegation: false,
  canTransferOwnership: false,
  canUnassign: true,
};

const routes = new Map<string, Handler>([
  [
    ADMIT,
    ({ path, request, state, text }) =>
      Effect.gen(function* admit() {
        const { expectedRevision, principalId } = yield* Schema.decodeUnknownEffect(AdmitBody)(text).pipe(Effect.orDie);
        state.writes.push({ key: keyOf(request), path, principalId, scope: COMPANY });
        const person = state.people.get(principalId);
        if (isStale(state, expectedRevision) || person === undefined) {
          return problem(request, 409, 'AccessAdminConflictProblem');
        }
        person.memberships.push({ kind: 'member', scope: TENANT }, { kind: 'member', scope: COMPANY });
        state.revision.value += 1;
        return answer(request, { revision: String(state.revision.value) });
      }),
  ],
  [
    ASSIGN,
    ({ path, request, state, text }) =>
      Effect.gen(function* assign() {
        const assigned = yield* Schema.decodeUnknownEffect(AssignBody)(text).pipe(Effect.orDie);
        state.writes.push({ key: keyOf(request), path, principalId: assigned.principalId, scope: assigned.scope.kind });
        const person = state.people.get(assigned.principalId);
        if (isStale(state, assigned.expectedRevision) || person === undefined) {
          return problem(request, 409, 'AccessAdminConflictProblem');
        }
        person.assignments.push({ roleId: assigned.roleId, scope: assigned.scope.kind });
        state.revision.value += 1;
        return answer(request, { revision: String(state.revision.value) });
      }),
  ],
  [
    '/auth/identity/people/list',
    ({ request, state }) =>
      Effect.succeed(
        answer(request, {
          items: [...state.people].map(directoryItem),
          nextOffset: null,
          scope: { _tag: COMPANY, legalEntityId: AKROS.legalEntityId },
          tenantId: AKROS.tenantId,
        }),
      ),
  ],
  [
    '/auth/legal-entities',
    (call) =>
      Effect.succeed(
        answer(call.request, {
          legalEntities: [
            ...(seller(call) ? [{ legalEntityId: AKROS.legalEntityId, legalName: 'AKROS' }] : []),
            ...(call.state.settings.otherCompanyFor === (call.me === ADMIN_PRINCIPAL ? 'admin' : 'staff')
              ? [{ legalEntityId: OTHER_COMPANY, legalName: 'Other seller' }]
              : []),
          ],
          state: 'selection_required',
          tenantContextAvailable: true,
        }),
      ),
  ],
  [
    '/auth/legal-entity/switch',
    ({ request, state }) =>
      Effect.succeed(
        answer(request, {
          selectedLegalEntityId: state.settings.switchesElsewhere === true ? OTHER_COMPANY : AKROS.legalEntityId,
        }),
      ),
  ],
  [
    '/auth/session',
    ({ me, request, session }) =>
      Effect.succeed(
        answer(request, {
          availableLegalEntities: [],
          identity: { displayName: session.email, email: session.email, principalId: me, tenantId: session.tenantId },
          state: 'selection_required',
        }),
      ),
  ],
  [
    '/auth/sign-out',
    ({ request, state, token }) =>
      Effect.sync(() => {
        state.sessions.delete(token);
        return answer(request, { signedOut: true });
      }),
  ],
  [
    '/auth/tenant/switch',
    ({ request, session, text }) =>
      Schema.decodeUnknownEffect(TenantBody)(text).pipe(
        Effect.orDie,
        Effect.map(({ tenantId }) => {
          session.tenantId = tenantId;
          return answer(request, { selectedTenantId: tenantId });
        }),
      ),
  ],
  [
    '/auth/tenants',
    ({ login, request }) =>
      Effect.succeed(
        answer(request, { tenants: [...login.tenants.keys()].map((tenantId) => ({ name: tenantId, tenantId })) }),
      ),
  ],
  [
    '/shell/access/people/list',
    ({ request, state }) =>
      Effect.succeed(
        answer(request, {
          items: [...state.people].map(accessPerson),
          nextCursor: null,
          revision: String(state.revision.value),
        }),
      ),
  ],
  [
    '/shell/access/people/options',
    ({ request, state }) =>
      Effect.succeed(
        answer(request, {
          admissionCandidates: [],
          capabilities: [],
          managers: [],
          people: [],
          revision: String(state.revision.value),
          roles: [],
          scopes: [],
          teams: [],
          writeAvailability,
        }),
      ),
  ],
  [
    '/shell/access/roles/list',
    ({ request, state }) =>
      Effect.succeed(answer(request, { items: state.settings.roles ?? reviewedRoles, nextCursor: null })),
  ],
  [
    '/shell/access/roles/templates',
    ({ request }) =>
      Effect.succeed(
        answer(request, {
          catalogSnapshotId: id(800),
          createAvailable: true,
          entries: catalog,
          publishedAt: at,
          saveAvailable: true,
          templates: [],
        }),
      ),
  ],
  [
    MEMBERSHIP,
    ({ path, request, state, text }) =>
      Effect.gen(function* membership() {
        const { principalRef, status } = yield* Schema.decodeUnknownEffect(MembershipBody)(text).pipe(Effect.orDie);
        state.writes.push({ key: keyOf(request), path, principalId: principalRef.principalId, scope: '' });
        const person = state.people.get(principalRef.principalId);
        if (person !== undefined && state.settings.lossyPath !== path) {
          person.directory = Option.some({ revision: 2, status });
        }
        return answer(request, {
          membership: {
            affiliation: 'employee',
            legalEntityId: AKROS.legalEntityId,
            principalRef: { principalId: principalRef.principalId, tenantId: AKROS.tenantId },
            revision: 2,
            status,
          },
          projection: 'pending',
        });
      }),
  ],
]);

const signInRoute = (state: FakeState, request: HttpClientRequest.HttpClientRequest, text: string) =>
  Schema.decodeUnknownEffect(SignInBody)(text).pipe(
    Effect.orDie,
    Effect.map(({ email, password }) => {
      const login = state.logins.get(email);
      const [tenantId] = login === undefined ? [] : [...login.tenants.keys()];
      if (login === undefined || login.password !== password || tenantId === undefined) {
        return problem(request, 401, 'InvalidCredentialsProblem');
      }
      const token = `t${state.sessions.size}`;
      state.sessions.set(token, { email, tenantId });
      return answer(
        request,
        { identity: { displayName: email, email, principalId: login.tenants.get(tenantId) ?? '', tenantId } },
        200,
        { 'set-cookie': `ontos.session=${token}; Path=/; HttpOnly` },
      );
    }),
  );

const loginsOf = (bound: boolean, retained: boolean) => {
  const eshop = new Map<string, string>(retained ? [[FORMER_TENANT, id(31)]] : []);
  const expedice = new Map<string, string>(retained ? [[FORMER_TENANT, id(32)]] : []);
  if (bound) {
    eshop.set(AKROS.tenantId, id(11));
    expedice.set(AKROS.tenantId, id(12));
  }
  return new Map<string, Login>([
    [ADMIN, { password: SECRETS.admin, tenants: new Map([[AKROS.tenantId, ADMIN_PRINCIPAL]]) }],
    [ESHOP, { password: SECRETS[ESHOP], tenants: eshop }],
    [EXPEDICE, { password: SECRETS[EXPEDICE], tenants: expedice }],
  ]);
};

/** A small Shell with the real endpoint shapes: sign-in, tenants, people, roles and the three writes. */
const fakeShell = (settings: ShellSettings = {}) => {
  const bound = settings.bound ?? true;
  const people = new Map<string, Person>([
    [
      ADMIN_PRINCIPAL,
      {
        assignments: [],
        directory: Option.some({ revision: 1, status: 'active' }),
        memberships: [{ kind: 'owner', scope: TENANT }],
      },
    ],
  ]);
  for (const principalId of bound ? [id(11), id(12)] : []) {
    people.set(principalId, { assignments: [], directory: Option.none(), memberships: [] });
  }
  const state: FakeState = {
    bodies: [],
    logins: loginsOf(bound, settings.retained ?? false),
    paths: [],
    people,
    revision: { value: 1 },
    sessions: new Map(),
    settings,
    writes: [],
  };
  const http = HttpClient.make((request, url) => {
    const path = url.pathname.replace(API, '');
    const text = textOf(request);
    state.paths.push(path);
    state.bodies.push(text);
    if (path === SIGN_IN) {
      return signInRoute(state, request, text);
    }
    const token = /ontos.session=(?<token>[^;]+)/u.exec(request.headers.cookie ?? '')?.groups?.token ?? '';
    const session = state.sessions.get(token);
    const login = session === undefined ? undefined : state.logins.get(session.email);
    const route = routes.get(path);
    if (session === undefined || login === undefined || route === undefined) {
      return Effect.succeed(problem(request, 401, 'AuthenticationRequiredProblem'));
    }
    return route({ login, me: login.tenants.get(session.tenantId) ?? '', path, request, session, state, text, token });
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, http), ...state };
};

const chosen: RoleChoice = {
  [ESHOP]: Option.some(ESHOP_ROLE),
  [EXPEDICE]: Option.some(EXPEDICE_ROLE),
  routing: Option.some(ROUTING_ROLE),
};
const options = (apply: boolean, overrides: Partial<RunOptions> = {}): RunOptions => ({
  adminEmail: ADMIN,
  apply,
  origin: ORIGIN,
  passwords: {
    admin: Redacted.make(SECRETS.admin),
    [ESHOP]: Redacted.make(SECRETS[ESHOP]),
    [EXPEDICE]: Redacted.make(SECRETS[EXPEDICE]),
  },
  roles: chosen,
  settle: 0,
  ...overrides,
});
const runWith = (shell: ReturnType<typeof fakeShell>, apply: boolean, overrides: Partial<RunOptions> = {}) =>
  runAkrosStaffScope(options(apply, overrides)).pipe(Effect.provide(shell.layer));
const failureOf = (shell: ReturnType<typeof fakeShell>, apply: boolean, overrides: Partial<RunOptions> = {}) =>
  runWith(shell, apply, overrides).pipe(Effect.flip);

it.effect('apply drives the AKROS-only exact logins to AKROS seller access through governed calls only', () =>
  Effect.gen(function* applies() {
    const shell = fakeShell();
    const result = yield* runWith(shell, true);
    expect(result.blockers).toEqual([]);
    expect(shell.writes.map(({ path, principalId, scope }) => [path, principalId, scope].join(' '))).toEqual([
      [MEMBERSHIP, id(11), ''].join(' '),
      [ADMIT, id(11), 'company'].join(' '),
      [ASSIGN, id(11), 'company'].join(' '),
      [ASSIGN, id(11), 'tenant'].join(' '),
      [MEMBERSHIP, id(12), ''].join(' '),
      [ADMIT, id(12), 'company'].join(' '),
      [ASSIGN, id(12), 'company'].join(' '),
      [ASSIGN, id(12), 'tenant'].join(' '),
    ]);
    expect(shell.writes.every(({ key }) => key.startsWith('akros-staff-scope:v2:'))).toBe(true);
    expect(new Set(shell.writes.map(({ key }) => key)).size).toBe(shell.writes.length);
    expect(
      shell.people
        .get(id(11))
        ?.assignments.map(({ roleId }) => roleId)
        .toSorted(),
    ).toEqual([ESHOP_ROLE, ROUTING_ROLE].toSorted());
    expect(
      shell.people
        .get(id(12))
        ?.assignments.map(({ roleId }) => roleId)
        .toSorted(),
    ).toEqual([EXPEDICE_ROLE, ROUTING_ROLE].toSorted());
    expect(
      result.accounts.map(({ principalId, sellerSelectable, tenants }) => [principalId, sellerSelectable, tenants]),
    ).toEqual([
      [id(11), true, [AKROS.tenantId]],
      [id(12), true, [AKROS.tenantId]],
    ]);
    expect(shell.paths.filter((path) => path === SIGN_IN)).toHaveLength(3);
    const again = yield* runWith(shell, true);
    expect(again.sent).toEqual([]);
    expect(shell.writes).toHaveLength(8);
  }),
);

it.effect('plan only reads, lists the first calls and never sends a secret anywhere but sign-in', () =>
  Effect.gen(function* plans() {
    const shell = fakeShell();
    const result = yield* runWith(shell, false);
    expect(shell.writes).toEqual([]);
    expect(result.steps.map(({ _tag, email }) => [_tag, email].join(' '))).toEqual([
      ['CompanyMembership', ESHOP].join(' '),
      ['CompanyMembership', EXPEDICE].join(' '),
    ]);
    const leaked = shell.bodies.filter((_body, index) => shell.paths[index] !== SIGN_IN);
    expect(Object.values(SECRETS).some((secret) => leaked.some((body) => body.includes(secret)))).toBe(false);
  }),
);

it.effect('without chosen roles the plan lists existing roles and plans no write, guessing nothing', () =>
  Effect.gen(function* lists() {
    const shell = fakeShell();
    const result = yield* runWith(shell, false, {
      roles: { [ESHOP]: Option.none(), [EXPEDICE]: Option.none(), routing: Option.none() },
    });
    expect(result.roleCandidates).toHaveLength(3);
    expect(result.steps).toEqual([]);
    expect(shell.writes).toEqual([]);
  }),
);

it.effect(
  'a login the bootstrap has not attached, or that still signs in to its former tenant, stops before any write',
  () =>
    Effect.gen(function* refusesUnmovedLogins() {
      const unattached = fakeShell({ bound: false, retained: true });
      const missing = yield* failureOf(unattached, true);
      expect([missing.code, missing.reason.includes('attachedLogins')]).toEqual(['identity_missing', true]);
      expect(unattached.writes).toEqual([]);
      const retained = fakeShell({ retained: true });
      const foreign = yield* failureOf(retained, false);
      expect([foreign.code, foreign.reason.includes('retiredPrincipals')]).toEqual(['foreign_tenant', true]);
      expect((yield* failureOf(retained, true)).code).toBe('foreign_tenant');
      expect(retained.writes).toEqual([]);
    }),
);

it.effect(
  'roles are exact, reviewed and narrow: missing, administrative or out-of-lane cells stop before any write',
  () =>
    Effect.gen(function* refuses() {
      const missing = yield* failureOf(fakeShell(), true, { roles: { ...chosen, routing: Option.some(id(999)) } });
      expect(missing.code).toBe('reviewed_role_missing');
      const administrative = fakeShell({
        roles: [
          companyRole(ESHOP_ROLE, [ORDER_PAGE, ORDER_RECORDS, 'core.access.people.manage']),
          companyRole(EXPEDICE_ROLE, [ORDER_PAGE, ORDER_RECORDS]),
          tenantRole(ROUTING_ROLE, [ROUTING]),
        ],
      });
      expect((yield* failureOf(administrative, true)).code).toBe('unsafe_permissions');
      expect(administrative.writes).toEqual([]);
      const outOfLane = fakeShell({
        roles: [
          companyRole(ESHOP_ROLE, [ORDER_PAGE, ORDER_RECORDS]),
          companyRole(EXPEDICE_ROLE, [ORDER_PAGE, ORDER_RECORDS, TASK_READ]),
          tenantRole(ROUTING_ROLE, [ROUTING]),
        ],
      });
      const lane = yield* failureOf(outOfLane, true);
      expect([lane.code, lane.reason.includes(EXPEDICE)]).toEqual(['unsafe_permissions', true]);
      const tenantWide = yield* failureOf(fakeShell(), true, {
        roles: { ...chosen, [ESHOP]: Option.some(ROUTING_ROLE) },
      });
      expect(tenantWide.code).toBe('unsafe_permissions');
    }),
);

it.effect('foreign assignments or a refused sign-in stop without echoing secrets', () =>
  Effect.gen(function* stops() {
    const foreign = fakeShell();
    foreign.people.set(id(11), {
      assignments: [{ roleId: id(777), scope: COMPANY }],
      directory: Option.some({ revision: 1, status: 'active' }),
      memberships: [
        { kind: 'member', scope: TENANT },
        { kind: 'member', scope: COMPANY },
      ],
    });
    expect((yield* failureOf(foreign, true)).code).toBe('unsafe_permissions');
    expect(foreign.writes).toEqual([]);

    const refused = yield* failureOf(fakeShell(), false, {
      passwords: { ...options(false).passwords, admin: Redacted.make('wrong-secret') },
    });
    expect([refused.code, refused.reason.includes('wrong-secret')]).toEqual(['http_refused', false]);
  }),
);

it.effect('a write that never shows up in the next read is waited for, then refused as no progress', () =>
  Effect.gen(function* stalls() {
    const shell = fakeShell({ lossyPath: MEMBERSHIP });
    expect((yield* failureOf(shell, true)).code).toBe('no_progress');
    expect(shell.writes.filter(({ principalId }) => principalId === id(11))).toHaveLength(1);
  }),
);

it.effect('a reviewed role is judged by what it must not hold, not by holding Merchandise reads', () =>
  Effect.gen(function* acceptsEngineeredOwnerRoles() {
    const shell = fakeShell({
      roles: [
        companyRole(ESHOP_ROLE, [TASK_READ]),
        companyRole(EXPEDICE_ROLE, [ORDER_STATUS]),
        tenantRole(ROUTING_ROLE, [ROUTING]),
      ],
    });
    const result = yield* runWith(shell, true);
    expect(result.blockers).toEqual([]);
    expect(shell.people.get(id(11))?.assignments.map(({ roleId }) => roleId)).toContain(ESHOP_ROLE);
    expect(shell.people.get(id(12))?.assignments.map(({ roleId }) => roleId)).toContain(EXPEDICE_ROLE);
  }),
);

it.effect('a staff login must select the AKROS seller only, while the administrator may also hold others', () =>
  Effect.gen(function* checksSelectableCompanies() {
    const staff = fakeShell({ otherCompanyFor: 'staff' });
    const refused = yield* failureOf(staff, true);
    expect([refused.code, refused.reason.includes(ESHOP)]).toEqual(['foreign_company', true]);
    expect(staff.writes).toEqual([]);
    const administrator = fakeShell({ otherCompanyFor: 'admin' });
    const applied = yield* runWith(administrator, true);
    expect(applied.blockers).toEqual([]);
    expect(administrator.writes).toHaveLength(8);
  }),
);

it.effect('a seller switch the Shell answers with another company stops before any write', () =>
  Effect.gen(function* verifiesTheSelectedSeller() {
    const shell = fakeShell({ switchesElsewhere: true });
    expect((yield* failureOf(shell, true)).code).toBe('target_unreachable');
    expect(shell.writes).toEqual([]);
  }),
);

it.effect('only the stage or a loopback Shell is accepted, and passwords decode only as the full redacted set', () =>
  Effect.gen(function* validates() {
    expect(yield* validateShellUrl(`${ORIGIN}/`)).toBe(ORIGIN);
    expect(Exit.isFailure(yield* Effect.exit(validateShellUrl('https://evil.example/')))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(validateShellUrl(`${ORIGIN}/path`)))).toBe(true);
    const decoded = yield* Schema.decodeUnknownEffect(PasswordsSchema)(
      '{"admin":"zz-secret","eshop@akros.demo":"b","expedice@akros.demo":"c"}',
    );
    expect([Redacted.isRedacted(decoded.admin), Redacted.value(decoded.admin)]).toEqual([true, 'zz-secret']);
    expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(PasswordsSchema)('{"admin":"a"}')))).toBe(true);
  }),
);
