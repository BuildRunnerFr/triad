import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ShieldCheck,
  ScanSearch,
  Scale,
  LockKeyhole,
  CheckCircle2,
  Loader2,
  Terminal,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import type { AuditLogEntry, AuditMode } from '../types';

interface LiveExecutionOverlayProps {
  visible: boolean;
  mode: AuditMode;
  sequenceLabel?: string | null;
  statuses: Record<string, string>;
  liveEntries: AuditLogEntry[];
  useCache: boolean;
}

const AGENTS = [
  {
    key: 'Douanier',
    title: '1. Douanier',
    subtitle: 'Masquage DLP & Anti-injection',
    detail: 'Analyse des pièces brutes, tokenisation PII et mise en quarantaine',
    icon: ShieldCheck,
  },
  {
    key: 'AnalysteConformite',
    title: '2. Analyste Conformité',
    subtitle: 'Référentiel NIS2 × Cloud GCP',
    detail: 'Inspection Storage, Pare-feu, IAM, KMS et exigences Art. 21 & 23',
    icon: ScanSearch,
  },
  {
    key: 'ContreAuditeur',
    title: '3. Contre-Auditeur',
    subtitle: 'Vérification textuelle exacte',
    detail: 'Contrôle mot à mot des citations sources et calibration des gravités',
    icon: Scale,
  },
  {
    key: 'GardeDuCorps',
    title: '4. Garde du Corps',
    subtitle: 'Scellement SHA-256',
    detail: 'Vérification d’intégrité du registre et verrouillage des livrables',
    icon: LockKeyhole,
  },
];

export const LiveExecutionOverlay: React.FC<LiveExecutionOverlayProps> = ({
  visible,
  mode,
  sequenceLabel,
  statuses,
  liveEntries,
  useCache,
}) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!visible) {
      setElapsed(0);
      return;
    }
    const t0 = performance.now();
    const id = window.setInterval(() => {
      setElapsed((performance.now() - t0) / 1000);
    }, 100);
    return () => window.clearInterval(id);
  }, [visible]);

  const completedCount = AGENTS.filter(
    (a) => statuses[a.key] === 'terminé'
  ).length;
  const activeCount = AGENTS.filter(
    (a) => statuses[a.key] === 'en_cours'
  ).length;
  const progressPct = Math.min(
    98,
    Math.max(8, completedCount * 25 + activeCount * 14)
  );

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ scale: 0.96, y: 14, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.97, y: 8, opacity: 0 }}
            transition={{ duration: 0.22 }}
            data-theme="dark"
            className="w-full max-w-4xl rounded-2xl bg-[var(--bg-rail)] border border-white/12 text-white shadow-2xl overflow-hidden"
          >
            {/* Barre supérieure Live */}
            <div className="px-6 py-4 bg-white/[0.03] border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--deloitte)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-[var(--deloitte)]" />
                </span>
                <div>
                  <div className="text-base font-semibold tracking-tight flex items-center gap-2">
                    <span>Audit en cours</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent-text)]">
                      {sequenceLabel || `phase ${mode === 'APRES' ? 'APRÈS' : 'AVANT'}`}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--text-secondary)]">
                    {useCache
                      ? 'Rejeu d’un audit enregistré, pièces filtrées par le Douanier'
                      : 'Les quatre agents croisent les pièces du dossier et la configuration Google Cloud'}
                  </div>
                </div>
              </div>

              <div className="font-mono text-sm font-bold text-[var(--accent-text)] tabular-nums bg-white/[0.05] px-3 py-1.5 rounded-xl border border-white/10">
                {elapsed.toFixed(1)}s
              </div>
            </div>

            {/* Barre de progression fluide */}
            <div className="h-1 w-full bg-white/5 overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-[var(--deloitte)] via-[var(--reel)] to-[var(--deloitte)]"
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.35 }}
              />
            </div>

            {/* Grille des 4 agents */}
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {AGENTS.map((ag) => {
                  const st = statuses[ag.key] || 'en_attente';
                  const Icon = ag.icon;
                  const isRunning = st === 'en_cours';
                  const isDone = st === 'terminé';

                  return (
                    <div
                      key={ag.key}
                      className={`rounded-xl p-4 border transition-all duration-300 ${
                        isRunning
                          ? 'bg-[var(--deloitte)]/12 border-[var(--deloitte)] shadow-[0_0_24px_rgba(134,188,37,0.2)]'
                          : isDone
                          ? 'bg-[var(--reel)]/[0.07] border-[var(--accent-border)]'
                          : 'bg-white/[0.02] border-white/8 opacity-60'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2.5">
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                            isRunning
                              ? 'bg-[var(--deloitte)] text-black'
                              : isDone
                              ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]'
                              : 'bg-white/8 text-slate-400'
                          }`}
                        >
                          {isRunning ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : isDone ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : (
                            <Icon className="w-4 h-4" />
                          )}
                        </div>
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            isRunning
                              ? 'bg-[var(--deloitte)] text-[#0B100D]'
                              : isDone
                              ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]'
                              : 'bg-white/8 text-slate-400'
                          }`}
                        >
                          {isRunning ? 'En cours' : isDone ? 'Terminé' : 'En attente'}
                        </span>
                      </div>
                      <div className="text-xs font-extrabold text-white">
                        {ag.title}
                      </div>
                      <div className="text-[11px] font-semibold text-[var(--accent-text)] mt-0.5">
                        {ag.subtitle}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                        {ag.detail}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Terminal de flux cryptographique SSE en direct */}
              <div className="rounded-xl bg-[#05070C] border border-white/10 overflow-hidden">
                <div className="px-4 py-2.5 bg-white/[0.03] border-b border-white/8 flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2 font-mono text-slate-300 font-semibold">
                    <Terminal className="w-3.5 h-3.5 text-[var(--accent-text)]" />
                    <span>Flux temps réel — Registre cryptographique SHA-256</span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-400">
                    {liveEntries.length} événement(s) scellé(s)
                  </span>
                </div>

                <div className="p-4 h-44 overflow-y-auto font-mono text-[11px] space-y-1.5">
                  {liveEntries.length === 0 ? (
                    <div className="text-slate-500 flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-[var(--accent-text)] animate-pulse" />
                      <span>Initialisation du sas Douanier et ouverture de la chaîne d&apos;audit…</span>
                    </div>
                  ) : (
                    liveEntries.slice(-8).map((entry, idx) => {
                      const isQuar = entry.action === 'QUARANTINE';
                      return (
                        <motion.div
                          key={`${entry.hash}-${idx}`}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          className={`flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg ${
                            isQuar
                              ? 'bg-[var(--warning-bg)] text-[var(--warning-text)] border border-[var(--warning-border)]'
                              : 'bg-white/[0.025] text-slate-300'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {isQuar && (
                              <AlertTriangle className="w-3.5 h-3.5 text-[var(--warning-text)] shrink-0" />
                            )}
                            <span className="text-[var(--accent-text)] font-bold">
                              [{entry.agent}]
                            </span>
                            <span className="font-semibold text-white">
                              {entry.action}
                            </span>
                            <span className="text-slate-400 truncate max-w-md">
                              {typeof entry.details === 'object'
                                ? JSON.stringify(entry.details)
                                : String(entry.details)}
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-500 shrink-0">
                            #{entry.hash.slice(0, 10)}
                          </span>
                        </motion.div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
