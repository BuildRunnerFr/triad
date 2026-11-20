import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Keyboard, X } from 'lucide-react';

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SHORTCUTS = [
  {
    keys: ['Ctrl', 'K'],
    desc: 'Palette de commandes et recherche plein-texte',
  },
  {
    keys: ['Alt', '1…5'],
    desc: 'Accès direct : Mission, Cockpit, Investigation, Comparateur, Livrables',
  },
  {
    keys: ['1', '…', '5'],
    desc: 'Navigation rapide entre les 5 vues (hors champs)',
  },
  {
    keys: ['?'],
    desc: 'Afficher les raccourcis clavier',
  },
  {
    keys: ['Échap'],
    desc: 'Fermer le tiroir, la palette ou la fenêtre active',
  },
];

export const KeyboardShortcutsDialog: React.FC<KeyboardShortcutsDialogProps> = ({
  open,
  onOpenChange,
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs animate-in fade-in-0 duration-150" />
      <Dialog.Content
        aria-describedby="shortcuts-desc"
        className="fixed left-1/2 top-[18%] z-50 w-[92vw] max-w-md -translate-x-1/2 surface-elevated rounded-2xl overflow-hidden focus:outline-none"
      >
        <div className="px-5 py-4 border-b border-hairline flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl badge-success flex items-center justify-center">
              <Keyboard className="w-4 h-4" />
            </div>
            <div>
              <Dialog.Title className="text-sm font-extrabold text-main">
                Raccourcis Clavier Rapides
              </Dialog.Title>
              <Dialog.Description id="shortcuts-desc" className="text-[11px] text-sub">
                Tout TRIAD au clavier, sans quitter la tâche en cours
              </Dialog.Description>
            </div>
          </div>

          <button
            type="button"
            aria-label="Fermer l'aide clavier"
            onClick={() => onOpenChange(false)}
            className="p-1.5 rounded-lg surface-subtle text-sub hover:text-main cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-2">
          {SHORTCUTS.map((s, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl surface-card text-xs"
            >
              <span className="text-main font-medium">{s.desc}</span>
              <div className="flex items-center gap-1 shrink-0">
                {s.keys.map((k, j) => (
                  <kbd key={j} className="kbd-pill">
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-2.5 surface-subtle border-t border-hairline text-[11px] text-dim text-right">
          Appuyez sur <kbd className="kbd-pill">Échap</kbd> pour fermer
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
