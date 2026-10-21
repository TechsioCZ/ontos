/**
 * Shared shapes of the capability-driven MCP layer (lane mcp-gateway). One file so the catalog, grants, operations,
 * tools and HTTP tasks can be built in parallel. Keep it free of runtime code.
 *
 *   catalog   (src/catalog/discover.ts)      active composition + vertical shared/apis HttpApi contracts -> Catalog
 *   grants    (src/capabilities/grants.ts)   principal (API key) -> PrincipalCapabilities per company/module
 *   operations(src/operations.ts)            ontos_read / ontos_execute bodies (direct Action or proposal)
 *   tools     (src/tools/generic.ts)         MCP tools filtered by PrincipalCapabilities
 */
import type { WritePolicy } from '../session.ts';

/** JSON Schema (draft 2020-12) object, from Effect `Schema.toJsonSchemaDocument` with `$defs` inlined. */
export type JsonSchema = { readonly [key: string]: unknown };

/** A governed read: POST {apiBaseUrl}/reads/{slug} with a JSON body. */
export interface CatalogRead {
  readonly kind: 'read';
  /** `<moduleId>/read/<slug>`, e.g. `work.tasks/read/records`. */
  readonly id: string;
  readonly moduleId: string;
  readonly appId: string;
  /** Path segment after /reads/, e.g. `records`, `customer-list`. */
  readonly slug: string;
  /** Object schema of the request body. */
  readonly inputSchema: JsonSchema;
  /** Typed MCP tool name, e.g. `work_tasks__read_records` (see toolNameOf in src/catalog/json-schema.ts). */
  readonly toolName: string;
}

/** A governed write: POST {apiBaseUrl}/{appId}/actions/{actionSlug}. */
export interface CatalogAction {
  readonly kind: 'action';
  /** `<moduleId>/command/<Tag>` for apply-command variants, `<moduleId>/action/<slug>` for named Actions. */
  readonly id: string;
  readonly moduleId: string;
  readonly appId: string;
  /** e.g. `apply-command`, `create-party`. */
  readonly actionSlug: string;
  /** apply-command variant `_tag`, e.g. `CreateTask`; undefined for named Actions. */
  readonly commandTag: string | undefined;
  /**
   * What the caller supplies. Commands: the variant's fields without `_tag`, plus optional integer
   * `expectedRevision`. Named Actions: the whole payload object.
   */
  readonly inputSchema: JsonSchema;
  readonly toolName: string;
  /** The command is an operation of the module's `AiProposeChanges` (may be proposed for approval). */
  readonly proposable: boolean;
}

export type CatalogEntry = CatalogRead | CatalogAction;

export interface CatalogModule {
  /** Manifest module id, e.g. `work.tasks`. */
  readonly moduleId: string;
  /** Deployment app id = gateway audience = directory under app/verticals, e.g. `work-tasks`. */
  readonly appId: string;
  /** Manifest `module.displayName` (English; Czech labels live in src/catalog/labels-cs.ts). */
  readonly displayName: string;
  readonly reads: readonly CatalogRead[];
  readonly actions: readonly CatalogAction[];
  /** Read used to probe access and fetch `revision`: `records` if present, else first read without required fields. */
  readonly probeReadSlug: string | undefined;
  /** The apply-command union contains `AiProposeChanges`. */
  readonly supportsAiProposals: boolean;
  /** False for platform-internal modules (commerce.customer-context): generic tools only, no typed tools. */
  readonly typedTools: boolean;
}

export interface Catalog {
  readonly compositionRevision: string;
  readonly modules: readonly CatalogModule[];
  /** Contract files that failed to import or convert (file path + reason). */
  readonly warnings: readonly string[];
}

export type Access = 'allowed' | 'denied' | 'unknown';

export interface ModuleCapability {
  readonly moduleId: string;
  readonly read: Access;
  readonly write: Access;
  /** Short Czech reason, e.g. `čtení ověřeno`, `zápis: canWrite=false`, `HTTP 403 action_permission_denied`. */
  readonly note: string;
}

export interface CompanyCapabilities {
  readonly legalEntityId: string;
  /** Czech company label, e.g. `Obchodní firma`. */
  readonly label: string;
  readonly modules: readonly ModuleCapability[];
}

export interface PrincipalCapabilities {
  /** From the capability endpoint or the gateway assertion claim `principal.principalId`. */
  readonly principalId: string | undefined;
  readonly displayName: string | undefined;
  readonly kind: 'human' | 'agent' | 'unknown';
  readonly writePolicy: WritePolicy;
  /** `endpoint`: shell capability endpoint answered; `probe`: derived by gateway + read probes. */
  readonly source: 'endpoint' | 'probe';
  /** Only companies the principal belongs to. */
  readonly companies: readonly CompanyCapabilities[];
  /** ISO timestamp. */
  readonly resolvedAt: string;
}

/** Result of ontos_execute and typed write tools. */
export type ExecuteOutcome =
  | { readonly status: 'executed'; readonly result: unknown }
  | {
      readonly status: 'proposed';
      readonly via: 'platform-approvals' | 'module-ai-proposals';
      /** Czech sentence for the user, e.g. where to approve. */
      readonly messageCs: string;
      readonly result: unknown;
    };
