# Runbook: what a fresh production needs

Production doesn't exist, and this branch has no scripted way to create it. Stage runs only on
Zerops, and its deploy path is `.github/workflows/zerops-stage.yml` (see
[Stage on Zerops](../../app/docs/architecture/DEPLOYMENT.md#stage-on-zerops)). This page lists what a
production project needs on the same Zerops path before anything can deploy to it. The rules behind
each item are in [Deploy target per environment](../../app/docs/architecture/DEPLOYMENT.md#deploy-target-per-environment).

**Cost.** A production project is a paid Zerops project with its own database and runtimes. Check
Zerops pricing for the services in `app/zerops-import.yaml` before you create anything.

## What is missing today

| Item                         | State                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zerops project               | none. `app/zerops-import.yaml` lists the services stage runs (`db18`, `spicedb`, `migrator`, `app`, `storefront`), each with one container                                                                                                                                                                              |
| Service setup                | `app/zerops.yaml` describes stage only: it pins `ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage`, the stage origins and the stage SMTP sender. Production needs its own setup values                                                                                                                                         |
| Deploy workflow              | none. `zerops-stage.yml` deploys only `demo/sales-crm` into the GitHub environment `stage-edge`. `main` runs only the gates                                                                                                                                                                                             |
| Database identity secrets    | the three sensitive `migrator` secrets `PARTY_REGISTRY_DB_PASSWORD`, `PARTY_REGISTRY_WORKER_DB_PASSWORD` and `SHELL_GATEWAY_ISSUER_DB_PASSWORD`, created once by a human operator ([Database identities](../../app/docs/architecture/DEPLOYMENT.md#database-identities))                                               |
| SpiceDB secrets              | `SPICEDB_GRPC_PRESHARED_KEY`, `SPICEDB_DATABASE_PASSWORD` and the four TLS secrets `scripts/run-zerops-spicedb.sh` requires on the `spicedb` service ([SpiceDB TLS](../../app/docs/architecture/DEPLOYMENT.md#spicedb-tls))                                                                                             |
| Gateway signing key pair     | a new Ed25519 pair for `ONTOS_GATEWAY_PRIVATE_JWK` and `ONTOS_GATEWAY_PUBLIC_JWKS`. Never reuse stage's                                                                                                                                                                                                                 |
| Owner secret bundle          | production's counterpart of `DEMO_IMMUTABLE_RELEASE_SECRETS`, which the deploy writes to the `app` service as `ONTOS_OWNER_SECRETS_JSON` ([Secrets](../../app/docs/architecture/DEPLOYMENT.md#secrets))                                                                                                                 |
| Shell origin and domain      | a custom domain routed to the `app` service; it is the origin for `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS` and the gateway issuer                                                                                                                                                                               |
| Authorization gate           | blocked. Production needs exact-build enforced authorization evidence and an approved production context in `topology/authorization-contexts/`: issue #173 (implementation) and issue #369 (approval). See [Fail-closed authorization promotion](../../app/docs/architecture/DEPLOYMENT.md#fail-closed-authorization-promotion) |

## Order

1. Pass the authorization gate. Nothing below may serve production traffic before it.
2. Write the production setup values and a production deploy workflow modelled on `zerops-stage.yml`,
   with its own GitHub environment holding `ZEROPS_TOKEN`, the owner secret bundle and the project and
   service IDs.
3. Import the services from `app/zerops-import.yaml` into a new Zerops project.
4. As a human operator, create the `migrator` identity secrets and the `spicedb` secrets on their services.
5. Route the custom domain to the `app` service.
6. Dispatch the first deploy, then run the
   [required smoke suite](../../app/docs/architecture/DEPLOYMENT.md#required-smoke-suite) and the
   [release sequence](../../app/docs/architecture/DEPLOYMENT.md#release-sequence) before sending real users.
