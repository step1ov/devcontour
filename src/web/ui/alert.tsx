import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

const alertVariants = cva('relative w-full rounded-md border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'bg-card text-foreground',
      destructive: 'bg-destructive-foreground border-destructive/30 text-destructive',
      warning: 'bg-warning-foreground border-warning/30 text-warning',
      info: 'bg-accent border-primary/30 text-accent-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});
function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div className={cn(alertVariants({ variant }), className)} {...props} />;
}
function AlertTitle({ className, ...props }: ComponentProps<'h5'>) {
  return <h5 className={cn('mb-1 leading-none font-medium', className)} {...props} />;
}
function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('[&_p]:leading-relaxed', className)} {...props} />;
}
export { Alert, AlertTitle, AlertDescription };
