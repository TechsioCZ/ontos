# UltraModern.js MicroVertical Rules

Follow these rules when writing code with MicroVerticals:

- Preserve the strict vertical deployment seams and virtual horizontal Backend for Frontend (BFF) seam defined in [MicroVertical Architecture](./MICROVERTICALS.md).
- Use Effect as the default for application behavior, asynchronous work, I/O, resource management, concurrency, dependency composition, BFF contracts and clients, schemas, and expected failures.
- Keep pure synchronous transformations as plain TypeScript when Effect adds no behavior. Reusable presentation components may remain ordinary React; their route, feature, and data integration code must use the Effect-based BFF client.
- Model expected failures as tagged, typed Effect errors. Do not throw, reject a Promise, return an untyped error object, or collapse an error into a string where the Effect error channel can represent it.
- Follow [Effect Error and HTTP Contracts](./ERRORS.md) for every BFF endpoint and client.
- Follow [Outbox Worker Architecture](./OUTBOX_WORKERS.md) for generated asynchronous consumers, typed payload decoding, delivery leases, retries, and checkpoints.
- Follow [Module Entrypoints and Tenant State](./MODULE_ENTRYPOINTS.md) for every module-owned load or dispatch. Do not hand-author a business API, public component, search provider, or report until Codesmith and the approved gateway support that category.
- Always prefer direct object, method, and variable references over string constants.
- Do not create an abstraction without a concrete reuse case.
- Reuse existing concepts and files first. Add a concept, class, variable, or file only when the current requirement, documented architecture, or code readability requires it.
- Before creating a file type supported by Codesmith, inspect `app/scripts` and run the corresponding generator. The [repository agent instructions](../../../AGENTS.md#mandatory-codesmith-generators) contain the canonical list of mandatory generators.
- Treat files emitted by Codesmith as required scaffolding, not as files created directly by AI. Use the generated output as the starting point, fill in its logic, and adapt its structure when the task requires it. Do not recreate the initial files or wiring by hand.
- Do not create business-functionality files directly. If a required file type has no Codesmith generator, stop and ask the developer how to proceed. You may create files directly only for infrastructure or architecture work.
