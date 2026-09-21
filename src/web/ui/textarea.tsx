import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'border-input bg-card flex min-h-20 w-full rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
export { Textarea };
