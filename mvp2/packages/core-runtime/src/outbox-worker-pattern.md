# Outbox Worker File Pattern

Outbox Workers follow the same public-descriptor/private-implementation shape as Actions:

- `*.worker.ts` exports the public `OutboxWorkerDescriptor` value that belongs in module contract material.
- `*.handler.ts` keeps the private `OutboxWorkerHandler` implementation.
- `*.registration.ts` binds the descriptor to the private handler with `satisfies OutboxWorkerRegistration<Payload>`.

The shared worker runtime loads installed registrations through its static installed worker registry. Core owns the shared worker contract types, but the runtime process owns the registry that imports private MicroVertical registrations. It does not discover workers from the filesystem, load dynamic plugins, or expose handlers through Module Federation.
