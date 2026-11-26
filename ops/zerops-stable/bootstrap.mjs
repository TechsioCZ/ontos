#!/usr/bin/env node
/**
 * Stable account bootstrap: clean tenants and accounts for a new stable project, never a copy of the demo database.
 *
 *   node ops/zerops-stable/bootstrap.mjs accounts --provision-spec <provision-spec.json> --spec <bootstrap-spec.json>
 *       --credentials <credentials.json> --output <stage-accounts.json> --variables-output <storefront-variables.json>
 *     Writes the operator accounts file that `app/apps/shell-super-app/scripts/bootstrap-stage-accounts.mts` reads
 *     (ADR-0028, schemaVersion 2), mode 600. Every ID is new (random UUIDs) and kept on reruns: an existing output is
 *     read back and its tenants (by slug) and accounts (by email) keep their IDs, so the insert-only native bootstrap
 *     changes nothing on a rerun. Passwords come only from the external credentials file. It also writes each
 *     storefront service's identity variables (app id, brand, company, N1 tenant) for `provision.mjs --resolve
 *     --variables`. Nothing is written to Zerops; this step runs before the stable config exists.
 *   node ops/zerops-stable/bootstrap.mjs storefront-keys --stable-config <stable.json> --spec <bootstrap-spec.json>
 *       --credentials <credentials.json> --accounts <stage-accounts.json> --keys-dir <dir> [--apply]
 *     Signs in to the stable Shell as each storefront tenant's owner and, with `--apply`, creates the storefront's
 *     service Principal and issues its tenant-managed key through the Shell's own identity API. Each key is written
 *     once to `<dir>/<projectId>-<storefrontAppId>.key` (mode 600, never overwritten, never printed), with the
 *     `register-stage-workloads.mts` registrations file beside it. Without `--apply` it only reads and prints the plan.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadStableConfig, StableConfigError } from './config.mjs';
import {
  loadDemoIdentities,
  loadProvisionSpec,
  readJsonFile,
  refuseDemoReferences,
  writeFileAtomically,
} from './provision.mjs';

export const CATALOG_PATH = fileURLToPath(new URL('../../app/topology/authorization-catalog.json', import.meta.url));
/** Demo fixture login domains; a stable account never signs in as one. */
const DEMO_EMAIL_DOMAINS = ['demo.ontos', 'ontos.demo'];
/** The storefront key variable each storefront service reads at start (`app/zerops.yaml`). */
export const STOREFRONT_KEY_VARIABLES = {
  n1: 'ONTOS_N1_STOREFRONT_API_KEY',
  shop: 'ONTOS_AKROS_STOREFRONT_API_KEY',
  storefront: 'ONTOS_AKROS_STOREFRONT_API_KEY',
};
const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/giu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const APP_ID = /^[a-z][\da-z-]*$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const OWNER_ONLY = 0o077;

const refuse = (message) => {
  throw new StableConfigError(message);
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value, where) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : refuse(`${where} must be a non-empty string`);
const keysOnly = (value, allowed, where) => {
  if (!isRecord(value)) refuse(`${where} must be an object`);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) refuse(`${where} has unknown keys ${extra.join(', ')}`);
  return value;
};
const unique = (values, message) => {
  if (new Set(values).size !== values.length) refuse(message);
};

/** The catalog the deployment ships: its module IDs and declared workload keys. */
export const loadCatalog = (file = CATALOG_PATH) => {
  const catalog = readJsonFile(file, 'Authorization catalog');
  return {
    moduleIds: new Set(catalog.modules.map(({ moduleId }) => moduleId)),
    workloadKeys: new Set(catalog.declaredWorkloadKeys),
  };
};

/**
 * The bootstrap spec: tenants by slug, their companies, accounts (no IDs, no passwords) and storefronts. A tenant's
 * storefront runs on one stable storefront service and acts for the tenant's own company.
 */
export const parseBootstrapSpec = (value, catalog) => {
  keysOnly(value, ['schemaVersion', 'tenants'], 'spec');
  if (value.schemaVersion !== 1) refuse('spec.schemaVersion must be 1');
  if (!Array.isArray(value.tenants) || value.tenants.length === 0) refuse('spec.tenants must list at least one tenant');
  const tenants = value.tenants.map((tenant, index) => {
    const at = `spec.tenants[${index}]`;
    keysOnly(
      tenant,
      ['slug', 'displayName', 'defaultLocale', 'moduleKey', 'legalEntity', 'accounts', 'storefronts'],
      at,
    );
    const slug = text(tenant.slug, `${at}.slug`);
    if (!SLUG.test(slug)) refuse(`${at}.slug must be a lowercase slug`);
    const moduleKey = text(tenant.moduleKey, `${at}.moduleKey`);
    if (!catalog.moduleIds.has(moduleKey)) refuse(`${at}.moduleKey ${moduleKey} is not a module of the catalog`);
    keysOnly(tenant.legalEntity, ['legalName', 'registrationCountry', 'registrationNumber'], `${at}.legalEntity`);
    const registrationCountry = text(tenant.legalEntity.registrationCountry, `${at}.legalEntity.registrationCountry`);
    if (!/^[A-Z]{2}$/u.test(registrationCountry)) refuse(`${at}.legalEntity.registrationCountry must be ISO alpha-2`);
    if (!Array.isArray(tenant.accounts) || tenant.accounts.length === 0) refuse(`${at}.accounts must not be empty`);
    const accounts = tenant.accounts.map((account, accountIndex) => {
      const accountAt = `${at}.accounts[${accountIndex}]`;
      keysOnly(account, ['email', 'displayName', 'owner', 'roles'], accountAt);
      const email = text(account.email, `${accountAt}.email`).toLowerCase();
      if (!EMAIL.test(email)) refuse(`${accountAt}.email must be an email address`);
      if (DEMO_EMAIL_DOMAINS.some((domain) => email.endsWith(`@${domain}`))) {
        refuse(`${accountAt}.email is a demo fixture login`);
      }
      if (typeof account.owner !== 'boolean') refuse(`${accountAt}.owner must be true or false`);
      if (!Array.isArray(account.roles) || account.roles.some((role) => role !== 'full_access')) {
        refuse(`${accountAt}.roles may name only full_access`);
      }
      unique(account.roles, `${accountAt}.roles must be unique`);
      return {
        displayName: text(account.displayName, `${accountAt}.displayName`),
        email,
        owner: account.owner,
        roles: [...account.roles],
      };
    });
    if (accounts.filter(({ owner }) => owner).length !== 1) refuse(`${at} needs exactly one owner account`);
    const storefronts = (tenant.storefronts ?? []).map((storefront, storefrontIndex) => {
      const storefrontAt = `${at}.storefronts[${storefrontIndex}]`;
      keysOnly(storefront, ['storefrontAppId', 'service', 'brand', 'workloadKeys'], storefrontAt);
      const storefrontAppId = text(storefront.storefrontAppId, `${storefrontAt}.storefrontAppId`);
      if (!APP_ID.test(storefrontAppId) || storefrontAppId.length > 32) {
        refuse(`${storefrontAt}.storefrontAppId must be a lowercase app id of at most 32 characters (the key name)`);
      }
      if (!Object.hasOwn(STOREFRONT_KEY_VARIABLES, storefront.service)) {
        refuse(`${storefrontAt}.service must be one of ${Object.keys(STOREFRONT_KEY_VARIABLES).join(', ')}`);
      }
      // The AKROS storefront build serves `storefront` and `shop` and reads its brand; N1 has its own build and none.
      const brand = storefront.service === 'n1' ? undefined : text(storefront.brand, `${storefrontAt}.brand`);
      if (storefront.service === 'n1' && storefront.brand !== undefined)
        refuse(`${storefrontAt}.brand is not read by n1`);
      if (!Array.isArray(storefront.workloadKeys) || storefront.workloadKeys.length === 0) {
        refuse(`${storefrontAt}.workloadKeys must not be empty`);
      }
      for (const key of storefront.workloadKeys) {
        if (!catalog.workloadKeys.has(key))
          refuse(`${storefrontAt}.workloadKeys ${key} is not declared by the catalog`);
      }
      unique(storefront.workloadKeys, `${storefrontAt}.workloadKeys must be unique`);
      return { brand, service: storefront.service, storefrontAppId, workloadKeys: [...storefront.workloadKeys] };
    });
    return {
      accounts,
      defaultLocale: text(tenant.defaultLocale, `${at}.defaultLocale`),
      displayName: text(tenant.displayName, `${at}.displayName`),
      legalEntity: {
        legalName: text(tenant.legalEntity.legalName, `${at}.legalEntity.legalName`),
        registrationCountry,
        registrationNumber: text(tenant.legalEntity.registrationNumber, `${at}.legalEntity.registrationNumber`),
      },
      moduleKey,
      slug,
      storefronts,
    };
  });
  unique(
    tenants.map(({ slug }) => slug),
    'spec tenant slugs must be unique',
  );
  unique(
    tenants.flatMap(({ accounts }) => accounts.map(({ email }) => email)),
    'spec account emails must be unique',
  );
  const storefronts = tenants.flatMap(({ storefronts: list }) => list);
  unique(
    storefronts.map(({ storefrontAppId }) => storefrontAppId),
    'spec storefront app ids must be unique',
  );
  unique(
    storefronts.map(({ service }) => service),
    'each storefront service serves one storefront',
  );
  return { schemaVersion: 1, tenants };
};

/** Reads a file the owner alone may read (mode 600): credentials and the accounts file hold passwords. */
const readOwnerOnlyJson = (file, what) => {
  if (!existsSync(file)) refuse(`${what} ${file} does not exist`);
  if ((statSync(file).mode & OWNER_ONLY) !== 0)
    refuse(`${what} ${file} must be readable only by its owner (chmod 600)`);
  return readJsonFile(file, what);
};

/** The external credentials file: `{ "schemaVersion": 1, "passwords": { "<email>": "<password>" } }`, mode 600. */
export const parseCredentials = (value, spec) => {
  keysOnly(value, ['schemaVersion', 'passwords'], 'credentials');
  if (value.schemaVersion !== 1 || !isRecord(value.passwords))
    refuse('credentials must be schemaVersion 1 with passwords');
  const passwords = new Map(
    Object.entries(value.passwords).map(([email, password]) => [email.toLowerCase(), password]),
  );
  const emails = spec.tenants.flatMap(({ accounts }) => accounts.map(({ email }) => email));
  for (const email of emails) {
    const password = passwords.get(email);
    if (typeof password !== 'string' || password.length < 8)
      refuse(`credentials need a password of 8+ characters for ${email}`);
  }
  const stale = [...passwords.keys()].filter((email) => !emails.includes(email));
  if (stale.length > 0) refuse(`credentials name accounts the spec does not: ${stale.join(', ')}`);
  return passwords;
};

/**
 * The accounts file for the native bootstrap. IDs of an earlier output are kept (tenant by slug, account by email);
 * only new tenants and accounts get new random IDs. A tenant of the earlier output the spec no longer lists is
 * refused: the native bootstrap never removes one, so it must be retired explicitly (`retiredTenants`).
 */
export const buildAccountsFile = (spec, passwords, previous, { demoIdentities, newId = randomUUID }) => {
  const previousTenants = new Map((previous?.tenants ?? []).map((tenant) => [tenant.slug, tenant]));
  const dropped = [...previousTenants.keys()].filter((slug) => !spec.tenants.some((tenant) => tenant.slug === slug));
  if (dropped.length > 0)
    refuse(`The earlier accounts file has tenants the spec dropped: ${dropped.join(', ')}; retire them explicitly`);
  const reused = JSON.stringify(previous ?? {}).match(UUID) ?? [];
  const demo = reused.find((id) => demoIdentities.has(id.toLowerCase()));
  if (demo !== undefined) refuse(`The earlier accounts file reuses the demo identity ${demo}; stable IDs must be new`);
  const tenants = spec.tenants.map((tenant) => {
    const earlier = previousTenants.get(tenant.slug);
    const earlierAccounts = new Map((earlier?.accounts ?? []).map((account) => [account.email.toLowerCase(), account]));
    return {
      accounts: tenant.accounts.map((account) => {
        const kept = earlierAccounts.get(account.email);
        return {
          authBindingId: kept?.authBindingId ?? newId(),
          displayName: account.displayName,
          email: account.email,
          grants: { owner: account.owner, roles: account.roles },
          password: passwords.get(account.email),
          principalId: kept?.principalId ?? newId(),
        };
      }),
      defaultLocale: tenant.defaultLocale,
      displayName: tenant.displayName,
      legalEntity: { legalEntityId: earlier?.legalEntity.legalEntityId ?? newId(), ...tenant.legalEntity },
      moduleKey: tenant.moduleKey,
      moduleStateId: earlier?.moduleStateId ?? newId(),
      slug: tenant.slug,
      tenantId: earlier?.tenantId ?? newId(),
    };
  });
  return {
    retiredAccountEmails: previous?.retiredAccountEmails ?? [],
    retiredTenants: previous?.retiredTenants ?? [],
    schemaVersion: 2,
    tenants,
  };
};

/**
 * The identity variables each storefront setup takes in the stable config (config.mjs `STABLE_VARIABLES`): the
 * company it sells for, and its application and brand, or for N1 its tenant. Operator variables (SMTP, image hosts,
 * ERP offers) come from a second `--variables` file.
 */
export const storefrontServiceVariables = (spec, accountsFile) =>
  Object.fromEntries(
    spec.tenants.flatMap((tenant) => {
      const written = accountsFile.tenants.find(({ slug }) => slug === tenant.slug);
      const legalEntityId = written.legalEntity.legalEntityId;
      return tenant.storefronts.map(({ brand, service, storefrontAppId }) => [
        service,
        service === 'n1'
          ? { ONTOS_STOREFRONT_LEGAL_ENTITY_ID: legalEntityId, ONTOS_STOREFRONT_TENANT_ID: written.tenantId }
          : {
              ONTOS_STOREFRONT_APP_ID: storefrontAppId,
              ONTOS_STOREFRONT_LEGAL_ENTITY_ID: legalEntityId,
              STOREFRONT_BRAND: brand,
            },
      ]);
    }),
  );

/**
 * The native operator sequence of `app/docs/architecture/DEPLOYMENT.md` ("Running it on stage"), run against the
 * stable project once its first release is live. The project ID is the one `provision.mjs --resolve` recorded.
 */
export const accountsOperatorSteps = (accountsPath) => [
  `STABLE_PROJECT_ID="$(node -p 'require("./stable.json").projectId')"; zcli vpn up --project-id "$STABLE_PROJECT_ID"`,
  `scp -p ${accountsPath} app:/tmp/stage-accounts.json`,
  'ssh app',
  'cd /var/www/app/apps/shell-super-app && umask 077',
  'export ONTOS_STAGE_ACCOUNTS_FILE=/tmp/stage-accounts.json BETTER_AUTH_URL="$ONTOS_PUBLIC_ORIGIN"',
  `export BETTER_AUTH_SECRET="$(node -e 'try { process.stdout.write(JSON.parse(process.env.ONTOS_OWNER_SECRETS_JSON)["shell-super-app"].BETTER_AUTH_SECRET) } catch { process.exit(1) }')"`,
  'node scripts/bootstrap-stage-accounts.mts                       # dry run: check every line',
  'node scripts/bootstrap-stage-accounts.mts --commit; STAGE_ACCOUNTS_COMMIT_EXIT=$?',
  'node scripts/bootstrap-stage-accounts.mts; STAGE_ACCOUNTS_VERIFY_EXIT=$?',
  `if [ "\${STAGE_ACCOUNTS_COMMIT_EXIT:-1}" = 0 ] && [ "\${STAGE_ACCOUNTS_VERIFY_EXIT:-1}" = 0 ]; then rm /tmp/stage-accounts.json; fi`,
];

const SHELL_API = '/shell-super-app-api/auth';

/** The Shell signs a `__Secure-` session cookie that its API-key instance reads without the prefix: send both. */
export const sessionCookieHeader = (setCookies) => {
  const pairs = setCookies.map((cookie) => cookie.split(';')[0].trim()).filter((pair) => pair.includes('='));
  const aliases = pairs.filter((pair) => pair.startsWith('__Secure-')).map((pair) => pair.slice('__Secure-'.length));
  return [...pairs, ...aliases].join('; ');
};

/** The Shell's own identity API, as the product's managed-key screens call it. Secrets never reach an error. */
export const makeShellIdentityClient = ({ fetch: request = fetch, origin }) => {
  const post = async (route, body, headers) => {
    const response = await request(`${origin}${SHELL_API}${route}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin, 'x-correlation-id': randomUUID(), ...headers },
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) refuse(`POST ${SHELL_API}${route} answered HTTP ${response.status}`);
    return response;
  };
  return {
    createServicePrincipal: async (cookie, displayName, idempotencyKey) => {
      const body = await (
        await post(
          '/identity/principals',
          { displayName, kind: 'service' },
          { cookie, 'idempotency-key': idempotencyKey },
        )
      ).json();
      return typeof body.principalId === 'string' ? body.principalId : refuse(`No principal ID for ${displayName}`);
    },
    issueManagedKey: async (cookie, principalId, name) => {
      const body = await (
        await post(
          '/identity/api-keys/managed',
          { name, principalId, scope: 'tenant-managed' },
          { cookie, 'idempotency-key': `stable-storefront-key-${name}-${randomUUID()}` },
        )
      ).json();
      return typeof body.secret === 'string' && body.secret.length > 0
        ? body.secret
        : refuse(`No key issued for ${name}`);
    },
    listManaged: async (cookie) => {
      const items = [];
      for (let offset = 0; offset !== null;) {
        const page = await (
          await post('/identity/api-keys/managed/list', { limit: 100, offset, scope: 'tenant-managed' }, { cookie })
        ).json();
        items.push(...page.items);
        offset = page.nextOffset;
      }
      return items;
    },
    signIn: async (email, password) => {
      const response = await post('/sign-in', { email, password }, {});
      const cookies = response.headers.getSetCookie();
      return cookies.length > 0 ? sessionCookieHeader(cookies) : refuse(`Sign-in as ${email} set no session`);
    },
  };
};

const keyFileOf = (keysDir, projectId, storefrontAppId) => path.join(keysDir, `${projectId}-${storefrontAppId}.key`);

/**
 * Ensures each storefront's service Principal and managed key through the Shell, idempotently: a Principal found by
 * display name (the storefront app id) is reused, and a key is issued only when the Principal has none. A Principal
 * whose key exists but whose local key file does not is refused, because rotating it would cut off a running shop.
 */
export const ensureStorefrontKeys = async ({ accountsFile, apply, client, keysDir, log, passwords, spec, stable }) => {
  const registrations = [];
  for (const tenant of spec.tenants.filter(({ storefronts }) => storefronts.length > 0)) {
    const written = accountsFile.tenants.find(({ slug }) => slug === tenant.slug);
    if (written === undefined) refuse(`The accounts file has no tenant ${tenant.slug}; run the accounts step first`);
    const owner = written.accounts.find(({ grants }) => grants.owner);
    const cookie = await client.signIn(owner.email, passwords.get(owner.email));
    const managed = await client.listManaged(cookie);
    const workloads = [];
    for (const storefront of tenant.storefronts) {
      const keyFile = keyFileOf(keysDir, stable.projectId, storefront.storefrontAppId);
      const found = managed.filter((item) => item.displayName === storefront.storefrontAppId);
      if (found.length > 1)
        refuse(`Tenant ${tenant.slug} has ${found.length} principals named ${storefront.storefrontAppId}`);
      let principalId = found[0]?.principalId;
      if (found[0] !== undefined && (found[0].kind !== 'service' || found[0].principalStatus !== 'active')) {
        refuse(`Principal ${storefront.storefrontAppId} of ${tenant.slug} is not an active service principal`);
      }
      const hasKey = found[0]?.key !== null && found[0]?.key !== undefined;
      if (hasKey && !existsSync(keyFile)) {
        refuse(
          `${storefront.storefrontAppId} already has a managed key but ${keyFile} is missing; rotate it deliberately ` +
            `(POST ${SHELL_API}/identity/api-keys/managed/rotate) and resync ${STOREFRONT_KEY_VARIABLES[storefront.service]}`,
        );
      }
      if (!hasKey && existsSync(keyFile))
        refuse(`${keyFile} exists but the Shell has no key for it; it is not this environment's`);
      if (principalId === undefined) {
        log(`${apply ? 'Creating' : 'Would create'} service principal ${storefront.storefrontAppId} in ${tenant.slug}`);
        if (apply) {
          principalId = await client.createServicePrincipal(
            cookie,
            storefront.storefrontAppId,
            `stable-storefront-principal-${stable.projectId}-${storefront.storefrontAppId}`,
          );
        }
      }
      if (!hasKey) {
        log(`${apply ? 'Issuing' : 'Would issue'} managed key ${storefront.storefrontAppId} -> ${keyFile}`);
        if (apply) {
          const secret = await client.issueManagedKey(cookie, principalId, storefront.storefrontAppId);
          writeFileSync(keyFile, secret, { flag: 'wx', mode: 0o600 });
        }
      } else {
        log(`Storefront ${storefront.storefrontAppId}: principal ${principalId} and key present`);
      }
      if (principalId !== undefined) {
        workloads.push(
          ...storefront.workloadKeys.map((workloadKey) => ({
            legalEntityId: written.legalEntity.legalEntityId,
            principalId,
            workloadKey,
          })),
        );
      }
    }
    registrations.push({ ownerPrincipalId: owner.principalId, tenantId: written.tenantId, workloads });
  }
  return { schemaVersion: 1, tenants: registrations };
};

/** What remains native and operator-run after the keys exist; nothing here is claimed done. */
export const storefrontOperatorSteps = (spec, stable, keysDir, registrationsPath) => [
  `zcli vpn up --project-id ${stable.projectId}; scp -p ${registrationsPath} app:/tmp/stable-workloads.json; ssh app`,
  'cd /var/www/app && node scripts/demo/register-stage-workloads.mts --registrations /tmp/stable-workloads.json --mode dry-run',
  'node scripts/demo/register-stage-workloads.mts --registrations /tmp/stable-workloads.json --mode apply --reviewed-plan-sha256 <fingerprint printed by the dry run>',
  'node scripts/demo/register-stage-workloads.mts --registrations /tmp/stable-workloads.json --mode verify && rm /tmp/stable-workloads.json',
  ...spec.tenants.flatMap((tenant) =>
    tenant.storefronts.map(
      ({ storefrontAppId }) =>
        `As the ${tenant.slug} owner in ${stable.origins.shell}: Action commerce.storefront-registry.register-storefront-application ` +
        `{ storefrontAppId: "${storefrontAppId}", lifecycle: "ACTIVE", allowedChannels, effectiveInterval, reason }, then ` +
        'commerce.market-catalog.associate-storefront for each market the tenant sells through it (after its catalog import)',
    ),
  ),
  ...spec.tenants.flatMap((tenant) =>
    tenant.storefronts.map(
      ({ service, storefrontAppId }) =>
        `STOREFRONT_KEY="$(cat ${keyFileOf(keysDir, stable.projectId, storefrontAppId)})" ZEROPS_TOKEN=<token> ` +
        `bash app/scripts/zerops/sync-service-secret.sh ${stable.services[service]} ${STOREFRONT_KEY_VARIABLES[service]} STOREFRONT_KEY`,
    ),
  ),
];

const USAGE = [
  'Usage:',
  '  bootstrap.mjs accounts --provision-spec <provision-spec.json> --spec <spec.json> --credentials <credentials.json>',
  '                --output <accounts.json> --variables-output <storefront-variables.json>',
  '  bootstrap.mjs storefront-keys --stable-config <stable.json> --spec <spec.json> --credentials <credentials.json>',
  '                --accounts <accounts.json> --keys-dir <dir> [--apply]',
].join('\n');

const FLAGS = {
  accounts: {
    required: ['--provision-spec', '--spec', '--credentials', '--output', '--variables-output'],
    switches: [],
  },
  'storefront-keys': {
    required: ['--stable-config', '--spec', '--credentials', '--accounts', '--keys-dir'],
    switches: ['--apply'],
  },
};

/** Reads the command line exactly: one command, its required paths once each, and its switches. */
export const parseArguments = ([command, ...rest]) => {
  const flags = FLAGS[command] ?? refuse(USAGE);
  const options = { apply: false, command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flags.switches.includes(flag) && options.apply === false) {
      options.apply = true;
    } else if (flags.required.includes(flag) && options[flag] === undefined) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) refuse(`${flag} needs a path\n${USAGE}`);
      options[flag] = value;
      index += 1;
    } else {
      refuse(`Unexpected argument ${flag}\n${USAGE}`);
    }
  }
  const missing = flags.required.filter((flag) => options[flag] === undefined);
  if (missing.length > 0) refuse(`Missing ${missing.join(', ')}\n${USAGE}`);
  return options;
};

export const main = async (
  argv,
  { catalog = loadCatalog(), client, demoIdentities = loadDemoIdentities(), log = console.log } = {},
) => {
  const options = parseArguments(argv);
  const spec = parseBootstrapSpec(readJsonFile(options['--spec'], 'Bootstrap spec'), catalog);
  const passwords = parseCredentials(readOwnerOnlyJson(options['--credentials'], 'Credentials file'), spec);
  if (options.command === 'accounts') {
    const target = loadProvisionSpec(options['--provision-spec']);
    const output = options['--output'];
    const previous = existsSync(output) ? readOwnerOnlyJson(output, 'Earlier accounts file') : undefined;
    const accountsFile = buildAccountsFile(spec, passwords, previous, { demoIdentities });
    const variables = refuseDemoReferences(
      storefrontServiceVariables(spec, accountsFile),
      { demoIdentities, demoProjectId: target.demoProjectId },
      'storefront variables',
    );
    writeFileAtomically(output, `${JSON.stringify(accountsFile, null, 2)}\n`, 0o600);
    writeFileAtomically(options['--variables-output'], `${JSON.stringify(variables, null, 2)}\n`, 0o644);
    log(`Accounts file for "${target.projectName}" written to ${output} (mode 600; passwords not printed)`);
    for (const tenant of accountsFile.tenants) {
      const emails = tenant.accounts.map(({ email }) => email).join(',');
      log(
        `  ${tenant.slug}: tenant=${tenant.tenantId} legalEntity=${tenant.legalEntity.legalEntityId} accounts=${emails}`,
      );
    }
    log(
      `Storefront identity variables written to ${options['--variables-output']} (pass to provision.mjs --resolve --variables).`,
    );
    log('Once the first stable release is live, on the stable app container:');
    for (const step of accountsOperatorSteps(output)) log(`  ${step}`);
    return accountsFile;
  }
  const stable = await loadStableConfig(options['--stable-config']);
  const accountsFile = readOwnerOnlyJson(options['--accounts'], 'Accounts file');
  const keysDir = options['--keys-dir'];
  if (!existsSync(keysDir) || (statSync(keysDir).mode & OWNER_ONLY) !== 0) {
    refuse(`${keysDir} must be an existing directory of mode 700`);
  }
  const registrations = await ensureStorefrontKeys({
    accountsFile,
    apply: options.apply,
    client: client ?? makeShellIdentityClient({ origin: stable.origins.shell }),
    keysDir,
    log,
    passwords,
    spec,
    stable,
  });
  if (!options.apply) {
    log('Dry run: nothing was created. Rerun with --apply.');
    return registrations;
  }
  const registrationsPath = path.join(keysDir, `${stable.projectId}-workload-registrations.json`);
  writeFileAtomically(registrationsPath, `${JSON.stringify(registrations, null, 2)}\n`, 0o600);
  log(`Workload registrations written to ${registrationsPath}. Remaining native operator steps:`);
  for (const step of storefrontOperatorSteps(spec, stable, keysDir, registrationsPath)) log(`  ${step}`);
  return registrations;
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof StableConfigError ? error.message : `Bootstrap failed: ${String(error)}`);
    process.exitCode = 1;
  }
}
