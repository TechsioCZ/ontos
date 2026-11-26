# Deploy the stable sales environment

Run builds and deployments through [Zerops Stable Release](https://github.com/TechsioCZ/ontos/actions/workflows/zerops-stable.yml).
No separate release machine or fixed-IP runner is needed.
Stable uses immutable tags from `demo/sales-crm`. It has its own Zerops project, database, identities, and secrets.

## Deploy a release

1. Open **Zerops Stable Release** and select **Run workflow** on `demo/sales-crm`.
2. Set `ref` to `demo/sales-crm`, a published demo commit, or an existing `sales-stable/YYYY-MM-DD[-N]` tag.
3. Set `mode` to `deploy`.
4. Read the pin, build, install, and verification results in the run.

The workflow creates an annotated release tag when the selected commit has none.
It never moves an existing tag. Later demo pushes do not update stable.
Use `mode=build` to build packages without installing them.
Use `mode=verify` with an existing release tag to check the running versions and public addresses without installing anything.

The first deployment initializes database roles and SpiceDB over the project VPN on the hosted runner.
It installs the app, routes its public address, creates the configured accounts and storefront identities, and then installs the three fronts.
The bootstrap helper activates the configured tenant modules and gives each storefront its registration, a Czech market, the association and the market settings.
Only the tenants listed in the bootstrap bundle's `salesData` get synthetic products.
Updates install the app first, followed by the fronts. App startup runs the native migrations.
There is no weekday restriction, maintenance-approval requirement, or mandatory custom backup rehearsal.

A failed install stops that workflow. Read the failed step before rerunning.
Already completed pushes remain installed. A failed new build does not by itself remove the last serving Zerops version.
A successful HTTP/version check proves availability and release identity, not checkout, email delivery, or ERP synchronization.

## Configured project and accounts

The approved project is **OntOS stable**, ID `TMULOfPyTFWAKabzFcvANQ`, in BDA Platform.
These are the configured addresses and accounts. DNS is configured; check the deployment run for installation status.

| Purpose | Address | Account |
| --- | --- | --- |
| Staff Shell | https://ontos.web-revolution.cz | `admin@ontos.web-revolution.cz`, `sales@ontos.web-revolution.cz` |
| Akros storefront | https://ontos-akros.web-revolution.cz | `akros@ontos.web-revolution.cz` in the staff Shell |
| ŠroubShop storefront | https://ontos-shop.web-revolution.cz | ŠroubShop staff accounts above |
| N1 storefront | https://ontos-n1.web-revolution.cz | `n1@ontos.web-revolution.cz` in the staff Shell |

The customer-owner accounts above are administrative accounts, not seeded storefront shoppers.
Company registration numbers are setup placeholders: `STABLE-SROUBSHOP`, `STABLE-AKROS`, and `STABLE-N1`.
Replace them with the customer's actual details before using them for legal documents.
Account passwords are private, not in this repository or workflow artifacts.
The operator's generated account files are under gitignored `app/.zerops-stable/` with owner-only permissions.

## Configure GitHub Actions

The `sales-stable` GitHub environment holds these secrets:

- `STABLE_CONFIG_JSON`: validated schema-version-1 config, including stable project and service IDs, public origins, and non-secret variables.
- `STABLE_BOOTSTRAP_JSON`: the private bootstrap bundle, including database admin URL, service secrets, accounts, module selections, and opted-in synthetic data.
- `ZEROPS_TOKEN`: deployment access to the project.
- `CLOUDFLARE_API_TOKEN`: access to the stable zone's DNS.
- `STAGE_SMTP_PASSWORD`: the existing SMTP transport password. The name is shared with stage; stable has its own sender configuration.

Set these environment variables:

- `CLOUDFLARE_ACCOUNT_ID`: `384e8a94acf428ce447e7e73122d91d1`.
- `STABLE_CLOUDFLARE_ZONE_ID`: `61e3247600dfeae312bc4dff97237d02`.
- `ZEROPS_SHARED_IPV4`: `93.185.106.128`.

DNS uses unproxied A and AAAA records, like the existing stage delivery.
The release workflow adds Zerops HTTPS routes after the target services deploy.
[Zerops Stable Infrastructure](https://github.com/TechsioCZ/ontos/actions/workflows/zerops-stable-infra.yml) configures the DNS records independently.
The one-time credential-copy token is removed after setup; normal deploys use only the `sales-stable` secrets.

Do not regenerate the internal secret bundle for an update.
Secret synchronization refuses changed existing values unless rotation is explicitly confirmed.
Owner-secret JSON merges by owner and key, preserving the authentication secret.
Issue tenant credentials through the native identity flow; random strings are not credentials.
Configure customer Symmy access only with the customer's authorized key and target company.
The demo fixture profile is disabled in stable, so demo customer bootstraps do not run there.

## Backups and recovery

Use the native Zerops PostgreSQL backups for `db18`.
The project's live database environment reports `BACKUP_PERIOD="51 0 * * *"`.
Check actual backup completion and restore options in Zerops before a risky database change.
A schedule alone is not proof that a usable backup exists.

Restore only the stable database, never the demo project.
A database restore cannot undo email already sent or writes already made to an external ERP.
`data.mjs`, `maintenance.mjs`, and the extended journey verifier remain optional diagnostic tools.
They are not prerequisites for the Actions release and can require additional operator inputs.

## Tool reference

Run local commands from the repository root with the app dependencies installed.
Do not create another package lockfile for ops.
Keep private JSON files outside tracked paths or under gitignored `app/.zerops-stable/`.

| Tool | Purpose |
| --- | --- |
| `provision.mjs` | Render, create, and resolve an independent project. Paid creation requires explicit approval. |
| `bootstrap.mjs` | Prepare native account inputs and issue managed storefront keys. |
| `secrets.mjs` | Generate and synchronize service secrets without accidental rotation. |
| `initialize.mjs` | Initialize a fresh project's database roles and SpiceDB. |
| `gha-bootstrap.mjs` | Run the before-app and after-app first-install phases on the Actions runner. |
| `release.mjs` | Pin and inspect immutable annotated release tags. |
| `deploy.mjs build --config CONFIG --tag TAG --output DIR` | Build tagged release packages. |
| `deploy.mjs install --config CONFIG --tag TAG --artifacts DIR [--execute]` | Plan or install tagged packages. |
| `deploy.mjs verify --config CONFIG --tag TAG` | Check running revisions and public HTTP responses. |
| `verify.mjs` | Run extended customer, email, ERP, and MCP journeys with a private verification manifest. |
| `data.mjs`, `maintenance.mjs` | Optional manual export, rehearsal, recovery, and access-control operations. |
