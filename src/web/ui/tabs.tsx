import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

const Tabs = TabsPrimitive.Root;
function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'bg-secondary text-muted-foreground inline-flex h-10 items-center justify-center gap-1 rounded-md p-1',
        className,
      )}
      {...props}
    />
  );
}
function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'ring-offset-background inline-flex cursor-pointer items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('mt-4', className)} {...props} />;
}
export { Tabs, TabsList, TabsTrigger, TabsContent };
