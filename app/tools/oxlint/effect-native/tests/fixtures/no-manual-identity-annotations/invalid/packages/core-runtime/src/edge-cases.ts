// expect-count: 11
// Alias, barrel, submodule-namespace, direct-member, computed, optional-chaining and key/value forms.
import * as EffectBarrel from 'effect';
import { Effect as Fx } from 'effect';
import * as EffectNs from 'effect/Effect';
import { annotateLogs, annotateCurrentSpan } from 'effect/Effect';

declare const scope: { correlationId: string; readKey: string; tenantId: string };

// 1: aliased root import.
export const aliased = Fx.annotateLogs(Fx.logInfo('x'), { correlationId: scope.correlationId });

// 2: root barrel namespace.
export const viaBarrel = EffectBarrel.Effect.annotateLogs(EffectBarrel.Effect.void, {
	readKey: scope.readKey,
});

// 3: submodule namespace import.
export const viaSubmodule = EffectNs.annotateSpans(EffectNs.void, { tenantId: scope.tenantId });

// 4: direct member import, data-last point-free through pipe.
export const pointFree = EffectBarrel.pipe(
	EffectBarrel.Effect.void,
	annotateLogs({ correlationId: scope.correlationId }),
);

// 5 + 6: shorthand properties.
const { correlationId, readKey } = scope;
export const shorthand = Fx.annotateLogs(Fx.void, { correlationId, readKey });

// 7: string-literal snake_case key.
export const snake = Fx.annotateLogs(Fx.void, { 'correlation_id': scope.correlationId });

// 8: computed string-literal key.
export const computedKey = Fx.annotateLogs(Fx.void, { ['actionKey']: 'contacts.createCustomer' });

// 9: computed member access on the namespace.
export const computedMember = Fx['annotateLogs'](Fx.void, { invocationId: 'inv-1' });

// 10: optional chaining on the namespace.
export const optional = Fx?.annotateLogs(Fx.void, { deploymentId: 'dep-1' });

// 11: two-argument key/value form.
export const keyValue = annotateCurrentSpan('correlationId', scope.correlationId);
