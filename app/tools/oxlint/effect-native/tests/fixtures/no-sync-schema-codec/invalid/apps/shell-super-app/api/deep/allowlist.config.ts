// expect-count: 1
// A nested `*.config.ts` is NOT a framework config root: the allowlist is only the top-level
// `{apps,verticals,packages}/*/*.config.*` seam, so renaming a module must not buy an exemption.
import { Schema } from 'effect';

const AllowlistSchema = Schema.Struct({ id: Schema.String });

export const decodeAllowlist = (value: unknown): { readonly id: string } =>
	Schema.decodeUnknownSync(AllowlistSchema)(value);
