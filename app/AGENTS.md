# OntOS Application Agent Instructions

OntOS is an ERP system built with [UltraModern.js](https://bleedingdev.github.io/ultramodern.js/guides/get-started/ultramodern) and [`@techsio/ui-kit`](https://github.com/TechsioCZ/new-engine).

## Required Guidance

For work inside `app/`, this file and `app/docs/` are authoritative implementation guidance. Use the repository-level [`../docs/`](../docs/) as product and architectural context. If they conflict, follow the guidance under `app/` and raise the discrepancy to the developer.

### Non-Negotiable Architecture

- **MicroVerticals:** Preserve the strict, independently deployable vertical seams between MicroVerticals. Keep each MicroVertical's frontend/backend seam virtual and represented by its generated Effect-based Backend for Frontend (BFF) client. Follow [MicroVertical Architecture](./docs/architecture/MICROVERTICALS.md).
- **Actions:** Drive every state change through a typed Action and preserve its required lifecycle, transaction, event, and evidence rules. Follow [Action Execution](./docs/architecture/ACTIONS.md).
- **Effect errors:** Use Effect end to end for application behavior, BFF contracts and clients, and expected failures. Every backend error response must come from a declared typed Effect error with the correct HTTP status. Follow [Effect Error and HTTP Contracts](./docs/architecture/ERRORS.md).
- **Database access:** Keep PostgreSQL access typed through Drizzle schema references and query builders inside Effect services. Follow [Database Architecture](./docs/architecture/DATABASE.md).

### Task-Specific Rules

- All implementation work: [UltraModern.js Implementation Rules](./docs/architecture/ULTRAMODERN.md)
- User-facing frontend work: [Frontend Architecture Rules](./docs/frontend/FRONTEND.md)

## Toolchain

Run every pnpm command from the `app/` directory with the repository-managed toolchain:

```bash
mise exec -- pnpm <command>
```
