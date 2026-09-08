// C1 target shape: the owning Schema encodes the value; JSON-string codecs replace JSON.stringify.
import { Effect, Schema } from "effect";
import * as S from "effect/Schema";

const Scope = Schema.Struct({ tenant: Schema.String, actor: Schema.String });

export const encodeScope = Schema.encodeSync(Schema.fromJsonString(Scope));

export const encodeScopeEffect = (scope: { readonly tenant: string; readonly actor: string }) =>
	Schema.encodeEffect(Schema.fromJsonString(Scope))(scope).pipe(Effect.map((text) => text.trim()));

const AliasedScope = S.Struct({ id: S.String });

export const encodeAliased = S.encodeSync(S.fromJsonString(AliasedScope));
