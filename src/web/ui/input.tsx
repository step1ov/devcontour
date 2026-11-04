import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'border-input bg-card flex h-(--control-height-form) w-full rounded-sm border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
export { Input };
