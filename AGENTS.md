# Agent Instructions

- Work solely in `@app`, except repository-root `.github/workflows/` files required for GitHub to
  discover and run this application's CI/deployment workflows.
- `mvp/` and `mvp2/` are read only.

## Mandatory Codesmith Generators

When creating any of the following code in `@app`, always run the matching Codesmith
generator from the `app/` directory. Do not create the initial files or wiring by hand;
generate them first, then adapt the generated output if the task requires it.

- Action: `pnpm scaffold:action -- --vertical <vertical> --action <action>`
- Microvertical page: `pnpm scaffold:microvertical-page -- --vertical <vertical> --page <page>`
- Outbox message: `pnpm scaffold:outbox-message -- --vertical <vertical> --action <action> --topic <topic>`
- Policy: `pnpm scaffold:policy -- --scope <global|microvertical> --policy <policy>`; add `--vertical <vertical>` when the scope is `microvertical`.

Use the command's `--help` option to discover supported customization flags. The
generator requirement applies to agents and all delegated work.
