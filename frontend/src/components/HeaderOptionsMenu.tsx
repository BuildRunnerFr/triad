import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Moon, RotateCcw, Search, SlidersHorizontal, Sun, Zap } from 'lucide-react';
import type { ThemeMode } from '../types';

type Density = 'comfort' | 'compact';

interface HeaderOptionsMenuProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
  useCache: boolean;
  onUseCacheChange: (value: boolean) => void;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onReset: () => void;
}

/**
 * Menu « Options d'affichage » : regroupe les réglages secondaires de l'en-tête
 * (thème, densité, cache hors ligne, palette, raccourcis, réinitialisation).
 */
export const HeaderOptionsMenu: React.FC<HeaderOptionsMenuProps> = ({
  theme,
  onThemeChange,
  density,
  onDensityChange,
  useCache,
  onUseCacheChange,
  onOpenPalette,
  onOpenShortcuts,
  onReset,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const segment = (active: boolean) =>
    `flex-1 inline-flex items-center justify-center gap-1.5 min-h-[34px] px-2.5 rounded-md text-xs font-semibold transition cursor-pointer ${
      active ? 'seg-active' : 'text-sub hover:text-main'
    }`;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Options d'affichage et de session"
        onClick={() => setOpen((v) => !v)}
        className="min-h-[38px] min-w-[38px] inline-flex items-center justify-center gap-1.5 px-2.5 rounded-lg border border-hairline hover:border-strong text-sub hover:text-main transition cursor-pointer"
      >
        <SlidersHorizontal className="w-4 h-4" />
        <span className="hidden xl:inline text-xs font-semibold">Options</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Options"
          className="absolute right-0 z-40 mt-2 w-72 surface-elevated rounded-xl p-3 space-y-3"
        >
          <div>
            <p className="text-xs text-sub mb-1.5">Thème</p>
            <div className="flex surface-subtle p-0.5 rounded-lg" role="group" aria-label="Thème">
              <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')} className={segment(theme === 'light')}>
                <Sun className="w-3.5 h-3.5" /> Clair
              </button>
              <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')} className={segment(theme === 'dark')}>
                <Moon className="w-3.5 h-3.5" /> Sombre
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs text-sub mb-1.5">Densité</p>
            <div className="flex surface-subtle p-0.5 rounded-lg" role="group" aria-label="Densité">
              <button type="button" aria-pressed={density === 'comfort'} onClick={() => onDensityChange('comfort')} className={segment(density === 'comfort')}>
                Confort
              </button>
              <button type="button" aria-pressed={density === 'compact'} onClick={() => onDensityChange('compact')} className={segment(density === 'compact')}>
                Compacte
              </button>
            </div>
          </div>

          <label className="flex items-start gap-2.5 px-1 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={useCache}
              onChange={(e) => onUseCacheChange(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[var(--deloitte)] cursor-pointer"
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm text-main">
                <Zap className="w-3.5 h-3.5" /> Cache de secours
              </span>
              <span className="block text-xs text-sub">Rejoue un audit enregistré si Gemini est indisponible.</span>
            </span>
          </label>

          <div className="pt-2 border-t border-hairline space-y-0.5">
            <button type="button" role="menuitem" onClick={run(onOpenPalette)} className="w-full flex items-center justify-between gap-2 px-2 py-2 rounded-lg text-sm text-main hover:bg-[var(--bg-hover)] cursor-pointer">
              <span className="inline-flex items-center gap-2"><Search className="w-4 h-4 text-sub" /> Palette de commandes</span>
              <kbd className="kbd-pill">Ctrl K</kbd>
            </button>
            <button type="button" role="menuitem" onClick={run(onOpenShortcuts)} className="w-full flex items-center justify-between gap-2 px-2 py-2 rounded-lg text-sm text-main hover:bg-[var(--bg-hover)] cursor-pointer">
              <span className="inline-flex items-center gap-2"><Keyboard className="w-4 h-4 text-sub" /> Raccourcis clavier</span>
              <kbd className="kbd-pill">?</kbd>
            </button>
            <button type="button" role="menuitem" onClick={run(onReset)} className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-[var(--critical-text)] hover:bg-[var(--critical-bg)] cursor-pointer">
              <RotateCcw className="w-4 h-4" /> Réinitialiser la session
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
