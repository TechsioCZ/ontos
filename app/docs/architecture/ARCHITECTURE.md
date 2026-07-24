# Action Execution

- Every state change in the system must be driven by an Action.
- An Action is a typed unit of code with a clear structure.
- Before executing an Action:
  - Write an Action Invocation Log.
  - Check permissions in SpiceDB, followed by global or MicroVertical-specific policies.
- Execute the Action only after all permission and policy checks pass.
- Return every permission or policy denial as a typed Effect error with an appropriate status code and message.
- Generate an appropriate Audit Event and Domain Event for every Action execution. When the Action accesses business data, also generate a Data Access Event. Save these events in the same transaction as the business database updates.
- An Action handler may optionally create an Outbox Message. Add the message to the same transaction.
- Generate Actions, Permissions, Policies, and Outbox Messages with their respective Codesmith generators.
