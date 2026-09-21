import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

function DialogContent({
  className,
  children,
  closeLabel = 'Закрыть диалог',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { closeLabel?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="bg-(--overlay) fixed inset-0 z-20" />
      <DialogPrimitive.Content
        className={cn(
          'bg-card fixed top-1/2 left-1/2 z-20 grid w-[calc(100vw-2rem)] max-w-(--dialog-width) max-h-[90vh] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border p-6 shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label={closeLabel}
          className="absolute top-4 right-4 cursor-pointer rounded-sm opacity-70 hover:opacity-100"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription };
