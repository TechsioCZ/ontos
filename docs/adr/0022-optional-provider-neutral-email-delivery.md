# ADR-0022: Optional provider-neutral email delivery capability

Status: Accepted.

## Context

Commerce and Core/ERP applications need a reusable way to submit email for owner-controlled
workflows. Making email a mandatory dependency of lean Core or of unrelated applications would
couple those applications to a provider and make an infrastructure concern part of every runtime.

The owner still needs to decide what an email means, when it is authorized, which template and
token are used, and how durable work is retried or reconciled. A provider response also cannot
prove inbox delivery: a submission can be accepted while delivery remains pending, rejected, or
unknown.

## Decision

OntOS will provide an optional, provider-neutral email delivery capability in the
`@app/email-delivery` package at `app/packages/email-delivery`. Its public package seams are:

- `./server`, which exposes the neutral send service; and
- `./resend`, which exposes the configured Resend layer.

The composition root chooses the provider layer and supplies its credentials. A request payload
must not contain a customer-controlled provider endpoint or provider credentials. Resend is the
initial adapter. The provider seam is intended to allow later SES, Cloudflare, self-hosted, or
customer-hosted adapters, but those adapters are outside this decision's current delivery scope.

The capability remains outside lean Core and has no registry, queue, template-engine, database, or
Core runtime dependency. It is not a generic notification platform, a new MicroVertical, or a
provider fleet. Commerce and Core/ERP owners retain their local templates, authentication and
recovery tokens, authorization, business policy, and message meaning. The owner outbox or workflow
retains durable send intent and owns idempotency, retry, and reconciliation decisions.

An accepted send means that the capability and selected provider accepted the submission. It does
not mean that the message reached an inbox. An ambiguous provider or transport failure must not
trigger a blind automatic resend; the owning workflow must use its durable intent, idempotency
record, and available provider evidence to decide whether reconciliation or a deliberate retry is
safe.

## Target architecture versus current delivery

This ADR records the accepted target boundary and package seams. It does not claim that the
package, either export, or production-ready Resend delivery is already available. Implementation,
configuration, and adoption remain separate work validated by source and tests. Future adapters
remain an extension direction rather than delivered capability.

## Consequences

- Commerce and Core/ERP applications can adopt one neutral send contract without making email a
  mandatory dependency for unrelated applications.
- Provider credentials and endpoint selection stay in composition and deployment configuration,
  while callers cannot redirect delivery through request data.
- Owner workflows preserve business meaning and durable intent instead of delegating authorization,
  templating, token handling, or delivery policy to the shared capability.
- Provider-specific behavior is isolated behind a configured adapter seam, so adding an adapter
  does not require a generic notification platform or a new deployment unit.
- Callers must treat accepted submission and eventual inbox delivery as separate states and must
  handle ambiguous outcomes deliberately.

## Rejected alternatives

- Making email delivery a mandatory Core or workspace dependency was rejected because lean Core
  and unrelated applications should not acquire provider infrastructure.
- Adding a generic notification platform, registry, queue, template engine, or database to this
  capability was rejected because owner workflows already own durable intent and business policy.
- Sending provider endpoints or credentials in request payloads was rejected because composition
  must control provider selection and secret material.
- Delivering every future provider adapter now was rejected because Resend is the initial adapter
  and later adapters should be added only when an owner requires them.
