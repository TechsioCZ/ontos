import { Schema } from 'effect';

export const ContactPointErrorReasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
