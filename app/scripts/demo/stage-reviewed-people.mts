#!/usr/bin/env node
/**
 * Apply the reviewed roles of Obchodní firma's three role accounts on stage through the Shell's own
 * administration endpoints, as the tenant owner. Every decision is `reviewed-people-plan.mts`; this file
 * only reads, prints and sends.
 *
 *   printf %s "$PASSWORD" | pnpm demo:stage:reviewed-people --shell-url <origin> --email <owner> --password-stdin
 *
 * Modes: `--plan` (default) reads and prints what it would send; `--apply` sends it one write at a time,
 * re-reading stage after each answer; `--rollback` revokes the three people's managed roles and ends the
 * memberships this script's admissions wrote (the roles stay, and so does a membership somebody had before
 * the apply), and `--plan --rollback` only prints that. A rollback stops before it would close a team place,
 * a managed delegation, a management row or a membership outside the tenant and company 0020. `--generation N` names fresh
 * admission and assignment ids after a rollback.
 *
 * The password is read only from stdin and never printed. Besides sign-in, the only request outside the
 * administration reads that plan mode sends is selecting Obchodní firma for its own session, as the Shell's
 * company switcher does. It stops at the first refusal; output is status, problem tag, detail and the
 * request's correlation id, never a cookie or an answer body.
 *
 * Exits: 0 done, 2 bad usage, 3 not the tenant owner, 4 validation halt, 5 HTTP refusal or unexpected answer.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import {
  Cause,
  Console,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
  Stdio,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import {
  AccessPageSchema,
  AccessPeopleMutationResponseSchema,
  AccessRoleEditPayloadSchema,
  AccessRoleRevisionIdSchema,
  AccessRoleSchema,
  AccessTemplateKeySchema,
  AdmitAccessMemberPayloadSchema,
  AssignAccessRolePayloadSchema,
  CreateAccessRolePayloadSchema,
  EndAccessMembershipPayloadSchema,
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeoplePayloadSchema,
  ListAccessPeopleResponseSchema,
  ListAccessRolesResponseSchema,
  ListAccessRoleTemplatesResponseSchema,
  PreviewAccessRoleEditResponseSchema,
  RevokeAccessAssignmentPayloadSchema,
  SaveAccessRoleEditPayloadSchema,
  SaveAccessRoleEditResponseSchema,
} from '../../apps/shell-super-app/shared/access-admin-api.ts';
import {
  AvailableLegalEntitiesResponseSchema,
  LegalEntityIdSchema,
  SignInPayloadSchema,
  SignInResponseSchema,
  SwitchLegalEntityPayloadSchema,
} from '../../apps/shell-super-app/shared/api.ts';
import { PeopleListRequestSchema, PeopleListResponseSchema } from '../../apps/shell-super-app/shared/people-api.ts';
import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { policyReleaseEntries } from './access-policy.mts';
import { demoModuleIds } from './permissions.mts';
import {
  AssignStep,
  COMPANY_ID,
  CreateRoleStep,
  desiredState,
  planReviewedPeople,
  previewBody,
  previewIssue,
  ROLLBACK_REASON,
  saveBody,
  SaveRoleStep,
  STEP_PATHS,
  stepWithinAllowList,
} from './reviewed-people-plan.mts';
import type {
  DesiredState,
  ObservedCell,
  ObservedState,
  PlannedStep,
  PlanOptions,
  RoleRevisionId,
  SaveRole,
} from './reviewed-people-plan.mts';

const STAGE_HOST = 'ontos-stage.web-revolution.cz';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const API = '/shell-super-app-api';
const PAGE = 100;
const PREVIEW_PATH = '/shell/access/roles/preview';
const PLACEHOLDER_REVISION = AccessRoleRevisionIdSchema.make('00000000-0000-4000-8000-000000000000');
const PLACEHOLDER_TOKEN = '0'.repeat(64);

export class StageDriverError extends Schema.TaggedError<StageDriverError>()('StageDriverError', {
  exitCode: Schema.Literals([2, 3, 4, 5]),
  reason: Schema.String,
}) {}

const usage = (reason: string) => new StageDriverError({ exitCode: 2, reason });
const invalid = (reason: string) => new StageDriverError({ exitCode: 4, reason });
const refusedHttp = (reason: string) => new StageDriverError({ exitCode: 5, reason });

/** Only the stage origin over HTTPS, or a loopback origin, without credentials, path, query or fragment. */
export const validateShellUrl = (raw: string): Result.Result<string, string> => {
  const parsed = Schema.decodeUnknownResult(Schema.URLFromString)(raw);
  if (Result.isFailure(parsed)) {
    return Result.fail('--shell-url is not a URL');
  }
  const url = parsed.success;
  const plain =
    url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.pathname === '/';
  const stage = url.protocol === 'https:' && url.hostname === STAGE_HOST;
  const loopback = (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  return plain && (stage || loopback)
    ? Result.succeed(url.origin)
    : Result.fail(`--shell-url must be https://${STAGE_HOST} or a localhost origin, with no path or credentials`);
};

/** The password, from a pipe only: an interactive terminal would echo it. */
const readPassword = Effect.gen(function* passwordFromStdin() {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* usage('pipe the password into --password-stdin; it is never read from a terminal, argv or env');
  }
  const text = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError(() => usage('stdin could not be read')),
  );
  const password = text.replace(/\r?\n$/u, '');
  return password.length === 0 ? yield* usage('stdin held no password') : Redacted.make(password);
});

// --- the HTTP session --------------------------------------------------------------------------------

interface Answer {
  readonly body: Option.Option<unknown>;
  readonly correlationId: string;
  readonly status: number;
}

const ProblemSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});

/** One line about a refused answer: never the body, only its problem tag and detail. */
const refusal = (what: string, answer: Answer): string => {
  const problem = answer.body.pipe(Option.flatMap(Schema.decodeUnknownOption(ProblemSchema)));
  const tag = problem.pipe(
    Option.flatMap((found) => Option.fromUndefinedOr(found._tag)),
    Option.getOrElse(() => 'no problem tag'),
  );
  const detail = problem.pipe(
    Option.flatMap((found) => Option.fromUndefinedOr(found.detail)),
    Option.map((text) => `: ${text}`),
    Option.getOrElse(() => ''),
  );
  return `${what}: HTTP ${answer.status} ${tag}${detail} (x-correlation-id ${answer.correlationId})`;
};

/** The exact JSON a request carries, encoded with the Shell's own payload schema. */
const encodeJson = <S extends Schema.Top>(schema: S, value: S['Type']) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError(() => invalid('a planned body does not match the Shell contract')),
  );

const headersFor = (origin: string, cookie: string, correlationId: string, idempotencyKey: Option.Option<string>) => {
  const headers = { cookie, origin, 'x-correlation-id': correlationId };
  return Option.isSome(idempotencyKey) ? { ...headers, 'idempotency-key': idempotencyKey.value } : headers;
};

const makeSession = (origin: string) =>
  Effect.gen(function* session() {
    const http = yield* HttpClient.HttpClient;
    const jar = yield* Ref.make(Cookies.empty);
    const send = Effect.fn('ReviewedPeople.send')(function* sendRequest(
      request: HttpClientRequest.HttpClientRequest,
      idempotencyKey: Option.Option<string>,
    ) {
      const correlationId = `ontos-demo-reviewed-people:${randomUUID()}`;
      const cookie = Cookies.toCookieHeader(yield* Ref.get(jar));
      const response = yield* http
        .execute(HttpClientRequest.setHeaders(request, headersFor(origin, cookie, correlationId, idempotencyKey)))
        .pipe(
          Effect.timeout('60 seconds'),
          Effect.mapError(() => refusedHttp(`${request.url}: no answer (x-correlation-id ${correlationId})`)),
        );
      yield* Ref.update(jar, (held) => Cookies.merge(held, response.cookies));
      const body = yield* Effect.option(response.json);
      return { body, correlationId, status: response.status } satisfies Answer;
    });
    const postJson = (path: string, json: string, idempotencyKey: Option.Option<string>) =>
      send(
        HttpClientRequest.bodyText(HttpClientRequest.post(`${origin}${API}${path}`), json, 'application/json'),
        idempotencyKey,
      );
    const post = <S extends Schema.Top>(path: string, schema: S, payload: S['Type']) =>
      encodeJson(schema, payload).pipe(Effect.flatMap((json) => postJson(path, json, Option.none())));
    const get = (path: string) => send(HttpClientRequest.get(`${origin}${API}${path}`), Option.none());
    return { get, post, postJson };
  });
type Session = Effect.Success<ReturnType<typeof makeSession>>;

/** A 2xx answer decoded with the frozen Shell schema, or the first refusal. */
const expectOk =
  <S extends Schema.Top>(what: string, schema: S) =>
  (answer: Answer) =>
    answer.status >= 200 && answer.status < 300
      ? Schema.decodeUnknownEffect(schema)(Option.getOrNull(answer.body)).pipe(
          Effect.mapError(() => refusedHttp(`${what}: the answer does not match the Shell contract`)),
        )
      : Effect.fail(refusedHttp(refusal(what, answer)));

const signIn = (session: Session, email: string, password: Redacted.Redacted) =>
  Effect.gen(function* signInAsOwner() {
    const signedIn = yield* session
      .post('/auth/sign-in', SignInPayloadSchema, { email, password })
      .pipe(Effect.flatMap(expectOk('sign-in', SignInResponseSchema)));
    const entities = yield* session
      .get('/auth/legal-entities')
      .pipe(Effect.flatMap(expectOk('legal entities', AvailableLegalEntitiesResponseSchema)));
    if (String(entities.selectedLegalEntityId) !== String(COMPANY_ID)) {
      yield* session
        .post('/auth/legal-entity/switch', SwitchLegalEntityPayloadSchema, {
          legalEntityId: LegalEntityIdSchema.make(COMPANY_ID),
        })
        .pipe(Effect.flatMap(expectOk('select Obchodní firma', Schema.Unknown)));
    }
    return signedIn.identity;
  });

// --- reading the state -------------------------------------------------------------------------------

const observedCell = (cell: (typeof AccessRoleSchema.Type)['cells'][number]): ObservedCell => ({
  plain:
    cell.amountCeiling === undefined &&
    Match.value(cell.selector).pipe(
      Match.tag('targets', () => false),
      Match.orElse(() => true),
    ),
  slot: `${cell.capabilityKey} ${cell.mode} ${cell.selector._tag}`,
});

const pageRequest = (cursor: Option.Option<string>) =>
  Option.match(cursor, {
    onNone: () => ({ limit: PAGE }),
    onSome: (next) => ({ cursor: next, limit: PAGE }),
  });

const allRoles = (session: Session) =>
  Effect.gen(function* listAllRoles() {
    const roles: (typeof AccessRoleSchema.Type)[] = [];
    let cursor = Option.none<string>();
    do {
      const page = yield* session
        .post('/shell/access/roles/list', AccessPageSchema, pageRequest(cursor))
        .pipe(Effect.flatMap(expectOk('roles/list', ListAccessRolesResponseSchema)));
      roles.push(...page.items);
      cursor = Option.fromNullishOr(page.nextCursor);
    } while (Option.isSome(cursor));
    return roles;
  });

const allPeople = (session: Session) =>
  Effect.gen(function* listAllPeople() {
    const pages: (typeof ListAccessPeopleResponseSchema.Type)[] = [];
    let cursor = Option.none<string>();
    do {
      const page = yield* session
        .post('/shell/access/people/list', ListAccessPeoplePayloadSchema, pageRequest(cursor))
        .pipe(Effect.flatMap(expectOk('people/list', ListAccessPeopleResponseSchema)));
      pages.push(page);
      cursor = Option.fromNullishOr(page.nextCursor);
    } while (Option.isSome(cursor));
    const revisions = new Set(pages.map(({ revision }) => revision));
    const [revision] = revisions;
    if (revisions.size !== 1 || revision === undefined) {
      return yield* refusedHttp('people/list changed while it was read page by page; re-run');
    }
    return { people: pages.flatMap(({ items }) => items), revision };
  });

const companyDirectory = (session: Session) =>
  Effect.gen(function* listDirectory() {
    const items: (typeof PeopleListResponseSchema.Type)['items'][number][] = [];
    let offset = Option.some(0);
    while (Option.isSome(offset)) {
      const page = yield* session
        .post('/auth/identity/people/list', PeopleListRequestSchema, { limit: PAGE, offset: offset.value })
        .pipe(Effect.flatMap(expectOk('company directory', PeopleListResponseSchema)));
      const ours = Match.value(page.scope).pipe(
        Match.tag('company', ({ legalEntityId }) => legalEntityId === String(COMPANY_ID)),
        Match.orElse(() => false),
      );
      if (!ours) {
        return yield* refusedHttp('the company directory answered for another company than Obchodní firma');
      }
      items.push(...page.items);
      offset = Option.fromNullishOr(page.nextOffset);
    }
    return items;
  });

const observe = (session: Session, identity: { readonly principalId: string; readonly tenantId: string }) =>
  Effect.gen(function* observeStage() {
    const release = yield* session
      .post('/shell/access/roles/templates', AccessPageSchema, { limit: PAGE })
      .pipe(Effect.flatMap(expectOk('roles/templates', ListAccessRoleTemplatesResponseSchema)));
    const roles = yield* allRoles(session);
    const people = yield* allPeople(session);
    const options = yield* session
      .post('/shell/access/people/options', ListAccessPeoplePayloadSchema, { limit: PAGE })
      .pipe(Effect.flatMap(expectOk('people/options', ListAccessPeopleOptionsResponseSchema)));
    const directory = yield* companyDirectory(session);
    const observed: ObservedState = {
      actingPrincipalId: identity.principalId,
      at: yield* DateTime.now,
      directory: directory.map((entry) => ({
        activeHumanMember:
          entry.kind === 'human' &&
          entry.principalStatus === 'active' &&
          entry.selectedCompanyMembership?.status === 'active' &&
          entry.selectedCompanyMembership.legalEntityId === String(COMPANY_ID),
        principalId: entry.principalRef.principalId,
      })),
      people: people.people.map((person) => ({
        assignments: person.assignments.map(({ incarnationId, roleId, scope, status }) => ({
          incarnationId,
          roleId,
          scope,
          status,
        })),
        delegations: person.delegations.map(({ managerId, status }) => ({ managerId, status })),
        memberships: person.memberships.map(({ kind, membershipId, scope, status, validUntil }) => ({
          kind,
          membershipId,
          scope,
          status,
          validUntil: Option.fromNullishOr(validUntil),
        })),
        principalId: person.principalId,
        teams: person.teams.map(({ scope }) => scope),
      })),
      peopleRevision: people.revision,
      release: {
        catalogSnapshotId: release.catalogSnapshotId,
        createAvailable: release.createAvailable,
        entries: release.entries.map(({ capabilityKey, kind, modes, risk, selectors }) => ({
          capabilityKey,
          kind,
          modes,
          risk,
          selectors,
        })),
        saveAvailable: release.saveAvailable,
      },
      roles: roles.map((role) => ({
        cells: role.cells.map(observedCell),
        holderCount: role.holderCount,
        id: role.id,
        legalEntityId: Option.fromUndefinedOr(role.legalEntityId),
        name: role.name,
        revisionId: role.revisionId,
      })),
      tenantId: identity.tenantId,
      writeAvailability: {
        canAdmitMember: options.writeAvailability.canAdmitMember,
        canAssign: options.writeAvailability.canAssign,
        canEndMembership: options.writeAvailability.canEndMembership,
        canUnassign: options.writeAvailability.canUnassign,
      },
    };
    return { candidates: options.admissionCandidates, observed };
  });

// --- the exact request of one step ------------------------------------------------------------------

/** What a write sends. In plan mode a value only an earlier answer supplies is a fixed placeholder. */
interface WireRequest {
  readonly json: string;
  readonly path: string;
}

const knownRevision = (
  revision: Option.Option<RoleRevisionId>,
  placeholders: boolean,
  what: string,
): Effect.Effect<RoleRevisionId, StageDriverError> =>
  Option.match(revision, {
    onNone: () =>
      placeholders
        ? Effect.succeed(PLACEHOLDER_REVISION)
        : Effect.fail(invalid(`${what}: the role revision is not known yet`)),
    onSome: (known) => Effect.succeed(known),
  });

const wire = <S extends Schema.Top>(path: string, schema: S, payload: S['Type']) =>
  encodeJson(schema, payload).pipe(Effect.map((json): WireRequest => ({ json, path })));

const requestOf = (step: PlannedStep, placeholders: boolean): Effect.Effect<WireRequest, StageDriverError> =>
  Match.valueTags(step, {
    AdmitMember: ({ expectedRevision, principalId }) =>
      wire(STEP_PATHS.AdmitMember, AdmitAccessMemberPayloadSchema, {
        expectedRevision,
        principalId,
        scope: { kind: 'company', legalEntityId: COMPANY_ID },
      }),
    Assign: ({ expectedRevision, expectedRoleRevisionId, principalId, roleId, roleKey, scope }) =>
      knownRevision(expectedRoleRevisionId, placeholders, `assign ${roleKey}`).pipe(
        Effect.flatMap((revision) =>
          wire(STEP_PATHS.Assign, AssignAccessRolePayloadSchema, {
            expectedRevision,
            expectedRoleRevisionId: revision,
            principalId,
            roleId,
            scope,
          }),
        ),
      ),
    CreateRole: ({ catalogSnapshotId, name, scope }) =>
      wire(STEP_PATHS.CreateRole, CreateAccessRolePayloadSchema, {
        catalogSnapshotId,
        cells: [],
        name,
        scope,
        templateKey: AccessTemplateKeySchema.make('blank'),
      }),
    EndMembership: ({ expectedRevision, principalId, scope }) =>
      wire(STEP_PATHS.EndMembership, EndAccessMembershipPayloadSchema, {
        expectedRevision,
        principalId,
        reason: ROLLBACK_REASON,
        scope,
      }),
    RevokeAssignment: ({ expectedRevision, incarnationId }) =>
      wire(STEP_PATHS.RevokeAssignment, RevokeAccessAssignmentPayloadSchema, {
        expectedRevision,
        incarnationId,
        reason: ROLLBACK_REASON,
      }),
    SaveRole: (save) =>
      knownRevision(save.expectedRoleRevisionId, placeholders, `save ${save.roleKey}`).pipe(
        Effect.flatMap((revision) =>
          wire(STEP_PATHS.SaveRole, SaveAccessRoleEditPayloadSchema, saveBody(save, revision, PLACEHOLDER_TOKEN)),
        ),
      ),
  });

const byteLength = (json: string): number => new TextEncoder().encode(json).length;

/** The plan as a person signs it off: the roles with their admin-kind cells, then every write in order. */
export const describePlan = (desired: DesiredState, steps: readonly PlannedStep[], options: PlanOptions) =>
  Effect.gen(function* describePlanned() {
    const lines = [
      `mode: ${options.mode}, generation ${options.generation}`,
      'reviewed roles (admin-kind cells listed by name for sign-off):',
    ];
    for (const role of desired.roles) {
      const scope = role.scope.kind === 'tenant' ? 'tenant' : `company ${role.scope.legalEntityId}`;
      lines.push(
        `  ${role.name} [${role.key}] id=${role.roleId} ${scope} cells=${role.cells.length} dangerous=${role.confirmations.length} admin=${role.adminCells.length}`,
        ...role.adminCells.map((admin) => `    admin: ${admin}`),
      );
    }
    lines.push(`planned writes: ${steps.length}`);
    for (const [index, step] of steps.entries()) {
      const request = yield* requestOf(step, true);
      lines.push(
        `  #${index + 1} POST ${API}${request.path} idempotency-key=${step.idempotencyKey} bytes=${byteLength(request.json)}`,
        Schema.is(SaveRoleStep)(step)
          ? `     ${step.cells.length} cells, ${step.confirmations.length} confirmed effects; sent after roles/preview answers exactly these (revision and preview token from that answer)`
          : `     ${request.json}`,
      );
      if (Schema.is(AssignStep)(step) && Option.isNone(step.expectedRoleRevisionId)) {
        lines.push(`     expectedRoleRevisionId is a placeholder until the save of ${step.roleKey} answers`);
      }
    }
    return lines;
  });

// --- sending ---------------------------------------------------------------------------------------

const saveRole = (session: Session, step: SaveRole) =>
  Effect.gen(function* previewThenSave() {
    const revision = yield* knownRevision(step.expectedRoleRevisionId, false, `save ${step.roleKey}`);
    const preview = yield* session
      .post(PREVIEW_PATH, AccessRoleEditPayloadSchema, previewBody(step, revision))
      .pipe(Effect.flatMap(expectOk(`preview ${step.roleKey}`, PreviewAccessRoleEditResponseSchema)));
    const issue = previewIssue(step, {
      added: preview.added.map(observedCell),
      affectedHolders: preview.affectedHolders.map(({ holder }) =>
        Match.value(holder).pipe(
          Match.tag('Principal', ({ principalId }) => Option.some<string>(principalId)),
          Match.orElse(() => Option.none<string>()),
        ),
      ),
      cells: preview.cells.map(observedCell),
      dangerous: preview.dangerous.map(({ effect, slot }) => ({ effect, slot })),
      removed: preview.removed.map(observedCell),
    });
    if (issue !== undefined) {
      return yield* invalid(`${issue}; nothing saved`);
    }
    const json = yield* encodeJson(SaveAccessRoleEditPayloadSchema, saveBody(step, revision, preview.previewToken));
    yield* Console.log(`     save body ${byteLength(json)} bytes`);
    return yield* session
      .postJson(STEP_PATHS.SaveRole, json, Option.some(step.idempotencyKey))
      .pipe(Effect.flatMap(expectOk(`save ${step.roleKey}`, SaveAccessRoleEditResponseSchema)));
  });

const sendStep = (session: Session, step: PlannedStep) =>
  Schema.is(SaveRoleStep)(step)
    ? saveRole(session, step).pipe(Effect.asVoid)
    : requestOf(step, false).pipe(
        Effect.flatMap(({ json, path }) => session.postJson(path, json, Option.some(step.idempotencyKey))),
        Effect.flatMap((answer) =>
          Schema.is(CreateRoleStep)(step)
            ? expectOk(
                `create ${step.roleKey}`,
                AccessRoleSchema,
              )(answer).pipe(
                Effect.flatMap((created) =>
                  created.id === step.roleId
                    ? Effect.void
                    : Effect.fail(invalid(`the Shell created ${step.roleKey} as ${created.id}, not ${step.roleId}`)),
                ),
              )
            : expectOk(step._tag, AccessPeopleMutationResponseSchema)(answer).pipe(Effect.asVoid),
        ),
      );

// --- the command -------------------------------------------------------------------------------------

const halted = (halt: { readonly kind: 'identity' | 'validation'; readonly reason: string }) =>
  new StageDriverError({ exitCode: halt.kind === 'identity' ? 3 : 4, reason: halt.reason });

const localDesiredState = Effect.gen(function* compileLocal() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
  const entries = yield* Effect.fromResult(policyReleaseEntries(modules, demoModuleIds));
  return yield* Effect.fromResult(desiredState(entries));
}).pipe(Effect.mapError((cause) => invalid(`local reviewed state: ${String(cause)}`)));

interface RunInput {
  readonly email: string;
  readonly options: PlanOptions;
  readonly origin: string;
  readonly password: Redacted.Redacted;
  readonly send: boolean;
}

/** Send the first planned write, re-read, re-plan; stop when nothing is left or at the first refusal. */
const converge = (
  session: Session,
  identity: { readonly principalId: string; readonly tenantId: string },
  desired: DesiredState,
  options: PlanOptions,
  budget: number,
) =>
  Effect.gen(function* convergeStage() {
    let previous = '';
    for (let round = 0; round <= budget; round += 1) {
      const { observed } = yield* observe(session, identity);
      const next = planReviewedPeople(desired, observed, options);
      if (Result.isFailure(next)) {
        return yield* halted(next.failure);
      }
      const [step] = next.success;
      if (step === undefined) {
        return yield* Console.log(`done: ${round} writes sent; stage matches the reviewed ${options.mode}`);
      }
      const signature = `${step._tag} ${step.idempotencyKey}`;
      if (signature === previous || !stepWithinAllowList(step, observed)) {
        return yield* invalid(`${signature} made no progress or left the allow-list`);
      }
      previous = signature;
      yield* sendStep(session, step);
      yield* Console.log(`sent #${round + 1} ${signature}`);
    }
    return yield* invalid('stage did not converge within the planned writes');
  });

const run = (input: RunInput) =>
  Effect.gen(function* runDriver() {
    const desired = yield* localDesiredState;
    const session = yield* makeSession(input.origin);
    const identity = yield* signIn(session, input.email, input.password);
    yield* Console.log(`signed in: principal ${identity.principalId}, tenant ${identity.tenantId}`);
    const { candidates, observed } = yield* observe(session, identity);
    const flags = observed.writeAvailability;
    yield* Console.log(
      `people options: canAdmitMember=${flags.canAdmitMember} canAssign=${flags.canAssign} canUnassign=${flags.canUnassign} canEndMembership=${flags.canEndMembership} admissionCandidates=${candidates.length}`,
    );
    const planned = planReviewedPeople(desired, observed, input.options);
    if (Result.isFailure(planned)) {
      return yield* halted(planned.failure);
    }
    for (const line of yield* describePlan(desired, planned.success, input.options)) {
      yield* Console.log(line);
    }
    return input.send
      ? yield* converge(session, identity, desired, input.options, planned.success.length)
      : yield* Console.log('plan only: nothing was written');
  });

const command = Command.make(
  'stage-reviewed-people',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    email: Flag.String('email'),
    generation: Flag.Int('generation').pipe(Flag.withDefault(1)),
    passwordStdin: Flag.Boolean('password-stdin').pipe(Flag.withDefault(false)),
    plan: Flag.Boolean('plan').pipe(Flag.withDefault(false)),
    rollback: Flag.Boolean('rollback').pipe(Flag.withDefault(false)),
    shellUrl: Flag.String('shell-url'),
  },
  (flags) =>
    Effect.gen(function* main() {
      if (flags.apply && (flags.plan || flags.rollback)) {
        return yield* usage('--apply sends the reviewed state; it combines with neither --plan nor --rollback');
      }
      if (!flags.passwordStdin) {
        return yield* usage('the password is read only with --password-stdin');
      }
      const origin = validateShellUrl(flags.shellUrl);
      if (Result.isFailure(origin)) {
        return yield* usage(origin.failure);
      }
      const password = yield* readPassword;
      return yield* run({
        email: flags.email,
        options: { generation: flags.generation, mode: flags.rollback ? 'rollback' : 'apply' },
        origin: origin.success,
        password,
        send: (flags.apply || flags.rollback) && !flags.plan,
      });
    }).pipe(Effect.tapError((stopped) => Console.error(`stopped (exit ${stopped.exitCode}): ${stopped.reason}`))),
);

const exitCodeOf = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.match(exit, {
    onFailure: (cause) =>
      Option.match(Option.filter(Cause.findErrorOption(cause), Schema.is(StageDriverError)), {
        onNone: () => 1,
        onSome: (stopped) => stopped.exitCode,
      }),
    onSuccess: () => 0,
  });

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = exitCodeOf(exit);
}
