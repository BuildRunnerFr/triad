import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircle2,
  Info,
  AlertTriangle,
  ShieldAlert,
  X,
} from 'lucide-react';

export type ToastTone = 'success' | 'info' | 'warning' | 'critical';

export interface ToastItem {
  id: string;
  title: string;
  detail?: string;
  tone: ToastTone;
}

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const TONE_META: Record<
  ToastTone,
  {
    borderCls: string;
    iconCls: string;
    Icon: React.ComponentType<{ className?: string }>;
  }
> = {
  success: {
    borderCls: 'border-l-4 border-l-[#86BC25]',
    iconCls: 'text-[#86BC25]',
    Icon: CheckCircle2,
  },
  info: {
    borderCls: 'border-l-4 border-l-sky-400',
    iconCls: 'tone-info',
    Icon: Info,
  },
  warning: {
    borderCls: 'border-l-4 border-l-amber-400',
    iconCls: 'tone-warning',
    Icon: AlertTriangle,
  },
  critical: {
    borderCls: 'border-l-4 border-l-rose-500',
    iconCls: 'tone-critical',
    Icon: ShieldAlert,
  },
};

export const ToastStack: React.FC<ToastStackProps> = ({ toasts, onDismiss }) => (
  <div
    role="region"
    aria-label="Notifications système"
    aria-live="polite"
    className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-[calc(100vw-2.5rem)] max-w-sm pointer-events-none print:hidden"
  >
    <AnimatePresence initial={false}>
      {toasts.map((toast) => {
        const meta = TONE_META[toast.tone];
        const Icon = meta.Icon;
        return (
          <motion.div
            key={toast.id}
            role="status"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className={`pointer-events-auto surface-elevated rounded-xl px-3.5 py-3 flex items-start justify-between gap-3 ${meta.borderCls}`}
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${meta.iconCls}`} />
              <div className="min-w-0">
                <div className="text-xs font-extrabold text-main leading-snug">
                  {toast.title}
                </div>
                {toast.detail && (
                  <div className="text-[11px] text-sub mt-0.5 leading-snug">
                    {toast.detail}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              aria-label="Fermer la notification"
              onClick={() => onDismiss(toast.id)}
              className="p-1 rounded-lg text-dim hover:text-main transition cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        );
      })}
    </AnimatePresence>
  </div>
);
