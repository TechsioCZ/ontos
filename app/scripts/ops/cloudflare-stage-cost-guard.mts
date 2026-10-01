#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Context, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Command } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import type { CloudflareApiError } from './cloudflare-api-error.mts';
import { CloudflareApi, CloudflareApiLive, CloudflareCredentials } from './cloudflare-api.mts';
import type {
  AccessAppSpec,
  AccessPolicySpec,
  AlertPolicySpec,
  CloudflareAccessApp,
  CloudflareAccessPolicy,
  CloudflareRulesetRule,
  RulesetRuleSpec,
  ServiceTokenCredentials,
  WorkersUsage,
} from './cloudflare-api.mts';
import { readEdgeUnits } from './stage-edge-units.mts';
import { StageOperationError } from './stage-operation-error.mts';
import {
  OpsMode,
  STAGE_EDGE_ENVIRONMENT,
  listGithubSecretNames,
  listGithubVariables,
  mutate,
  perform,
  setGithubSecret,
  setGithubVariable,
} from './stage-operations.mts';

/**
 * Cost guards that keep the Workers bill at the Workers Paid base price ($5 a month: 10M requests
 * and 30M CPU ms). That allowance covers the whole account, which also runs other projects'
 * Workers, so `check` measures account-wide usage but only ever acts on OntOS stage objects. The
 * cut-over provisions the guards; the hourly `stage-edge-cost-guard` workflow runs `check`, which
 * trips the kill switch once the billing cycle's usage crosses the threshold.
 *
 * - Access: a reusable policy admitting anyone who signs in, a CI service token whose credentials
 *   stage-edge holds, and, only with STAGE_ACCESS_ENFORCE=true, one Access application on every
 *   stage hostname plus a bypass application for the paths a browser loads cross-origin without an
 *   Access session (federated remotes) or a vertical calls with an API key (gateway context).
 * - A WAF custom rule blocking exactly the OntOS stage hostnames, provisioned disabled. The WAF
 *   answers before a Worker runs, so blocked requests are never billed. There is no rate-limit
 *   rule: the stage zone is shared and on the Free plan, whose rate-limit expressions cannot match
 *   a hostname, so one would throttle every other project in the zone.
 * - A Workers requests usage notification to STAGE_ACCESS_EMAILS.
 */
export const ACCESS_PEOPLE_POLICY = 'ontos-stage-people';
export const ACCESS_CI_POLICY = 'ontos-stage-ci-token';
export const ACCESS_BYPASS_POLICY = 'ontos-stage-gateway-bypass';
export const ACCESS_SERVICE_TOKEN = 'ontos-stage-ci';
export const STAGE_ACCESS_APP = 'ontos-stage';
export const PUBLIC_PATHS_APP = 'ontos-stage-public-paths';
/** A login lasts 30 days. */
export const ACCESS_SESSION_DURATION = '720h';
/** Verticals call this route on the Shell with an API key, never with an Access session. */
export const GATEWAY_CONTEXT_PATH = '/shell-super-app-api/auth/api-key/gateway-context';
/**
 * What the Shell page loads from each vertical's own hostname: the federation manifest, the remote
 * entry, its chunks and styles, and its locale JSON. The browser fetches them cross-origin, where
 * the Access cookie of the vertical's hostname does not exist, so they bypass Access. They are the
 * built bundle every visitor downloads anyway; HTML, SSR and APIs stay behind Access.
 */
export const FEDERATION_ASSET_PATHS = ['/mf-manifest.json', '/remoteEntry.js', '/static/*', '/locales/*'] as const;
export const ACCESS_CLIENT_ID_SECRET = 'CLOUDFLARE_ACCESS_CLIENT_ID';
export const ACCESS_CLIENT_SECRET_SECRET = 'CLOUDFLARE_ACCESS_CLIENT_SECRET';
export const ZONE_ID_VARIABLE = 'CLOUDFLARE_STAGE_ZONE_ID';

export const KILL_SWITCH_PHASE = 'http_request_firewall_custom';
export const KILL_SWITCH_RULE_REF = 'ontos_stage_kill_switch';
export const USAGE_ALERT_NAME = 'ontos-stage-workers-requests';
/** Half the included 10M requests: an early warning, well before the kill switch threshold. */
export const USAGE_ALERT_REQUESTS = 5_000_000;
/** 80% of the included allowance, which leaves room for the analytics delay and the hourly cadence. */
const DEFAULT_REQUEST_LIMIT = 8_000_000;
const DEFAULT_CPU_MS_LIMIT = 24_000_000;

const NOT_FOUND = 'it does not exist; run provision';
/** Cloudflare's `errors[].message` while the account has no Zero Trust organization. */
const ACCESS_NOT_ENABLED = 'access.api.error.not_enabled';
export const ENABLE_ZERO_TRUST =
  'Cloudflare Access is not enabled on this account: open Zero Trust in the Cloudflare dashboard once, choose a team name and the Free plan, then run cost-guards again';

export interface CostGuardPlan {
  /** Who gets the usage notification. */
  readonly accessEmails: readonly string[];
  /** Puts every stage hostname behind Access; off until cloudflare:proof sends the CI token. */
  readonly enforceAccess: boolean;
  /** Every placed unit's public stage hostname: the Shell's and one per vertical. */
  readonly hostnames: readonly string[];
  readonly repository: string;
  readonly shellHostname: string;
  readonly stageZone: string;
}

// ---------------------------------------------------------------------------------------------
// Rule and policy specifications

export const killSwitchRule = (hostnames: readonly string[], enabled: boolean): RulesetRuleSpec => ({
  action: 'block',
  description: 'OntOS stage: cost kill switch; resume with cloudflare-stage-cutover resume',
  enabled,
  expression: ['(http.host in {', hostnames.map((hostname) => `"${hostname}"`).join(' '), '})'].join(''),
  ref: KILL_SWITCH_RULE_REF,
});

/** Anyone who signs in with a login method of the Zero Trust organization gets in. */
export const peoplePolicy: AccessPolicySpec = {
  decision: 'allow',
  include: [{ everyone: {} }],
  name: ACCESS_PEOPLE_POLICY,
};

export const ciPolicy = (tokenId: string): AccessPolicySpec => ({
  decision: 'non_identity',
  include: [{ service_token: { token_id: tokenId } }],
  name: ACCESS_CI_POLICY,
});

const bypassPolicy: AccessPolicySpec = {
  decision: 'bypass',
  include: [{ everyone: {} }],
  name: ACCESS_BYPASS_POLICY,
};

export const usageAlert = (emails: readonly string[]): AlertPolicySpec => ({
  alert_type: 'billing_usage_alert',
  enabled: true,
  filters: { limit: [String(USAGE_ALERT_REQUESTS)], product: ['worker_requests'] },
  mechanisms: { email: emails.map((id) => ({ id })) },
  name: USAGE_ALERT_NAME,
});

const same = Schema.toEquivalence(Schema.Json);

const isAccessNotEnabled = (error: CloudflareApiError) => (error.apiMessages ?? []).includes(ACCESS_NOT_ENABLED);

/** Reads through Access, turning Cloudflare's "not enabled" answer into the operator's to-do. */
const requireAccess = <A, R>(effect: Effect.Effect<A, CloudflareApiError, R>) =>
  effect.pipe(
    Effect.catchIf(isAccessNotEnabled, () => Effect.fail(new StageOperationError({ message: ENABLE_ZERO_TRUST }))),
  );

const ruleMatches = (rule: CloudflareRulesetRule, spec: RulesetRuleSpec) =>
  rule.action === spec.action &&
  rule.expression === spec.expression &&
  Option.getOrElse(rule.description, () => '') === spec.description;

const ruleSpec = (rule: CloudflareRulesetRule, enabled: boolean): RulesetRuleSpec => ({
  action: 'block',
  description: Option.getOrElse(rule.description, () => ''),
  enabled,
  expression: rule.expression,
  ref: Option.getOrElse(rule.ref, () => ''),
});

const isEnabled = (rule: CloudflareRulesetRule) => Option.getOrElse(rule.enabled, () => true);

// ---------------------------------------------------------------------------------------------
// Zone rules

const findZoneId = (stageZone: string) =>
  Effect.gen(function* findZoneIdEffect() {
    const api = yield* CloudflareApi;
    const zoneId = yield* api.findZoneId(stageZone);
    return yield* Option.match(zoneId, {
      onNone: () =>
        Effect.fail(
          new StageOperationError({ message: `the API token cannot read the zone ${stageZone}; grant it Zone Read` }),
        ),
      onSome: Effect.succeed,
    });
  });

/** The zone's custom-rules entrypoint and the kill switch rule in it, found by its `ref`. */
const findKillSwitch = (zoneId: string) =>
  Effect.gen(function* findKillSwitchEffect() {
    const api = yield* CloudflareApi;
    const entrypoint = (yield* api.zoneRulesets(zoneId)).find(
      (ruleset) => ruleset.kind === 'zone' && ruleset.phase === KILL_SWITCH_PHASE,
    );
    if (entrypoint === undefined) {
      return { rule: Option.none<CloudflareRulesetRule>(), rulesetId: Option.none<string>() };
    }
    const ruleset = yield* api.ruleset(zoneId, entrypoint.id);
    return {
      rule: Option.fromNullishOr(
        Option.getOrElse(ruleset.rules, () => []).find(
          (rule) => Option.getOrUndefined(rule.ref) === KILL_SWITCH_RULE_REF,
        ),
      ),
      rulesetId: Option.some(ruleset.id),
    };
  });

/**
 * Converges the kill switch rule without touching the other rules in its phase, which may belong to
 * other projects in the zone: a missing entrypoint is created with the rule, a missing rule is added,
 * and a drifted rule is updated. Its on/off state is kept, so provisioning never resumes a tripped
 * kill switch.
 */
const ensureKillSwitchRule = (zoneId: string, spec: RulesetRuleSpec) =>
  Effect.gen(function* ensureKillSwitchRuleEffect() {
    const api = yield* CloudflareApi;
    const { rule, rulesetId } = yield* findKillSwitch(zoneId);
    if (Option.isNone(rulesetId)) {
      return yield* perform(
        `create the ${KILL_SWITCH_PHASE} entrypoint with the rule ${spec.ref}`,
        api.createZoneEntrypoint(zoneId, KILL_SWITCH_PHASE, [spec]),
      );
    }
    if (Option.isNone(rule)) {
      return yield* perform(
        `add the ${KILL_SWITCH_PHASE} rule ${spec.ref}`,
        api.addRulesetRule(zoneId, rulesetId.value, spec),
      );
    }
    if (ruleMatches(rule.value, spec)) {
      return yield* Console.log(`${KILL_SWITCH_PHASE} rule ${spec.ref} is current`);
    }
    return yield* perform(
      `update the ${KILL_SWITCH_PHASE} rule ${spec.ref}`,
      api.updateRulesetRule(zoneId, rulesetId.value, rule.value.id, { ...spec, enabled: isEnabled(rule.value) }),
    );
  });

/** Turns the kill switch on or off; it must have been provisioned. */
export const setKillSwitch = (zoneId: string, enabled: boolean) =>
  Effect.gen(function* setKillSwitchEffect() {
    const api = yield* CloudflareApi;
    const { rule, rulesetId } = yield* findKillSwitch(zoneId);
    if (Option.isNone(rule) || Option.isNone(rulesetId)) {
      return yield* new StageOperationError({ message: `the kill switch rule ${KILL_SWITCH_RULE_REF} ${NOT_FOUND}` });
    }
    const state = enabled ? 'blocks every stage hostname' : 'is off';
    if (isEnabled(rule.value) === enabled) {
      return yield* Console.log(`the kill switch already ${state}`);
    }
    return yield* perform(
      `switch the kill switch so it ${state}`,
      api.updateRulesetRule(zoneId, rulesetId.value, rule.value.id, ruleSpec(rule.value, enabled)),
    );
  });

// ---------------------------------------------------------------------------------------------
// Access

const ensureAccessPolicy = (existing: readonly CloudflareAccessPolicy[], spec: AccessPolicySpec) =>
  Effect.gen(function* ensureAccessPolicyEffect() {
    const api = yield* CloudflareApi;
    const current = existing.find(({ name }) => name === spec.name);
    if (current === undefined) {
      const created = yield* mutate(`create the Access policy ${spec.name}`, api.createAccessPolicy(spec), {
        decision: spec.decision,
        id: `<${spec.name} id>`,
        include: [],
        name: spec.name,
      });
      return created.id;
    }
    if (current.decision !== spec.decision || !same(current.include, spec.include)) {
      yield* perform(`update the Access policy ${spec.name}`, api.updateAccessPolicy(current.id, spec));
    }
    return current.id;
  });

/** The application covers exactly the spec's destinations, with its session duration. */
const accessAppCovers = (current: CloudflareAccessApp, spec: AccessAppSpec) =>
  same(
    Option.getOrElse(current.destinations, () => []).map(({ uri }) => Option.getOrElse(uri, () => '')),
    [...spec.destinations],
  ) && Option.getOrUndefined(current.session_duration) === spec.sessionDuration;

/** What is wrong with the provisioned policy, if anything. */
const accessPolicyProblem = (
  current: CloudflareAccessPolicy | undefined,
  spec: AccessPolicySpec,
): Option.Option<string> => {
  if (current === undefined) {
    return Option.some(NOT_FOUND);
  }
  return current.decision === spec.decision && same(current.include, spec.include)
    ? Option.none()
    : Option.some('it drifted; run cost-guards');
};

const accessAppMatches = (current: CloudflareAccessApp, spec: AccessAppSpec) =>
  accessAppCovers(current, spec) &&
  same(
    Option.getOrElse(current.policies, () => []).map(({ id }) => id),
    spec.policies.map(({ id }) => id),
  );

/** What is wrong with the provisioned application, if anything. */
const accessAppProblem = (current: CloudflareAccessApp | undefined, spec: AccessAppSpec): Option.Option<string> => {
  if (current === undefined) {
    return Option.some(NOT_FOUND);
  }
  return accessAppMatches(current, spec) ? Option.none() : Option.some('it drifted; run cost-guards');
};

const ensureAccessApp = (existing: readonly CloudflareAccessApp[], spec: AccessAppSpec) =>
  Effect.gen(function* ensureAccessAppEffect() {
    const api = yield* CloudflareApi;
    const current = existing.find(({ name }) => name === spec.name);
    if (current === undefined) {
      return yield* perform(
        `create the Access application ${spec.name} on ${spec.destinations.length} destinations`,
        api.createAccessApp(spec),
      );
    }
    if (!accessAppMatches(current, spec)) {
      return yield* perform(`update the Access application ${spec.name}`, api.updateAccessApp(current.id, spec));
    }
    return yield* Console.log(`Access application ${spec.name} is current`);
  });

const storeServiceToken = (repository: string, credentials: ServiceTokenCredentials) =>
  Effect.gen(function* storeServiceTokenEffect() {
    yield* perform(
      `set the ${STAGE_EDGE_ENVIRONMENT} secrets ${ACCESS_CLIENT_ID_SECRET} and ${ACCESS_CLIENT_SECRET_SECRET}`,
      Effect.gen(function* storeSecrets() {
        yield* setGithubSecret(
          repository,
          STAGE_EDGE_ENVIRONMENT,
          ACCESS_CLIENT_ID_SECRET,
          Redacted.make(credentials.clientId),
        );
        yield* setGithubSecret(
          repository,
          STAGE_EDGE_ENVIRONMENT,
          ACCESS_CLIENT_SECRET_SECRET,
          credentials.clientSecret,
        );
      }),
    );
  });

const PLANNED_TOKEN: ServiceTokenCredentials = {
  clientId: '<client id>',
  clientSecret: Redacted.make(''),
  id: `<${ACCESS_SERVICE_TOKEN} id>`,
};

/**
 * The CI service token and its stage-edge secrets. Cloudflare shows a client secret only once, so a
 * token whose secret stage-edge lost is rotated rather than duplicated.
 */
const ensureServiceToken = (repository: string) =>
  Effect.gen(function* ensureServiceTokenEffect() {
    const api = yield* CloudflareApi;
    const token = (yield* api.accessServiceTokens).find(({ name }) => name === ACCESS_SERVICE_TOKEN);
    const stored = yield* listGithubSecretNames(repository, STAGE_EDGE_ENVIRONMENT);
    if (token === undefined) {
      const created = yield* mutate(
        `create the Access service token ${ACCESS_SERVICE_TOKEN}`,
        api.createAccessServiceToken(ACCESS_SERVICE_TOKEN),
        PLANNED_TOKEN,
      );
      yield* storeServiceToken(repository, created);
      return created.id;
    }
    if (!stored.has(ACCESS_CLIENT_ID_SECRET) || !stored.has(ACCESS_CLIENT_SECRET_SECRET)) {
      const rotated = yield* mutate(
        `rotate the Access service token ${ACCESS_SERVICE_TOKEN}, whose secret ${STAGE_EDGE_ENVIRONMENT} lacks`,
        api.rotateAccessServiceToken(token.id),
        { ...PLANNED_TOKEN, clientId: token.client_id, id: token.id },
      );
      yield* storeServiceToken(repository, { ...rotated, clientId: token.client_id });
    }
    return token.id;
  });

/**
 * One application covers every stage hostname, so a login on one is a login on all of them. The
 * bypass application's paths are the more specific match, so Access lets them through.
 */
export const stageAccessApps = (
  plan: CostGuardPlan,
  ids: { bypass: string; ci: string; people: string },
): AccessAppSpec[] => [
  {
    destinations: [
      `${plan.shellHostname}${GATEWAY_CONTEXT_PATH}`,
      ...plan.hostnames
        .filter((hostname) => hostname !== plan.shellHostname)
        .flatMap((hostname) => FEDERATION_ASSET_PATHS.map((path) => `${hostname}${path}`)),
    ],
    name: PUBLIC_PATHS_APP,
    policies: [{ id: ids.bypass, precedence: 1 }],
    sessionDuration: ACCESS_SESSION_DURATION,
  },
  {
    destinations: [...plan.hostnames],
    name: STAGE_ACCESS_APP,
    policies: [
      { id: ids.people, precedence: 1 },
      { id: ids.ci, precedence: 2 },
    ],
    sessionDuration: ACCESS_SESSION_DURATION,
  },
];

const ensureAccess = (plan: CostGuardPlan) =>
  Effect.gen(function* ensureAccessEffect() {
    const api = yield* CloudflareApi;
    // The first Access read fails with the operator's to-do while Zero Trust is off.
    const policies = yield* requireAccess(api.accessPolicies);
    const tokenId = yield* ensureServiceToken(plan.repository);
    const ci = yield* ensureAccessPolicy(policies, ciPolicy(tokenId));
    // Who may sign in changes only together with the applications, never ahead of them.
    if (!plan.enforceAccess) {
      return yield* Console.log('the stage hostnames stay outside Access: STAGE_ACCESS_ENFORCE is off');
    }
    const people = yield* ensureAccessPolicy(policies, peoplePolicy);
    const bypass = yield* ensureAccessPolicy(policies, bypassPolicy);
    const apps = yield* api.accessApps;
    // The bypass paths must exist before the hostnames are gated.
    for (const spec of stageAccessApps(plan, { bypass, ci, people })) {
      yield* ensureAccessApp(apps, spec);
    }
    return yield* Effect.void;
  });

// ---------------------------------------------------------------------------------------------
// Provisioning and verification

const ensureUsageAlert = (emails: readonly string[]) =>
  Effect.gen(function* ensureUsageAlertEffect() {
    const api = yield* CloudflareApi;
    const spec = usageAlert(emails);
    const current = (yield* api.alertPolicies).find(({ name }) => name === USAGE_ALERT_NAME);
    if (current === undefined) {
      return yield* perform(`create the notification ${USAGE_ALERT_NAME}`, api.createAlertPolicy(spec));
    }
    const matches =
      current.enabled &&
      current.alert_type === spec.alert_type &&
      Option.exists(current.filters, (filters) => same(filters, spec.filters)) &&
      Option.exists(current.mechanisms, (mechanisms) => same(mechanisms, spec.mechanisms));
    return matches
      ? yield* Console.log(`notification ${USAGE_ALERT_NAME} is current`)
      : yield* perform(`update the notification ${USAGE_ALERT_NAME}`, api.updateAlertPolicy(current.id, spec));
  });

/** Creates or converges every cost guard and hands the zone ID and the CI token to stage-edge. */
export const ensureCostGuards = (plan: CostGuardPlan) =>
  Effect.gen(function* ensureCostGuardsEffect() {
    const zoneId = yield* findZoneId(plan.stageZone);
    const variables = yield* listGithubVariables(plan.repository, STAGE_EDGE_ENVIRONMENT);
    if (variables.get(ZONE_ID_VARIABLE) !== zoneId) {
      yield* perform(
        `set the ${STAGE_EDGE_ENVIRONMENT} variable ${ZONE_ID_VARIABLE}=${zoneId}`,
        setGithubVariable(plan.repository, STAGE_EDGE_ENVIRONMENT, ZONE_ID_VARIABLE, zoneId),
      );
    }
    yield* ensureKillSwitchRule(zoneId, killSwitchRule(plan.hostnames, false));
    yield* ensureAccess(plan);
    yield* ensureUsageAlert(plan.accessEmails);
  });

export type GuardCheck = readonly [label: string, failure: Option.Option<string>];

const present = (found: boolean) => (found ? Option.none<string>() : Option.some(NOT_FOUND));

/** The verification items for every cost guard, without changing anything. */
export const costGuardChecks = (plan: CostGuardPlan) =>
  Effect.gen(function* costGuardChecksEffect() {
    const api = yield* CloudflareApi;
    const zoneId = yield* findZoneId(plan.stageZone);
    const variables = yield* listGithubVariables(plan.repository, STAGE_EDGE_ENVIRONMENT);
    const killSwitch = yield* findKillSwitch(zoneId);
    const killSwitchSpec = killSwitchRule(plan.hostnames, false);
    const access = yield* api.accessPolicies.pipe(
      Effect.map(Option.some),
      Effect.catchIf(isAccessNotEnabled, () => Effect.succeed(Option.none())),
    );
    const policyIds = new Map(Option.getOrElse(access, () => []).map(({ id, name }) => [name, id]));
    const token =
      Option.isSome(access) && (yield* api.accessServiceTokens).some(({ name }) => name === ACCESS_SERVICE_TOKEN);
    const secrets = yield* listGithubSecretNames(plan.repository, STAGE_EDGE_ENVIRONMENT);
    const accessFailure = (found: boolean) => (Option.isNone(access) ? Option.some(ENABLE_ZERO_TRUST) : present(found));
    const alert = (yield* api.alertPolicies).find(({ name }) => name === USAGE_ALERT_NAME);
    const checks: GuardCheck[] = [
      [
        `the ${STAGE_EDGE_ENVIRONMENT} variable ${ZONE_ID_VARIABLE} names the ${plan.stageZone} zone`,
        variables.get(ZONE_ID_VARIABLE) === zoneId ? Option.none() : Option.some('run provision'),
      ],
      [
        `the kill switch ${KILL_SWITCH_RULE_REF} covers every stage hostname and is off`,
        Option.match(killSwitch.rule, {
          onNone: () => Option.some(NOT_FOUND),
          onSome: (rule) => {
            if (isEnabled(rule)) {
              return Option.some(
                'it blocks every stage hostname; find why usage crossed the threshold, then run resume',
              );
            }
            return ruleMatches(rule, killSwitchSpec) ? Option.none<string>() : Option.some('it drifted; run provision');
          },
        }),
      ],
      [`the Access policy ${ACCESS_CI_POLICY} exists`, accessFailure(policyIds.has(ACCESS_CI_POLICY))],
      [
        `the Access service token ${ACCESS_SERVICE_TOKEN} exists and ${STAGE_EDGE_ENVIRONMENT} holds its credentials`,
        accessFailure(token && secrets.has(ACCESS_CLIENT_ID_SECRET) && secrets.has(ACCESS_CLIENT_SECRET_SECRET)),
      ],
      [`the notification ${USAGE_ALERT_NAME} is on`, present(alert?.enabled === true)],
    ];
    if (plan.enforceAccess && Option.isSome(access)) {
      const people = Option.getOrElse(access, () => []).find(({ name }) => name === ACCESS_PEOPLE_POLICY);
      checks.push([
        `the Access policy ${ACCESS_PEOPLE_POLICY} admits anyone who signs in`,
        accessPolicyProblem(people, peoplePolicy),
      ]);
      const apps = yield* api.accessApps;
      const ids = {
        bypass: policyIds.get(ACCESS_BYPASS_POLICY) ?? '',
        ci: policyIds.get(ACCESS_CI_POLICY) ?? '',
        people: policyIds.get(ACCESS_PEOPLE_POLICY) ?? '',
      };
      for (const spec of stageAccessApps(plan, ids)) {
        const current = apps.find(({ name }) => name === spec.name);
        checks.push([
          `the Access application ${spec.name} covers its ${spec.destinations.length} destinations with its policies`,
          accessAppProblem(current, spec),
        ]);
      }
    }
    return checks;
  });

// ---------------------------------------------------------------------------------------------
// Hourly usage check

export interface UsageLimits {
  /** The day of the month the Cloudflare billing cycle starts, 1 to 28. */
  readonly billingCycleDay: number;
  readonly cpuMsLimit: number;
  /** The placed OntOS Worker names, whose share of the account's usage the log breaks out. */
  readonly ontosScripts: readonly string[];
  readonly requestLimit: number;
  readonly zoneId: string;
}

export const UsageConfiguration = Context.Service<UsageLimits>(
  '@app/scripts/ops/cloudflare-stage-cost-guard/UsageConfiguration',
);

/** The start (UTC midnight) of the billing cycle `now` falls in. */
export const billingCycleStart = (now: DateTime.Utc, billingCycleDay: number) => {
  const thisMonth = DateTime.setPartsUtc(DateTime.startOf(now, 'day'), { day: billingCycleDay });
  return DateTime.isLessThan(now, thisMonth) ? DateTime.subtract(thisMonth, { months: 1 }) : thisMonth;
};

const formatCount = (value: number) => Math.round(value).toLocaleString('en-US');

const formatShare = (requests: number, cpuTimeMs: number) =>
  `${formatCount(requests)} requests, ${formatCount(cpuTimeMs)} CPU ms`;

/** The log lines: the account total against the limits, each OntOS Worker, then everything else. */
export const usageReport = (usage: WorkersUsage, limits: UsageLimits, since: DateTime.Utc) => {
  const ontos = new Set(limits.ontosScripts);
  const own = usage.scripts.filter(({ scriptName }) => ontos.has(scriptName));
  const others = usage.scripts.filter(({ scriptName }) => !ontos.has(scriptName));
  const sum = (scripts: typeof usage.scripts) =>
    formatShare(
      scripts.reduce((total, { requests }) => total + requests, 0),
      scripts.reduce((total, { cpuTimeMs }) => total + cpuTimeMs, 0),
    );
  return [
    `account Workers usage since ${DateTime.formatIso(since)}: ${formatCount(usage.requests)} of ${formatCount(limits.requestLimit)} requests, ${formatCount(usage.cpuTimeMs)} of ${formatCount(limits.cpuMsLimit)} CPU ms`,
    `  OntOS stage Workers: ${sum(own)}`,
    ...own.map(({ cpuTimeMs, requests, scriptName }) => `    ${scriptName}: ${formatShare(requests, cpuTimeMs)}`),
    `  other Workers on the account (${String(others.length)}): ${sum(others)}`,
  ];
};

/**
 * Reads the whole account's Workers usage since the billing cycle started, because the allowance
 * is account-wide, and logs the OntOS share. Once requests or CPU time reach their limit it turns
 * the OntOS kill switch on and fails so GitHub notifies. It never turns the switch off and never
 * touches another project's Workers.
 */
export const checkUsage = (now: DateTime.Utc) =>
  Effect.gen(function* checkUsageEffect() {
    const api = yield* CloudflareApi;
    const limits = yield* UsageConfiguration;
    const since = billingCycleStart(now, limits.billingCycleDay);
    const usage = yield* api.workersUsage(since, now);
    const report = usageReport(usage, limits, since);
    yield* Console.log(report.join('\n'));
    if (usage.requests >= limits.requestLimit || usage.cpuTimeMs >= limits.cpuMsLimit) {
      yield* setKillSwitch(limits.zoneId, true);
      return yield* new StageOperationError({
        message:
          "account Workers usage reached its limit; the kill switch now blocks every OntOS stage hostname. Other projects' Workers are not touched, so check the breakdown above: if they drive the usage, blocking OntOS stage alone will not stop the bill. Find the cause, then run cloudflare-stage-cutover resume",
      });
    }
    return yield* Effect.void;
  });

// ---------------------------------------------------------------------------------------------
// Composition root (the hourly workflow)

const BillingCycleDay = Config.Int('STAGE_BILLING_CYCLE_DAY').pipe(Config.withDefault(1));

const loadUsageLimits = Effect.gen(function* loadUsageLimitsEffect() {
  const limits: UsageLimits = {
    billingCycleDay: yield* BillingCycleDay,
    cpuMsLimit: yield* Config.Int('STAGE_WORKERS_CPU_MS_LIMIT').pipe(Config.withDefault(DEFAULT_CPU_MS_LIMIT)),
    ontosScripts: (yield* readEdgeUnits).map(({ workerName }) => workerName),
    requestLimit: yield* Config.Int('STAGE_WORKERS_REQUEST_LIMIT').pipe(Config.withDefault(DEFAULT_REQUEST_LIMIT)),
    zoneId: yield* Config.NonEmptyString(ZONE_ID_VARIABLE),
  };
  if (limits.billingCycleDay < 1 || limits.billingCycleDay > 28) {
    return yield* new StageOperationError({ message: 'STAGE_BILLING_CYCLE_DAY must be between 1 and 28' });
  }
  return limits;
});

const usageLayer = Layer.mergeAll(
  CloudflareApiLive.pipe(
    Layer.provide(
      Layer.effect(
        CloudflareCredentials,
        Effect.gen(function* credentials() {
          return {
            accountId: yield* Config.NonEmptyString('CLOUDFLARE_ACCOUNT_ID'),
            apiToken: yield* Config.Redacted('CLOUDFLARE_API_TOKEN'),
          };
        }),
      ),
    ),
  ),
  Layer.effect(UsageConfiguration, loadUsageLimits),
  Layer.succeed(OpsMode, { dryRun: false }),
);

const cli = Command.make('cloudflare-stage-cost-guard').pipe(
  Command.withSubcommands([
    Command.make('check', {}, () => DateTime.now.pipe(Effect.flatMap((now) => checkUsage(now)))).pipe(
      Command.withDescription(
        "Compare this billing cycle's Workers usage with the limits and trip the kill switch when it reaches them",
      ),
      Command.provide(usageLayer),
    ),
  ]),
);

const main = Command.run({ version: '1.0.0' })(cli);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(main).pipe(Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
    ).pipe(Effect.scoped),
  );
}
