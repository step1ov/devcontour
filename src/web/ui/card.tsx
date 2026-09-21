import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('bg-card text-card-foreground rounded-lg border shadow-sm', className)}
      {...props}
    />
  );
}
function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-5', className)} {...props} />;
}
function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-md leading-tight font-semibold', className)} {...props} />;
}
function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-muted-foreground text-sm', className)} {...props} />;
}
function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}
function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-3 p-5 pt-0', className)} {...props} />;
}
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
