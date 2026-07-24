# UltraModern.js MicroVertical Rules

Follow these rules when writing code with MicroVerticals:

- Use Effect TS for MicroVertical business logic, BFF operations, typed expected errors, and service composition. Follow the [MicroVertical Data Boundaries](./SEAM.md) for the boundaries between Effect and reusable UI.
- Always prefer direct object, method, and variable references over string constants.
- Do not create an abstraction without a concrete reuse case.
- Reuse existing concepts and files first. Add a concept, class, variable, or file only when the current requirement, documented architecture, or code readability requires it.
- Before creating a file type supported by Codesmith, inspect `app/scripts` and run the corresponding generator. The [repository agent instructions](../../../AGENTS.md#mandatory-codesmith-generators) contain the canonical list of mandatory generators.
- Treat files emitted by Codesmith as required scaffolding, not as files created directly by AI. Use the generated output as the starting point, fill in its logic, and adapt its structure when the task requires it. Do not recreate the initial files or wiring by hand.
- Do not create business-functionality files directly. If a required file type has no Codesmith generator, stop and ask the developer how to proceed. You may create files directly only for infrastructure or architecture work.
