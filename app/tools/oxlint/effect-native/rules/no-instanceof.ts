import { defineRule } from '@oxlint/plugins';

/** Constructor identity is never an application failure or value-discrimination contract. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid every instanceof operator, including Error and Exception classes.',
    },
    schema: [],
    messages: {
      forbidden:
        'The instanceof operator is forbidden. Use Effect.catchTag, Match, Schema, or a native guard at a foreign boundary.',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator === 'instanceof') context.report({ node, messageId: 'forbidden' });
      },
    };
  },
});
