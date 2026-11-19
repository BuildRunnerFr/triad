import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X,
  Copy,
  Check,
  Terminal,
  AlertOctagon,
  ShieldCheck,
  CheckCircle2,
  Database,
  Sparkles,
  Eye,
  ChevronUp,
  ChevronDown,
  Scale,
  Loader2,
  FileSearch,
} from 'lucide-react';
import type {
  AuditMode,
  DrawerContent,
  FindingDecisionPatchPayload,
  GrcDecisionType,
} from '../types';
import {
  GRC_DECISION_META,
  GRC_DECISION_OPTIONS,
} from '../utils/grcSimulation';

type PiiKind = 'NOM' | 'EMAIL' | 'TEL' | 'IBAN';
type FindingSubTab = 'preuves' | 'arbitrage' | 'remediation';

const PII_KINDS: PiiKind[] = ['NOM', 'EMAIL', 'TEL', 'IBAN'];

const PII_BADGE_CLASS: Record<PiiKind, string> = {
  NOM: 'badge-info',
  EMAIL: 'badge-violet',
  TEL: 'badge-success',
  IBAN: 'badge-warning',
};

const FINDING_SUB_TABS: ReadonlyArray<{
  key: FindingSubTab;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'preuves', label: 'Preuves Dit/Écrit/Réel', Icon: FileSearch },
  { key: 'arbitrage', label: 'Arbitrage GRC', Icon: Scale },
  { key: 'remediation', label: 'Remédiation GCP', Icon: Terminal },
];

interface InspectorDrawerProps {
  content: DrawerContent;
  mode?: AuditMode;
  onClose: () => void;
  onSaveFindingDecision?: (
    findingId: string,
    payload: FindingDecisionPatchPayload
  ) => Promise<boolean>;
}

export const InspectorDrawer: React.FC<InspectorDrawerProps> = ({
  content,
  mode = 'APRES',
  onClose,
  onSaveFindingDecision,
}) => {
  const [findingTab, setFindingTab] = useState<FindingSubTab>('preuves');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [piiFilter, setPiiFilter] = useState<'ALL' | PiiKind>('ALL');
  const [piiSpotlight, setPiiSpotlight] = useState<boolean>(true);
  const [activePiiIndex, setActivePiiIndex] = useState<number>(-1);
  const [jsonExpanded, setJsonExpanded] = useState<boolean>(false);

  // États du formulaire d'Arbitrage Consultant GRC
  const [decisionType, setDecisionType] =
    useState<GrcDecisionType>('a_corriger');
  const [porteur, setPorteur] = useState<string>('');
  const [echeance, setEcheance] = useState<string>('');
  const [commentaire, setCommentaire] = useState<string>('');
  const [isSavingDecision, setIsSavingDecision] = useState<boolean>(false);

  const highlightRef = useRef<HTMLElement | null>(null);
  const piiRefs = useRef<Map<number, HTMLElement>>(new Map());
  const subTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const activeFindingId =
    content?.type === 'finding' ? content.finding.id : null;

  useEffect(() => {
    setFindingTab('preuves');
    setJsonExpanded(false);
  }, [activeFindingId]);

  useEffect(() => {
    setPiiFilter('ALL');
    setActivePiiIndex(-1);
    piiRefs.current.clear();

    if (content?.type === 'finding') {
      const existing = content.finding.decision_grc;
      if (existing) {
        setDecisionType(existing.decision);
        setPorteur(existing.porteur || '');
        setEcheance(existing.echeance || '');
        setCommentaire(existing.commentaire || '');
      } else {
        setDecisionType(
          content.finding.statut === 'conforme'
            ? 'mesure_compensatoire'
            : content.finding.statut === 'a_confirmer'
            ? 'a_approfondir'
            : 'a_corriger'
        );
        setPorteur('');
        setEcheance(
          content.finding.gravite === 'critique'
            ? 'J+30'
            : content.finding.gravite === 'haute'
            ? 'J+60'
            : 'J+90'
        );
        setCommentaire('');
      }
    }

    if (
      content?.type === 'doc' &&
      (content.highlightQuote || content.highlightLine)
    ) {
      const timer = window.setTimeout(() => {
        highlightRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 200);
      return () => window.clearTimeout(timer);
    }
  }, [content]);

  const piiStats = useMemo(() => {
    const counts: Record<PiiKind, number> = {
      NOM: 0,
      EMAIL: 0,
      TEL: 0,
      IBAN: 0,
    };
    if (content?.type !== 'doc') {
      return { counts, total: 0 };
    }
    const text = content.doc.contenu_masque || '';
    if (text) {
      const matches = text.matchAll(/\[(NOM|EMAIL|TEL|IBAN)_\d+\]/g);
      for (const m of matches) {
        const kind = m[1] as PiiKind;
        counts[kind] += 1;
      }
    } else if (content.doc.masquages) {
      for (const [k, v] of Object.entries(content.doc.masquages)) {
        const upper = k.toUpperCase() as PiiKind;
        if (upper in counts && typeof v === 'number') {
          counts[upper] = v;
        }
      }
    }
    const total = counts.NOM + counts.EMAIL + counts.TEL + counts.IBAN;
    return { counts, total };
  }, [content]);

  const filteredPiiCount =
    piiFilter === 'ALL' ? piiStats.total : piiStats.counts[piiFilter];

  const jumpToPiiOccurrence = (nextIndex: number) => {
    if (filteredPiiCount <= 0) return;
    const wrapped =
      ((nextIndex % filteredPiiCount) + filteredPiiCount) % filteredPiiCount;
    setActivePiiIndex(wrapped);
    setPiiSpotlight(true);
    window.requestAnimationFrame(() => {
      piiRefs.current.get(wrapped)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
  };

  const handleSelectPiiFilter = (nextFilter: 'ALL' | PiiKind) => {
    setPiiFilter(nextFilter);
    piiRefs.current.clear();
    const targetCount =
      nextFilter === 'ALL' ? piiStats.total : piiStats.counts[nextFilter];
    if (targetCount > 0) {
      setActivePiiIndex(0);
      setPiiSpotlight(true);
      window.setTimeout(() => {
        piiRefs.current.get(0)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 40);
    } else {
      setActivePiiIndex(-1);
    }
  };

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleSubTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') {
      nextIdx = (idx + 1) % FINDING_SUB_TABS.length;
    } else if (e.key === 'ArrowLeft') {
      nextIdx = (idx - 1 + FINDING_SUB_TABS.length) % FINDING_SUB_TABS.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = FINDING_SUB_TABS.length - 1;
    }
    if (nextIdx !== null) {
      e.preventDefault();
      setFindingTab(FINDING_SUB_TABS[nextIdx].key);
      subTabRefs.current[nextIdx]?.focus();
    }
  };

  const renderTokensOnly = (
    text: string,
    suspect?: string | null,
    claimMatchIdx?: () => number
  ) => {
    const tokenRegex = /(\[(?:NOM|EMAIL|TEL|IBAN)_\d+\])/g;
    const parts = text.split(tokenRegex);
    return parts.map((part, i) => {
      const tokenMatch = part.match(/^\[(NOM|EMAIL|TEL|IBAN)_\d+\]$/);
      if (tokenMatch) {
        const kind = tokenMatch[1] as PiiKind;
        const isInFilter = piiFilter === 'ALL' || piiFilter === kind;
        const occIdx = isInFilter && claimMatchIdx ? claimMatchIdx() : -1;
        const isFocused = occIdx !== -1 && occIdx === activePiiIndex;

        const visualCls = !piiSpotlight
          ? 'surface-subtle text-sub border border-hairline'
          : isInFilter
          ? PII_BADGE_CLASS[kind]
          : 'surface-subtle text-dim opacity-45';

        return (
          <span
            key={i}
            ref={(el) => {
              if (occIdx === -1) return;
              if (el) {
                piiRefs.current.set(occIdx, el);
              } else {
                piiRefs.current.delete(occIdx);
              }
            }}
            onClick={() => {
              if (occIdx !== -1) setActivePiiIndex(occIdx);
            }}
            className={`${visualCls} inline-block px-1.5 py-0.2 mx-0.5 rounded font-mono text-[11px] font-bold transition ${
              occIdx !== -1 ? 'cursor-pointer' : ''
            } ${
              isFocused
                ? 'ring-2 ring-[#86BC25] ring-offset-1 scale-105 shadow-sm'
                : ''
            }`}
          >
            {part}
          </span>
        );
      }
      if (suspect && suspect.length > 8 && part.includes(suspect)) {
        const subParts = part.split(suspect);
        return (
          <React.Fragment key={i}>
            {subParts.map((sp, j) => (
              <React.Fragment key={j}>
                {sp}
                {j < subParts.length - 1 && (
                  <mark className="badge-critical font-bold px-1 rounded">
                    {suspect}
                  </mark>
                )}
              </React.Fragment>
            ))}
          </React.Fragment>
        );
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });
  };

  const renderHighlightedDoc = (
    text: string,
    suspectQuote?: string | null,
    targetQuote?: string,
    targetLine?: number
  ) => {
    let matchCounter = 0;
    const claimMatchIdx = () => {
      const current = matchCounter;
      matchCounter += 1;
      return current;
    };

    const cleanTarget = targetQuote
      ?.replace(/^(?:\.{3}|…)\s*/, '')
      .replace(/\s*(?:\.{3}|…)$/, '')
      .trim();

    if (typeof targetLine === 'number' && targetLine >= 1) {
      const lines = text.split('\n');
      if (targetLine <= lines.length) {
        const lineIndex = targetLine - 1;
        const prefixText =
          lineIndex > 0 ? `${lines.slice(0, lineIndex).join('\n')}\n` : '';
        const focusLine = lines[lineIndex];
        const suffixText =
          lineIndex < lines.length - 1
            ? `\n${lines.slice(lineIndex + 1).join('\n')}`
            : '';

        if (cleanTarget && cleanTarget.length >= 2) {
          const subIdx = focusLine
            .toLowerCase()
            .indexOf(cleanTarget.toLowerCase());
          if (subIdx !== -1) {
            const lineBefore = focusLine.slice(0, subIdx);
            const lineMatch = focusLine.slice(
              subIdx,
              subIdx + cleanTarget.length
            );
            const lineAfter = focusLine.slice(subIdx + cleanTarget.length);
            return (
              <>
                {renderTokensOnly(
                  prefixText + lineBefore,
                  suspectQuote,
                  claimMatchIdx
                )}
                <mark
                  ref={highlightRef}
                  className="bg-[#86BC25]/30 text-main border-b-2 border-[#86BC25] px-1 py-0.5 rounded font-semibold"
                >
                  {renderTokensOnly(lineMatch, suspectQuote, claimMatchIdx)}
                </mark>
                {renderTokensOnly(
                  lineAfter + suffixText,
                  suspectQuote,
                  claimMatchIdx
                )}
              </>
            );
          }
        }

        return (
          <>
            {renderTokensOnly(prefixText, suspectQuote, claimMatchIdx)}
            <mark
              ref={highlightRef}
              className="bg-[#86BC25]/30 text-main border-b-2 border-[#86BC25] px-1 py-0.5 rounded font-semibold"
            >
              {renderTokensOnly(focusLine, suspectQuote, claimMatchIdx)}
            </mark>
            {renderTokensOnly(suffixText, suspectQuote, claimMatchIdx)}
          </>
        );
      }
    }

    if (cleanTarget && cleanTarget.length >= 2) {
      const idx = text.toLowerCase().indexOf(cleanTarget.toLowerCase());
      if (idx !== -1) {
        const before = text.slice(0, idx);
        const match = text.slice(idx, idx + cleanTarget.length);
        const after = text.slice(idx + cleanTarget.length);
        return (
          <>
            {renderTokensOnly(before, suspectQuote, claimMatchIdx)}
            <mark
              ref={highlightRef}
              className="bg-[#86BC25]/30 text-main border-b-2 border-[#86BC25] px-1 py-0.5 rounded font-semibold"
            >
              {renderTokensOnly(match, suspectQuote, claimMatchIdx)}
            </mark>
            {renderTokensOnly(after, suspectQuote, claimMatchIdx)}
          </>
        );
      }
    }
    return renderTokensOnly(text, suspectQuote, claimMatchIdx);
  };

  const rawProof =
    content?.type === 'finding'
      ? content.finding.reel?.preuve ?? content.finding.reel?.preuve_json ?? null
      : null;

  return (
    <AnimatePresence>
      {content && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={onClose}
          />

          <motion.aside
            role="dialog"
            aria-modal="true"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 280 }}
            className="relative z-10 w-full max-w-2xl surface-panel h-full shadow-2xl flex flex-col overflow-hidden border-l border-hairline"
          >
            {/* En-tête compact du tiroir */}
            <div className="px-5 py-3.5 bg-[#07090F] text-white border-b-2 border-[#86BC25] flex items-center justify-between gap-3 shrink-0">
              <div className="min-w-0">
                <div className="text-[10px] font-extrabold uppercase tracking-widest text-[#86BC25]">
                  {content.type === 'finding'
                    ? 'Constat NIS2'
                    : content.type === 'doc'
                    ? 'Pièce DLP Douanier'
                    : 'Aperçu'}
                </div>
                <h3 className="text-sm sm:text-base font-extrabold truncate mt-0.5">
                  {content.type === 'finding'
                    ? `${content.finding.id} — ${content.finding.theme}`
                    : content.type === 'doc'
                    ? content.doc.nom_fichier
                    : ''}
                </h3>
              </div>

              <button
                type="button"
                aria-label="Fermer le tiroir"
                onClick={onClose}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Barre des 3 Sous-Onglets (uniquement pour un constat) */}
            {content.type === 'finding' && (
              <div className="px-5 pt-3 pb-2.5 surface-subtle border-b border-hairline space-y-2.5 shrink-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold surface-card text-main">
                    {content.finding.exigence_nis2}
                  </span>
                  <span className="badge-critical px-2.5 py-0.5 rounded-full text-[11px] font-extrabold uppercase">
                    {content.finding.gravite}
                  </span>
                  {content.finding.contradiction && (
                    <span className="badge-warning px-2.5 py-0.5 rounded-full text-[11px] font-extrabold">
                      {content.finding.contradiction}
                    </span>
                  )}
                  {typeof content.finding.confiance === 'number' && (
                    <span className="badge-success px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold tabular-nums">
                      {Math.round(content.finding.confiance * 100)}%
                    </span>
                  )}
                  {content.finding.decision_grc && (
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                        GRC_DECISION_META[
                          content.finding.decision_grc.decision
                        ]?.badgeCls || 'badge-info'
                      }`}
                    >
                      {content.finding.decision_grc.decision_label}
                    </span>
                  )}
                </div>

                <div
                  role="tablist"
                  aria-label="Sections du constat"
                  className="grid grid-cols-3 gap-1.5 surface-card p-1 rounded-xl"
                >
                  {FINDING_SUB_TABS.map((tab, idx) => {
                    const Icon = tab.Icon;
                    const active = findingTab === tab.key;
                    return (
                      <button
                        key={tab.key}
                        ref={(el) => {
                          subTabRefs.current[idx] = el;
                        }}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        onClick={() => setFindingTab(tab.key)}
                        onKeyDown={(e) => handleSubTabKeyDown(e, idx)}
                        className={`min-h-[34px] inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                          active
                            ? 'bg-[#86BC25] text-black shadow-xs'
                            : 'text-sub hover:text-main'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Corps scrollable épuré */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {content.type === 'finding' && (
                <>
                  {/* SOUS-ONGLET 1 : PREUVES DIT / ÉCRIT / RÉEL */}
                  {findingTab === 'preuves' && (
                    <div
                      role="tabpanel"
                      aria-label="Preuves Dit/Écrit/Réel"
                      className="space-y-3"
                    >
                      <div className="surface-card rounded-xl p-4 border-l-4 border-l-sky-500 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-extrabold uppercase tone-info">
                            DIT • Entretien DSI
                          </span>
                          {content.finding.dit?.source && (
                            <span className="font-mono text-[10px] text-dim truncate">
                              {content.finding.dit.source}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-main leading-relaxed">
                          {content.finding.dit
                            ? `« ${content.finding.dit.extrait} »`
                            : 'Aucune déclaration associée.'}
                        </p>
                      </div>

                      <div className="surface-card rounded-xl p-4 border-l-4 border-l-violet-500 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-extrabold uppercase tone-violet">
                            ÉCRIT • Référentiel
                          </span>
                          {content.finding.ecrit?.source && (
                            <span className="font-mono text-[10px] text-dim truncate">
                              {content.finding.ecrit.source}
                              {content.finding.ecrit.section
                                ? ` • ${content.finding.ecrit.section}`
                                : ''}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-main leading-relaxed">
                          {content.finding.ecrit
                            ? `« ${content.finding.ecrit.extrait} »`
                            : 'Non documenté.'}
                        </p>
                      </div>

                      <div className="surface-card rounded-xl p-4 border-l-4 border-l-[#86BC25] space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-extrabold uppercase text-accent">
                            RÉEL • Sonde Cloud GCP
                          </span>
                          {content.finding.reel?.ressource && (
                            <code className="font-mono text-[10px] text-sub truncate">
                              {content.finding.reel.ressource}
                            </code>
                          )}
                        </div>
                        <p className="text-xs text-main leading-relaxed">
                          {content.finding.reel
                            ? content.finding.reel.constat
                            : 'Contrôle procédural.'}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* SOUS-ONGLET 2 : ARBITRAGE GRC */}
                  {findingTab === 'arbitrage' && (
                    <div
                      role="tabpanel"
                      aria-label="Arbitrage GRC"
                      className="space-y-4"
                    >
                      {onSaveFindingDecision ? (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (isSavingDecision) return;
                            setIsSavingDecision(true);
                            try {
                              await onSaveFindingDecision(content.finding.id, {
                                decision: decisionType,
                                porteur,
                                echeance,
                                commentaire,
                                mode,
                              });
                            } finally {
                              setIsSavingDecision(false);
                            }
                          }}
                          className="surface-card rounded-2xl p-4 space-y-3.5 border border-hairline"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-extrabold text-main">
                              Décision sur {content.finding.id}
                            </span>
                            <span className="font-mono text-[10px] text-dim">
                              Scellé SHA-256
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {GRC_DECISION_OPTIONS.map((optKey) => {
                              const meta = GRC_DECISION_META[optKey];
                              const selected = decisionType === optKey;
                              return (
                                <button
                                  key={optKey}
                                  type="button"
                                  aria-pressed={selected}
                                  onClick={() => setDecisionType(optKey)}
                                  className={`text-left p-2.5 rounded-xl border transition cursor-pointer ${
                                    selected
                                      ? 'border-[#86BC25] bg-[var(--accent-soft)]'
                                      : 'surface-subtle border-hairline hover:border-strong'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-1.5">
                                    <span className="text-xs font-extrabold text-main">
                                      {meta.label}
                                    </span>
                                    {selected && (
                                      <Check className="w-3.5 h-3.5 text-accent shrink-0" />
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label className="block space-y-1">
                              <span className="text-[11px] font-bold text-sub">
                                Porteur
                              </span>
                              <input
                                type="text"
                                value={porteur}
                                onChange={(e) => setPorteur(e.target.value)}
                                placeholder="ex. RSSI & Ops GCP"
                                maxLength={160}
                                className="w-full px-3 py-1.5 rounded-xl surface-subtle border border-hairline focus:border-[#86BC25] focus:outline-none text-xs text-main placeholder:text-dim"
                              />
                            </label>

                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-[11px] font-bold text-sub">
                                  Échéance
                                </span>
                                <div className="flex items-center gap-1">
                                  {(
                                    ['J+15', 'J+30', 'J+60', 'J+90'] as const
                                  ).map((preset) => (
                                    <button
                                      key={preset}
                                      type="button"
                                      onClick={() => setEcheance(preset)}
                                      className={`px-1.5 py-0.2 rounded font-mono text-[10px] font-bold transition cursor-pointer ${
                                        echeance === preset
                                          ? 'bg-[#86BC25] text-black'
                                          : 'surface-subtle text-dim hover:text-main'
                                      }`}
                                    >
                                      {preset}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <input
                                type="text"
                                value={echeance}
                                onChange={(e) => setEcheance(e.target.value)}
                                placeholder="J+30 ou 2026-12-31"
                                maxLength={64}
                                className="w-full px-3 py-1.5 rounded-xl surface-subtle border border-hairline focus:border-[#86BC25] focus:outline-none text-xs font-mono text-main placeholder:text-dim"
                              />
                            </div>
                          </div>

                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold text-sub">
                              Justification
                            </span>
                            <textarea
                              rows={3}
                              value={commentaire}
                              onChange={(e) => setCommentaire(e.target.value)}
                              placeholder="Mesure compensatoire ou motif d'arbitrage…"
                              maxLength={2000}
                              className="w-full px-3 py-2 rounded-xl surface-subtle border border-hairline focus:border-[#86BC25] focus:outline-none text-xs text-main placeholder:text-dim resize-y"
                            />
                          </label>

                          <div className="flex justify-end pt-1">
                            <button
                              type="submit"
                              disabled={isSavingDecision}
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#86BC25] hover:bg-[#96cf2e] disabled:opacity-50 text-black text-xs font-extrabold transition cursor-pointer"
                            >
                              {isSavingDecision ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <ShieldCheck className="w-3.5 h-3.5" />
                              )}
                              <span>Enregistrer l&apos;arbitrage GRC</span>
                            </button>
                          </div>
                        </form>
                      ) : content.finding.decision_grc ? (
                        <div className="surface-card rounded-2xl p-4 space-y-2">
                          <div className="text-xs font-extrabold text-main">
                            {content.finding.decision_grc.decision_label}
                          </div>
                          {content.finding.decision_grc.porteur && (
                            <div className="text-xs text-sub">
                              Porteur : {content.finding.decision_grc.porteur}
                            </div>
                          )}
                          {content.finding.decision_grc.echeance && (
                            <div className="text-xs font-mono text-sub">
                              Échéance : {content.finding.decision_grc.echeance}
                            </div>
                          )}
                          {content.finding.decision_grc.commentaire && (
                            <p className="text-xs text-main">
                              {content.finding.decision_grc.commentaire}
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="surface-card rounded-2xl p-5 text-center text-xs text-sub">
                          Aucun arbitrage enregistré sur ce constat.
                        </div>
                      )}
                    </div>
                  )}

                  {/* SOUS-ONGLET 3 : REMÉDIATION GCP */}
                  {findingTab === 'remediation' && (
                    <div
                      role="tabpanel"
                      aria-label="Remédiation GCP"
                      className="space-y-3.5"
                    >
                      <div className="surface-card rounded-2xl p-4 space-y-1.5">
                        <div className="text-[11px] font-extrabold uppercase tracking-wider text-accent flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Action Corrective
                        </div>
                        <p className="text-xs text-main leading-relaxed">
                          {content.finding.recommandation}
                        </p>
                      </div>

                      {content.finding.commande_correction ? (
                        <div className="rounded-2xl overflow-hidden border border-white/12 bg-[#07090F] text-white">
                          <div className="px-4 py-2.5 bg-white/[0.04] border-b border-white/10 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-[11px] font-bold text-[#86BC25]">
                              <Terminal className="w-3.5 h-3.5" />
                              <span>gcloud (Dry-Run • Non exécutée)</span>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                copyText(
                                  'gcloud',
                                  content.finding.commande_correction!
                                )
                              }
                              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 transition cursor-pointer"
                            >
                              {copiedKey === 'gcloud' ? (
                                <>
                                  <Check className="w-3 h-3 text-[#86BC25]" />{' '}
                                  Copié
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" /> Copier
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="p-4 text-xs font-mono text-emerald-400 overflow-x-auto leading-relaxed">
                            {content.finding.commande_correction}
                          </pre>
                        </div>
                      ) : (
                        <div className="surface-subtle rounded-xl px-3.5 py-2.5 text-xs text-sub">
                          Mesure organisationnelle — aucune commande CLI requise.
                        </div>
                      )}

                      {rawProof && (
                        <div className="rounded-2xl overflow-hidden border border-hairline surface-card">
                          <div className="px-4 py-2.5 surface-subtle flex items-center justify-between gap-2 text-xs font-bold text-main">
                            <button
                              type="button"
                              aria-expanded={jsonExpanded}
                              onClick={() => setJsonExpanded((v) => !v)}
                              className="inline-flex items-center gap-2 text-left cursor-pointer"
                            >
                              <Database className="w-3.5 h-3.5 text-accent" />
                              <span>Preuve JSON Sonde GCP</span>
                              <ChevronDown
                                className={`w-3.5 h-3.5 text-dim transition-transform ${
                                  jsonExpanded ? 'rotate-180' : ''
                                }`}
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                copyText(
                                  'json',
                                  JSON.stringify(rawProof, null, 2)
                                )
                              }
                              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded surface-card text-sub hover:text-main cursor-pointer"
                            >
                              {copiedKey === 'json' ? (
                                <>
                                  <Check className="w-3 h-3 text-accent" /> Copié
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" /> Copier JSON
                                </>
                              )}
                            </button>
                          </div>
                          {jsonExpanded && (
                            <pre className="p-4 border-t border-hairline text-[11px] font-mono text-sub overflow-x-auto leading-relaxed">
                              {JSON.stringify(rawProof, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* CAS 2 : LECTEUR DOCUMENTAIRE SYNCHRONISÉ */}
              {content.type === 'doc' && (
                <>
                  {content.doc.statut === 'quarantaine' ? (
                    <div className="rounded-2xl badge-critical p-3.5 flex gap-3 items-start">
                      <AlertOctagon className="w-5 h-5 shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-extrabold uppercase">
                          Quarantaine Douanier
                        </div>
                        <p className="text-xs text-main mt-0.5 leading-relaxed">
                          {content.doc.raison_quarantaine ||
                            'Injection adverse détectée.'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-2xl badge-success px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex gap-2 items-center text-xs font-extrabold text-main">
                        <ShieldCheck className="w-4 h-4 shrink-0" />
                        <span>DLP Douanier • Zéro PII exposée</span>
                      </div>
                      {(content.highlightQuote || content.highlightLine) && (
                        <span className="text-[11px] text-accent inline-flex items-center gap-1 font-semibold">
                          <Sparkles className="w-3 h-3" />
                          {content.highlightLine
                            ? `Ligne ${content.highlightLine}`
                            : 'Extrait surligné'}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Barre compacte de filtrage PII */}
                  <div className="surface-card rounded-2xl p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded-full badge-success font-bold tabular-nums">
                        {piiStats.total} PII masquée(s)
                      </span>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-pressed={piiSpotlight}
                          onClick={() => setPiiSpotlight((v) => !v)}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                            piiSpotlight
                              ? 'badge-success'
                              : 'surface-subtle text-sub hover:text-main'
                          }`}
                        >
                          <Eye className="w-3 h-3" />
                          <span>Surligner PII</span>
                        </button>

                        {filteredPiiCount > 0 && (
                          <div className="inline-flex items-center gap-1 surface-subtle px-1.5 py-0.5 rounded-lg">
                            <span className="font-mono text-[10px] text-sub px-1 tabular-nums">
                              {activePiiIndex >= 0
                                ? `${activePiiIndex + 1}/${filteredPiiCount}`
                                : `0/${filteredPiiCount}`}
                            </span>
                            <button
                              type="button"
                              aria-label="Occurrence PII précédente"
                              onClick={() =>
                                jumpToPiiOccurrence(
                                  activePiiIndex <= 0
                                    ? filteredPiiCount - 1
                                    : activePiiIndex - 1
                                )
                              }
                              className="p-1 rounded hover:bg-black/10 text-sub hover:text-main cursor-pointer"
                            >
                              <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              aria-label="Occurrence PII suivante"
                              onClick={() =>
                                jumpToPiiOccurrence(activePiiIndex + 1)
                              }
                              className="p-1 rounded hover:bg-black/10 text-sub hover:text-main cursor-pointer"
                            >
                              <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        aria-pressed={piiFilter === 'ALL'}
                        onClick={() => handleSelectPiiFilter('ALL')}
                        className={`px-2.5 py-1 rounded-lg font-mono text-[10px] font-bold transition cursor-pointer tabular-nums ${
                          piiFilter === 'ALL'
                            ? 'bg-[#86BC25] text-black'
                            : 'surface-subtle text-sub hover:text-main'
                        }`}
                      >
                        Tous ({piiStats.total})
                      </button>

                      {PII_KINDS.map((kind) => {
                        const count = piiStats.counts[kind];
                        const active = piiFilter === kind;
                        return (
                          <button
                            key={kind}
                            type="button"
                            disabled={count === 0}
                            aria-pressed={active}
                            onClick={() => handleSelectPiiFilter(kind)}
                            className={`px-2.5 py-1 rounded-lg font-mono text-[10px] font-bold transition tabular-nums ${
                              count === 0
                                ? 'surface-subtle text-dim opacity-45 cursor-not-allowed'
                                : active
                                ? 'bg-[#86BC25] text-black cursor-pointer'
                                : `${PII_BADGE_CLASS[kind]} cursor-pointer hover:opacity-90`
                            }`}
                          >
                            [{kind}] ×{count}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="surface-card rounded-2xl p-4 text-xs text-main leading-7 whitespace-pre-wrap font-sans">
                    {content.doc.contenu_masque
                      ? renderHighlightedDoc(
                          content.doc.contenu_masque,
                          content.doc.extrait_quarantaine,
                          content.highlightQuote,
                          content.highlightLine
                        )
                      : 'Lancez l’analyse pour générer la vue masquée.'}
                  </div>
                </>
              )}
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
};
