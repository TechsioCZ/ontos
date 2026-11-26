# Release the stable sales environment

Use this runbook to provision and manually update the independent sales and customer Zerops project.
Stable runs a delayed commit from `demo/sales-crm`, not a separate maintained branch.
Akros and N1 retain real customer data. ŠroubShop and verification tenants hold synthetic data.
Real email, MCP, and Symmy integrations remain enabled.

No paid project has been created by these tools yet. Obtain approval before provisioning paid resources.
Local tests do not prove the live Zerops API, builds, or customer journeys.

## Prepare the release machine

1. Use Node 24 or newer, Git, OpenSSL, and the app dependencies from `app/pnpm-lock.yaml`.
2. Install the app workspace on a prepared Linux runner. Do not run full builds, Docker, or dependency installs on the personal laptop.
3. Install `zcli` and sign in to the intended organization. Connect the stable project's VPN for database operations.
4. Install PostgreSQL 18 client tools. Set `PG_BIN_DIR` if the binaries are not on `PATH`.
5. For manual upload, put Bash 5, GNU find, GNU tar, jq, and curl on `PATH`.
6. For verification, install the app's Playwright Chromium dependencies on a runner with a fixed public IP.

Run the commands below from the repository root. The tools resolve `yaml` from the app's existing dependency installation.
Do not install a second ops package or create another lockfile.
Keep credentials, backups, and downloaded packages under the gitignored `app/.zerops-stable/` directory.
Set private files to mode `600` and private directories to mode `700`.
Never put credentials in a tag, config file, artifact, or command argument.

Use a clean checkout of the exact published tag for `initialize`, migration rehearsal, and builds.
Those commands execute the tagged app's native database code.
Do not change the shared development checkout to run a release.

## Provision once

Replace uppercase paths and IDs in the commands with operator-owned values.
The JSON examples beside this runbook contain placeholders, not usable customer configuration.

1. Copy `provision-spec.example.json`. Choose a new project name, the organization, four new origins, and the existing demo project ID.
2. Render the topology without a live change:

   ```sh
   node ops/zerops-stable/provision.mjs --config SPEC --output IMPORT
   ```

3. After paid-resource approval, create the project:

   ```sh
   node ops/zerops-stable/provision.mjs --config SPEC --output IMPORT --apply --confirm-paid-resources
   ```

4. Fill `bootstrap-spec.example.json` and a private account-password file. Use real owner addresses and company information for customers.
5. Generate the native accounts file and storefront identity variables:

   ```sh
   node ops/zerops-stable/bootstrap.mjs accounts --provision-spec SPEC --spec BOOTSTRAP_SPEC --credentials PASSWORDS --output ACCOUNTS --variables-output STOREFRONT_VARIABLES
   ```

   A rerun preserves the IDs of existing accounts and tenants. Do not copy the demo database, customer identities, keys, or ERP routes.

6. Resolve the newly assigned project and service IDs:

   ```sh
   node ops/zerops-stable/provision.mjs --config SPEC --resolve --variables OPERATOR_VARIABLES --variables STOREFRONT_VARIABLES --output CONFIG
   ```

   `example.config.json` describes the config shape. Supply stable mail settings and explicitly authorized Symmy policies in `OPERATOR_VARIABLES`.
   Omitted Symmy policies do not inherit demo policies.

7. Create fresh internal secrets, then inspect and apply them:

   ```sh
   node ops/zerops-stable/secrets.mjs init --config CONFIG --output SECRETS
   node ops/zerops-stable/secrets.mjs sync --config CONFIG --file SECRETS
   node ops/zerops-stable/secrets.mjs sync --config CONFIG --file SECRETS --apply
   ```

   Set `ZEROPS_TOKEN` in the environment for authenticated reads and writes.
   Supply real SMTP and integration credentials in a separate private bundle of the same schema.
   Owner-secret bundles merge by owner and key, preserving existing authentication secrets.
   Replacements require `--confirm-rotation`. Do not regenerate internal secrets to perform a normal update.
   Issue `COMMERCE_TENANT_CREDENTIALS` through the native tenant credential flow. Random strings are not valid tenant credentials.

8. Configure Zerops public HTTPS routes for all four new origins. Proxy their DNS records through Cloudflare and use SSL Full (strict).
   Leave demo DNS, service IDs, routing, databases, and credentials unchanged.
9. Set `CLOUDFLARE_API_TOKEN` with Zone Read, DNS Read, and WAF Write for the stable zone.
   Set `STABLE_EDGE_FILE` to a private JSON file:

   ```json
   {"schemaVersion":1,"projectId":"STABLE_PROJECT_ID","zoneId":"32_HEX_CHARACTERS","verifierIps":["YOUR_FIXED_PUBLIC_IP"]}
   ```

10. Close the maintenance gate before the first app installation:

    ```sh
    node ops/zerops-stable/maintenance.mjs enter --config CONFIG --confirm-project PROJECT_ID
    ```

## Install the first candidate

1. Pin and publish a candidate that contains this tooling and the shared runtime fixes:

   ```sh
   node ops/zerops-stable/release.mjs pin --tag sales-stable/YYYY-MM-DD --push
   ```

   Pinning accepts only commits on the published demo line. It never replaces an existing tag.

2. Set the GitHub environment `sales-stable` secret `STABLE_CONFIG_JSON` to the stable config.
3. Dispatch **Zerops Stable Release** on `demo/sales-crm` with that tag. Download the `sales-stable-release-COMMIT` artifact.
   CI builds only. It never creates the project, installs a release, or receives customer backups or verification credentials.
4. On the prepared, clean tagged runner, initialize the new database roles and SpiceDB:

   ```sh
   node ops/zerops-stable/initialize.mjs --config CONFIG --secrets SECRETS --tag TAG
   node ops/zerops-stable/initialize.mjs --config CONFIG --secrets SECRETS --tag TAG --apply
   ```

   Set `DATABASE_ADMIN_URL` to the stable db18 superuser URL and set `ZEROPS_TOKEN`.
   The initializer refuses an existing application database without its project marker or any previously deployed app or storefront.

5. Install the app alone behind the maintenance gate:

   ```sh
   node ops/zerops-stable/deploy.mjs --config CONFIG --tag TAG --artifacts ARTIFACTS --maintenance-confirmed --bootstrap-app --execute
   ```

6. Apply `ACCOUNTS` using the exact native dry-run, commit, and verification commands printed by `bootstrap.mjs accounts`.
   Remove the copied account-password file from the container afterward.
7. Issue independent storefront keys:

   ```sh
   node ops/zerops-stable/bootstrap.mjs storefront-keys --stable-config CONFIG --spec BOOTSTRAP_SPEC --credentials PASSWORDS --accounts ACCOUNTS --keys-dir KEYS --apply
   ```

8. Complete the printed native workload registration and storefront application registration steps.
   Import customer catalogs only with their authorized credentials. Associate each storefront with its actual market.
   Install each key in its named service. The three storefronts do not share customer credentials with demo.
9. Install the storefronts with the same tag and packages:

   ```sh
   node ops/zerops-stable/deploy.mjs --config CONFIG --tag TAG --artifacts ARTIFACTS --maintenance-confirmed --execute
   ```

10. Configure the verification accounts, dedicated synthetic ERP company and order, and a real receiving inbox with a Mailpit-compatible API.
    Use `verify-manifest.example.json` for the private verification manifest.
    The MCP persona must be a human in its own company with `work.tasks` writes and proposal review only.
    Record its actual principal and company IDs. The proof does not require the demo's IDs.
11. Take the first maintenance backup and rehearse the candidate as described below. Verify every journey before opening access.

## Update during the weekend

1. On Friday, pin the published demo commit with `release.mjs pin --tag TAG --push`.
   Use `sales-stable/YYYY-MM-DD-2` for another candidate on the same day. Never move an existing tag.
2. Build and download its CI packages. Demo development continues independently.
3. Announce the maintenance window. Close access and stop app, storefront, shop, N1, and migrator:

   ```sh
   node ops/zerops-stable/maintenance.mjs enter --config CONFIG --confirm-project PROJECT_ID
   node ops/zerops-stable/maintenance.mjs status --config CONFIG
   ```

4. Back up the current release while it is stopped:

   ```sh
   node ops/zerops-stable/data.mjs backup --config CONFIG --output BACKUP --source-revision CURRENT_COMMIT
   node ops/zerops-stable/data.mjs verify --config CONFIG --backup BACKUP
   ```

   The backup includes the app database, SpiceDB database, and role memberships, without role passwords.
   Preserve the matching private credential bundle separately.

5. On the clean candidate runner, set `REHEARSAL_DATABASE_ADMIN_URL` to a disposable PostgreSQL 18 cluster with compatible locales:

   ```sh
   node ops/zerops-stable/data.mjs rehearse --config CONFIG --backup BACKUP --tag TAG --evidence REHEARSAL
   ```

   This restores a copy and runs the tagged native migrator. It does not exercise SpiceDB catalog activation.
   Use `--replace-scratch-databases` only after approving destruction of the scratch databases.
   The backup must be at most 12 hours old when installing an update. Plan the final backup and rehearsal accordingly.

6. Inspect the plan, then install:

   ```sh
   node ops/zerops-stable/deploy.mjs --config CONFIG --tag TAG --artifacts ARTIFACTS --maintenance-confirmed --backup BACKUP --rehearsal REHEARSAL
   node ops/zerops-stable/deploy.mjs --config CONFIG --tag TAG --artifacts ARTIFACTS --maintenance-confirmed --backup BACKUP --rehearsal REHEARSAL --execute
   ```

   Saturday and Sunday are accepted in Europe/Prague. A weekday installation needs `--emergency-reason TEXT`.
   First publish and test the emergency fix on demo. The reason does not bypass data, artifact, or ownership checks.

7. If workloads are stopped, run `maintenance.mjs start-gated --config CONFIG --confirm-project PROJECT_ID`.
   Run the human sales walkthrough from an allowlisted IP and record its actual result:

   ```json
   {"schemaVersion":1,"kind":"ontos.stable.sales-walkthrough","tag":"TAG","commit":"COMMIT","performedBy":"OPERATOR","performedAt":"ISO_TIMESTAMP","verdict":"accepted","notes":"Journeys exercised and observations"}
   ```

8. Set `STABLE_VERIFICATION_FILE` to the private manifest and run the real checks from the allowlisted runner:

   ```sh
   node ops/zerops-stable/verify.mjs --config CONFIG --output EVIDENCE --tag TAG --access maintenance-allowlist --artifact-manifest ARTIFACTS/manifest.json --backup BACKUP --migration-evidence REHEARSAL --walkthrough-evidence WALKTHROUGH --phase candidate
   ```

   Missing inputs fail checks. Verification exercises login and logout, tenant denial, populated shops, customer login, controlled ERP import, email delivery, and OAuth MCP proposals and rejection.
   The ERP company, inbox recipient, and MCP account must match explicit mutation approvals in the manifest.

9. Only after every check passes, reopen access:

   ```sh
   node ops/zerops-stable/maintenance.mjs leave --config CONFIG --confirm-project PROJECT_ID --evidence EVIDENCE
   ```

   `leave` rechecks the tag, config, complete checks, and active source versions. It starts no services.
   Evidence expires after 48 hours. Walkthrough and rehearsal records expire after seven days.

## Recover without losing unreviewed data

A failed install stops workloads and does not reopen access. A failed verification does not undo its writes.
Run `maintenance.mjs enter` before investigating or restoring.
Prefer a forward fix through demo. Obtain explicit approval before discarding unique data.

To restore the same PostgreSQL cluster:

```sh
node ops/zerops-stable/data.mjs restore --config CONFIG --backup BACKUP --confirm-project PROJECT_ID --destroy-current-data --pre-restore-output CURRENT_DATA_BACKUP --current-revision CURRENT_COMMIT
```

Restore preserves a new backup of the current data before replacing the app and SpiceDB databases.
It leaves maintenance enabled. Restore does not reinstall matching app artifacts or reopen access.
Reinstall a compatible candidate, run the checks, and then call `leave`.
Do not assume a data restore reverses sent email, ERP writes, or MCP side effects.

## Maintenance limits

The Cloudflare rule blocks normal public traffic except verifier IPs and keeps routes and certificates intact.
The tools disable native Zerops subdomains. They do not make the origin unreachable to a direct-IP request with a custom Host header.
Treat this as an operational traffic gate, not a security boundary against an attacker.
Background jobs run while the candidate runs behind the gate. Real email and ERP side effects remain possible.
Do not connect a live customer integration as a verification fixture.
Do not automatically restore after a failed check.

## Check changes to this tooling

With app dependencies already installed, run the focused suite:

```sh
node --test --test-concurrency=1 ops/zerops-stable/*.test.mjs
```

The tests include fake Zerops and PostgreSQL boundaries. They do not replace a real first-install proof.
Use CI for full builds and shared runtime checks.
