/**
 * FALSE POSITIVE (adversarial review, no-promise-shaped-port).
 *
 * These interfaces are not first-party ports: each one is a hand-written structural mirror of a
 * third-party SDK or platform API whose `Promise` shape cannot be changed. The value satisfying the
 * type is produced *by* the third party (`betterAuth(...)`, `globalThis.fetch`, `import()`, the
 * Drizzle query builder), so "return `Effect.Effect<A, E, R>` instead" is not an available fix.
 * Audit D tier: "Promise adapters forced by React, TanStack, Modern.js, Playwright, Drizzle, and
 * Node process entrypoints."
 *
 * Real hits reproduced here:
 * - apps/shell-super-app/api/auth/impersonation-service.ts:82,92,100 (`SupportAuthProvider`)
 * - apps/shell-super-app/api/modules/installed-module-catalog.ts:33 (`ModuleContractFetch`)
 * - packages/core-runtime/src/modules/runtime-registration.ts:40 (import thunk)
 * - apps/shell-super-app/src/api/vertical-clients.ts:12 (React.lazy thunk)
 * - verticals/contacts/src/services/customer-contact-persistence.service.ts:52,61,71 (Drizzle chain)
 */
import { Effect } from "effect";

import { betterAuth } from "better-auth";

/** `makeSupportAuthProvider` returns `betterAuth(...) satisfies SupportAuthProvider`. */
export interface SupportAuthProvider {
	readonly api: {
		readonly getSession: (input: { readonly headers: Headers }) => Promise<null | { readonly id: string }>;
	};
}

export const makeSupportAuthProvider = (secret: string): SupportAuthProvider => betterAuth({ secret });

/** The injection point for the platform `fetch`; its default value *is* `globalThis.fetch`. */
export type ModuleContractFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const defaultContractFetch: ModuleContractFetch = globalThis.fetch;

/** A dynamic-import thunk: `import()` cannot return anything but a Promise. */
export type VerticalRuntimeEntrypointThunk = () => PromiseLike<object>;
// D-tier adapter evidence must be in source: an unused alias's name alone cannot prove import().
export const loadRuntime: VerticalRuntimeEntrypointThunk = () => import("node:os");

export interface ApprovedVerticalPageClient {
	readonly componentKey: string;
	readonly load: () => Promise<{ readonly default: unknown }>;
}

export const verticalClients: readonly ApprovedVerticalPageClient[] = [
	{ componentKey: "contacts.core.page-contacts", load: async () => await import("node:os") },
];

/** A structural narrowing of the Drizzle query builder, converted once by `attempt`. */
interface CustomerInsertTransaction {
	readonly insert: (table: string) => {
		readonly values: (values: { readonly name: string }) => {
			readonly returning: () => PromiseLike<readonly { readonly id: string }[]>;
		};
	};
}

const attempt = <Value>(operation: () => PromiseLike<Value>) =>
	Effect.tryPromise({ catch: () => "contacts_persistence_unavailable" as const, try: operation });

export const createCustomer = (transaction: CustomerInsertTransaction, name: string) =>
	attempt(() => transaction.insert("customers").values({ name }).returning());
