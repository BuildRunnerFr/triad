import React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

interface UiTooltipProps {
  label: React.ReactNode;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: React.ReactElement;
}

export const UiTooltipProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <TooltipPrimitive.Provider delayDuration={180} skipDelayDuration={80}>
    {children}
  </TooltipPrimitive.Provider>
);

export const UiTooltip: React.FC<UiTooltipProps> = ({
  label,
  shortcut,
  side = 'bottom',
  children,
}) => (
  <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side}
        sideOffset={6}
        className="z-50 surface-elevated rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-main flex items-center gap-2 select-none animate-in fade-in-0 zoom-in-95"
      >
        <span>{label}</span>
        {shortcut && <kbd className="kbd-pill">{shortcut}</kbd>}
        <TooltipPrimitive.Arrow className="fill-[var(--border-strong)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);
