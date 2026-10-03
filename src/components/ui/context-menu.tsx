import * as Menu from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type Action = {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onSelect: () => void;
};

export function ContextMenu({
  children,
  actions,
}: {
  children: ReactNode;
  actions: Action[];
}) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{children}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="context-menu" collisionPadding={12}>
          {actions.map(({ label, icon: Icon, disabled, onSelect }) => (
            <Menu.Item
              key={label}
              className="context-menu-item"
              disabled={disabled}
              onSelect={onSelect}
            >
              <Icon size={15} />
              <span>{label}</span>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
