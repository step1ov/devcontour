import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

// Карточка без тени: уровень задаёт рамка. Внутри рабочего листа
// (`data-sheet`) карточка становится секцией с линией сверху — см. theme.css.
function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('bg-card text-card-foreground rounded-md border', className)}
      {...props}
    />
  );
}
function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />;
}
function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-md m-0 leading-tight font-semibold', className)} {...props} />;
}
function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-muted-foreground text-sm', className)} {...props} />;
}
function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-0', className)} {...props} />;
}
function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-3 p-4 pt-0', className)} {...props} />;
}
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
