// expect-count: 7
import * as dialog from '@zag-js/dialog';
import { Slot } from '@radix-ui/react-slot';
import clsx from 'clsx';
import { tv } from 'tailwind-variants';
import type { ColumnDef } from '@tanstack/react-table';
export { Search } from 'lucide-react';

export const Page = (): ColumnDef<string>[] => [dialog, Slot, clsx, tv].map(() => ({}) as ColumnDef<string>);
export const later = () => import('@zag-js/menu');
