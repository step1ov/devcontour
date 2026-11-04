import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

// Метка статуса — мягкий фон, насыщенный текст и тонкая рамка того же тона,
// всегда с подписью. Метка не
// сжимается: длинная подпись переносит строку целиком, а не вылезает за край.
const badgeVariants = cva(
  'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs leading-4 font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-border bg-active text-muted-foreground',
        outline: 'border-control text-foreground',
        ready: 'border-info/25 bg-info-foreground text-info',
        waiting: 'border-control border-dashed bg-raised text-muted-foreground',
        success: 'border-success/25 bg-success-foreground text-success',
        warning: 'border-warning/25 bg-warning-foreground text-warning',
        destructive: 'border-destructive/25 bg-destructive-foreground text-destructive',
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
