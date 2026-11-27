// Inline type-only imports of a kit control and a form library load nothing at runtime.
import { type FormInput } from '@techsio/ui-kit/molecules/form-input';
import { type useForm } from 'react-hook-form';
import * as ReactDom from 'react-dom';

export type InputProps = Parameters<typeof FormInput>[0];
export type FormApi = ReturnType<typeof useForm>;
export const portal = ReactDom.createPortal;
