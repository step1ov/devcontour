import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

// Одна залитая кнопка на экран (`default`) — следующее решение оператора.
// Остальные — `outline` (белая с рамкой контрола) или `ghost`. Отклик нажатия —
// короткий scale; переходы перечислены по свойствам, не `transition-all`.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium cursor-pointer transition-[background-color,border-color,color,opacity,transform] duration-(--duration-hover) ease-out active:not-disabled:scale-[0.97] active:not-disabled:duration-(--duration-press) disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        destructive:
          'border border-destructive/40 bg-card text-destructive hover:bg-destructive-foreground',
        outline: 'border border-control bg-card shadow-pill hover:bg-secondary',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-active',
        ghost: 'hover:bg-secondary',
        link: 'text-info underline-offset-4 hover:underline active:not-disabled:scale-100 active:opacity-70',
      },
      size: {
        default: 'h-(--control-height) px-3',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-(--control-height-form) px-4',
        icon: 'size-(--control-height)',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
