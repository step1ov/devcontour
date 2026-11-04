import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

// Метка статуса — бледная пара фона и текста, всегда с подписью. Метка не
// сжимается: длинная подпись переносит строку целиком, а не вылезает за край.
const badgeVariants = cva(
  'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-xs border px-2 py-0.5 text-xs leading-4 font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-active text-muted-foreground',
        outline: 'border-control text-foreground',
        ready: 'border-transparent bg-info-foreground text-info',
        waiting: 'border-control border-dashed bg-raised text-muted-foreground',
        success: 'border-transparent bg-success-foreground text-success',
        warning: 'border-transparent bg-warning-foreground text-warning',
        destructive: 'border-transparent bg-destructive-foreground text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
export { Badge, badgeVariants };
