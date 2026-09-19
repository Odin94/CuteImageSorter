import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "size" | "asChild" | "title"
> & {
  tooltip: string;
};

function IconButton({ tooltip, ...props }: IconButtonProps) {
  const button = (
    <Button
      {...props}
      size="icon"
      aria-label={props["aria-label"] ?? tooltip}
    />
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {props.disabled ? (
          <span className="inline-flex">{button}</span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export { IconButton };
