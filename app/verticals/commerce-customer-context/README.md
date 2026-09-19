# Commerce Customer Context

The Commerce customer MicroVertical: customer profiles, counterparty access, purchasing policy, and
the Commerce Portal (authentication realm and enrollment).

## Optional deployment configuration

Both groups below are opt-in. A deployment that names none of a group's values never opted into it,
and the vertical still serves readiness and every business route: the corresponding routes answer a
retryable `503` instead. Naming only some of a group's values is a misconfiguration, not an opt-out,
and is reported as one.

### Commerce Portal authentication realm — `COMMERCE_PORTAL_AUTH_*`

The Better Auth provider realm behind the portal session, MFA, recovery, step-up and enrollment
routes. Read by `api/portal-auth/provider/config.ts`.

| Variable                               | Required when opted in | Meaning                                                   |
| -------------------------------------- | ---------------------- | --------------------------------------------------------- |
| `COMMERCE_PORTAL_AUTH_URL`             | yes                    | The portal origin. Also the first trusted origin.         |
| `COMMERCE_PORTAL_AUTH_DATABASE_URL`    | yes                    | The provider's own PostgreSQL connection string.          |
| `COMMERCE_PORTAL_AUTH_SECRET`          | yes                    | At least 32 characters. Rotated independently of Staff's. |
| `COMMERCE_PORTAL_AUTH_SECRETS`         | no                     | `version:value` entries, current key first.               |
| `COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS` | no                     | Extra comma-separated origins.                            |
| `COMMERCE_PORTAL_AUTH_TRUSTED_PROXIES` | no                     | Exact peer addresses of the deployment's own proxies.     |
| `COMMERCE_PORTAL_AUTH_NODE_ENV`        | no                     | `production` forces secure cookies.                       |

### Core identity transport — `COMMERCE_CORE_IDENTITY_*`

The provider-neutral Core endpoint enrollment reaches for a Tenant-scoped Principal Auth Binding,
and the server-owned service credential presented to it. Read by
`api/portal-auth/provider/core-identity-client-config.ts`. It is deliberately separate from the
portal realm: the realm is the provider half of enrollment, this is the Core half, and a deployment
rotates them independently.

| Variable                          | Required when opted in | Meaning                                                                                                                                                             |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMERCE_CORE_IDENTITY_BASE_URL` | yes                    | `http`/`https` base URL of the Core identity API. It carries no credential material: a URL with userinfo, a query or a fragment is rejected.                        |
| `COMMERCE_CORE_IDENTITY_API_KEY`  | yes                    | The trusted, server-owned API key, at least 16 characters. It is `Redacted` from the moment it is read and never reaches a log, a span attribute or a problem body. |

With neither value named, every Core identity owner transition stays the fail-closed unavailable
port rather than reaching an unconfigured endpoint.

## Portal enrollment routes

| Route                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/portal-auth/enrollment/start`      | Starts (or converges on) an Enrollment Attempt for one of the three supported journeys, durably claims its `provider.account.create` transition, and performs that one provider effect. This is the only Commerce route that carries an enrollment credential; the password is `Redacted` end to end, never enters the durable Attempt and never reaches an intent or request digest. |
| `GET /api/portal-auth/enrollment/{attemptId}` | Reads the Attempt projection back for the caller's own governed Tenant. The durable read is Tenant-scoped inside PostgreSQL, so an Attempt belonging to another Tenant answers exactly as an absent one does.                                                                                                                                                                         |

Both routes run the trusted-origin gate and a subject-keyed budget before any owner effect. There is
no route that advances, completes or terminates an Attempt from the outside: every later transition
travels through the governed enrollment Actions, and `COMPLETE` is derived from durable owner
outcomes rather than asserted by a caller.
