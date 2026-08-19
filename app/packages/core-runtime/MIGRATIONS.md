# Core Runtime migrations

## Service contract names

Anti-slop's `no-shape-in-symbol-names` rule rejects identifiers containing `Shape`, so the former public aliases cannot remain as deprecated compatibility exports. Import these replacements from `@app/core-runtime`:

| Removed type                                   | Replacement                                      |
| ---------------------------------------------- | ------------------------------------------------ |
| `PrincipalResolverShape`                       | `PrincipalResolverService`                       |
| `SupportRecoveryPrincipalContextResolverShape` | `SupportRecoveryPrincipalContextResolverService` |
| `LegalEntityContextShape`                      | `LegalEntityContextService`                      |
| `ContextAccessShape`                           | `ContextAccessService`                           |
| `OperationalScopeResolverShape`                | `OperationalScopeResolverService`                |
| `ModuleStateGateShape`                         | `ModuleStateGateService`                         |
| `ModuleEntrypointGatewayShape`                 | `ModuleEntrypointGatewayService`                 |
| `TenantModuleStateServiceShape`                | `TenantModuleStateServiceContract`               |
| `InstalledModuleCatalogServiceShape`           | `InstalledModuleCatalogServiceContract`          |

This is an intentional source-level migration: update type-only imports to the replacement name. Runtime service tags and behavior are unchanged.

## Principal management error schema

`PrincipalManagementError` remains the public decoded error type. Runtime schema consumers must import `PrincipalManagementErrorSchema`; one identifier cannot expose both declarations without violating the lint contract or producing duplicate TypeScript exports.
