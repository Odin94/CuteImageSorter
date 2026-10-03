import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 500,
  skipDelayDuration = 350,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "tooltip-content z-50 origin-[var(--radix-tooltip-content-transform-origin)] rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background shadow-lg transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] data-[state=instant-open]:duration-0 data-[instant]:duration-0 data-[state=closed]:scale-[0.9] data-[state=closed]:opacity-0",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
