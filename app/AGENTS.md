# OntOS Application Agent Instructions

OntOS is an ERP system built with [UltraModern.js](https://bleedingdev.github.io/ultramodern.js/guides/get-started/ultramodern) and [`@techsio/ui-kit`](https://github.com/TechsioCZ/new-engine).

## Toolchain

Run every pnpm command from the `app/` directory with the repository-managed toolchain:

```bash
mise exec -- pnpm <command>
```

## Required Guidance

Use the repository-level `../docs/` as architectural context and `app/docs/` as current implementation guidance. If they conflict, stop and ask the developer instead of choosing one silently.

Read and follow the documents relevant to the task:

- Product and architectural decisions: [`../docs/`](../docs/)
- General UltraModern.js and MicroVertical rules: [`docs/architecture/ULTRAMODERN.md`](./docs/architecture/ULTRAMODERN.md)
- Action execution and transaction rules: [`docs/architecture/ARCHITECTURE.md`](./docs/architecture/ARCHITECTURE.md)
- MicroVertical data and Effect boundaries: [`docs/architecture/SEAM.md`](./docs/architecture/SEAM.md)
- User-facing frontend work: [`docs/frontend/FRONTEND.md`](./docs/frontend/FRONTEND.md)
