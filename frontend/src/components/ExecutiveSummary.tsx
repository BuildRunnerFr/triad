import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  ShieldAlert,
  Quote,
  FileLock2,
  MessageCircleQuestion,
  Copy,
  Check,
  ArrowRight,
  GitCompareArrows,
  Zap,
  SlidersHorizontal,
  ArrowUpRight,
  Presentation,
  X,
  Scale,
  Clock,
  TrendingUp,
  CheckCircle2,
  ChevronDown,
} from 'lucide-react';
import type {
  AuditMode,
  AuditorProof,
  AuditSynthesis,
  Finding,
  GraviteFinding,
  ThemeMode,
} from '../types';
import {
  computeMaturityScore,
  GRAVITE_RANK,
  type AuditComparisonSummary,
} from '../utils/auditMetrics';
import {
  computeLocalRemediationSimulation,
  GRC_DECISION_META,
} from '../utils/grcSimulation';
import { Nis2RadarChart } from './Nis2RadarChart';
import CountUp from './reactbits/CountUp';
import SpotlightCard from './reactbits/SpotlightCard';
import { CloudTopologyViz } from './CloudTopologyViz';
import { Nis2CoverageMatrix } from './Nis2CoverageMatrix';
import type { ToastTone } from './ToastStack';

interface ExecutiveSummaryProps {
  synthesis: AuditSynthesis;
  mode: AuditMode;
  sessionId?: string;
  theme: ThemeMode;
  elapsedSeconds: number | null;
  proof: AuditorProof | null;
  comparisonSummary: AuditComparisonSummary | null;
  onSelectFinding: (finding: Finding) => void;
  onInspectFindingInExplorer?: (finding: Finding) => void;
  onOpenTriadView: () => void;
  onOpenComparator: () => void;
  onNotify?: (title: string, detail?: string, tone?: ToastTone) => void;
}

interface Nis2PillarBreakdown {
  id: string;
  title: string;
  article: string;
  score: number;
  declaredScore: number;
  worstGravite: GraviteFinding | 'conforme';
  contradiction: string | null;
  summaryText: string;
  primaryFinding: Finding | null;
  matchedCount: number;
}

const GRAVITE_PILL: Record<
  GraviteFinding | 'conforme',
  { label: string; cls: string }
> = {
  critique: { label: 'Critique', cls: 'bg-rose-600 text-white' },
  haute: { label: 'Haute', cls: 'badge-high' },
  moyenne: { label: 'Moyenne', cls: 'badge-warning' },
  faible: {
    label: 'Faible',
    cls: 'surface-subtle text-sub border border-hairline',
  },
  conforme: { label: 'Conforme ✓', cls: 'badge-success' },
};

/** Résultats d'audit dont les indicateurs ont déjà été animés pendant la session. */
const playedKpiReveals = new Set<string>();

export const ExecutiveSummary: React.FC<ExecutiveSummaryProps> = ({
  synthesis,
  mode,
  sessionId,
  theme,
  elapsedSeconds,
  proof,
  comparisonSummary,
  onSelectFinding,
  onInspectFindingInExplorer,
  onOpenTriadView,
  onOpenComparator,
  onNotify,
}) => {
  const [copiedQuestions, setCopiedQuestions] = useState(false);
  const [comexModeOpen, setComexModeOpen] = useState(false);
  const [detailsDrawerOpen, setDetailsDrawerOpen] = useState(false);
  const [expandedRiskIdx, setExpandedRiskIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!comexModeOpen && !detailsDrawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (comexModeOpen) setComexModeOpen(false);
        else setDetailsDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [comexModeOpen, detailsDrawerOpen]);

  const findings = synthesis.findings || [];
  const total = findings.length;
  const nonConformes = findings.filter((f) => f.statut === 'non_conforme').length;
  const critiques = findings.filter((f) => f.gravite === 'critique').length;
  const partiels = findings.filter((f) => f.statut === 'partiel').length;
  const conformes = findings.filter((f) => f.statut === 'conforme').length;
  const verifiedQuotes = findings.filter((f) => f.citation_verifiee).length;

  const cleanDocs = synthesis.documents_nettoyes || [];
  const quarDocs = synthesis.documents_quarantaine || [];
  const totalRedactions = [...cleanDocs, ...quarDocs].reduce((acc, doc) => {
    const counts = Object.values(doc.masquages || {});
    return acc + counts.reduce((s, n) => s + n, 0);
  }, 0);

  const maturityScore = computeMaturityScore(findings);

  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference - (maturityScore / 100) * circumference;

  const pillars = useMemo<Nis2PillarBreakdown[]>(() => {
    const scoreSingle = (f: Finding): number => {
      if (f.statut === 'conforme') return 94;
      if (f.statut === 'partiel') return 55;
      if (f.statut === 'a_confirmer') return 42;
      return f.gravite === 'critique' ? 14 : 26;
    };

    const buildPillar = (
      id: string,
      title: string,
      article: string,
      declaredScore: number,
      fallbackScore: number,
      predicate: (f: Finding) => boolean,
      fallbackSummary: string
    ): Nis2PillarBreakdown => {
      const matched = findings.filter(predicate);
      if (matched.length === 0) {
        return {
          id,
          title,
          article,
          score: fallbackScore,
          declaredScore,
          worstGravite: fallbackScore >= 70 ? 'conforme' : 'moyenne',
          contradiction: null,
          summaryText: fallbackSummary,
          primaryFinding: null,
          matchedCount: 0,
        };
      }

      const avg = Math.round(
        matched.reduce((acc, f) => acc + scoreSingle(f), 0) / matched.length
      );
      const sortedByRisk = [...matched].sort((a, b) => {
        if (a.statut === 'conforme' && b.statut !== 'conforme') return 1;
        if (b.statut === 'conforme' && a.statut !== 'conforme') return -1;
        return (GRAVITE_RANK[b.gravite] || 0) - (GRAVITE_RANK[a.gravite] || 0);
      });
      const primary = sortedByRisk[0];
      const allCompliant = matched.every((f) => f.statut === 'conforme');

      return {
        id,
        title,
        article,
        score: avg,
        declaredScore,
        worstGravite: allCompliant ? 'conforme' : primary.gravite,
        contradiction:
          matched.find((m) => Boolean(m.contradiction))?.contradiction || null,
        summaryText:
          primary.reel?.constat || primary.recommandation || fallbackSummary,
        primaryFinding: primary,
        matchedCount: matched.length,
      };
    };

    return [
      buildPillar(
        'data-exposure',
        'Cloisonnement Données Santé',
        'Art. 21 §2 (i)',
        95,
        20,
        (f) =>
          /radiologie|exposition des données|public|allusers/i.test(
            `${f.theme} ${f.reel?.ressource || ''}`
          ),
        'Exposition des buckets Cloud Storage.'
      ),
      buildPillar(
        'network-sec',
        'Sécurité Réseau & Bastion',
        'Art. 21 §2 (i)',
        90,
        20,
        (f) =>
          /ssh|pare-feu|réseau|firewall|bastion/i.test(
            `${f.theme} ${f.reel?.ressource || ''}`
          ),
        'Filtrage des ports d’administration.'
      ),
      buildPillar(
        'backup-pca',
        'Continuité & Sauvegardes WORM',
        'Art. 21 §2 (c)',
        92,
        50,
        (f) =>
          /sauvegarde|continuité|pacs|dpi|restauration|backup/i.test(
            `${f.theme} ${f.exigence_nis2} ${f.reel?.ressource || ''}`
          ),
        'Versionnement et verrouillage immuable.'
      ),
      buildPillar(
        'iam-crypto',
        'Gouvernance IAM & KMS',
        'Art. 21 §2 (h, i, j)',
        85,
        62,
        (f) =>
          /iam|kms|chiffrement|cryptographie|serviceaccount|privil|clé/i.test(
            `${f.theme} ${f.exigence_nis2} ${f.reel?.ressource || ''}`
          ) &&
          !/radiologie|ssh/i.test(`${f.theme} ${f.reel?.ressource || ''}`),
        'Moindre privilège et gestion des clés.'
      ),
      buildPillar(
        'incident-anssi',
        'Notification Incidents ANSSI',
        'Art. 23',
        86,
        mode === 'AVANT' ? 48 : 22,
        (f) =>
          /incident|notification|anssi|art\.\s*23/i.test(
            `${f.theme} ${f.exigence_nis2}`
          ),
        'Alerte 24 h / notification 72 h.'
      ),
    ];
  }, [findings, mode]);

  const copyQuestions = () => {
    if (!synthesis.questions_entretien?.length) return;
    const text = synthesis.questions_entretien
      .map((q, i) => `${i + 1}. ${q}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopiedQuestions(true);
    setTimeout(() => setCopiedQuestions(false), 1800);
  };

  const comexSimulation = useMemo(() => {
    const actionableIds = findings
      .filter((f) => f.statut !== 'conforme')
      .map((f) => f.id);
    return computeLocalRemediationSimulation(findings, actionableIds, mode);
  }, [findings, mode]);

  const topCriticalFindings = useMemo(() => {
    return [...findings]
      .filter((f) => f.statut !== 'conforme')
      .sort((a, b) => GRAVITE_RANK[b.gravite] - GRAVITE_RANK[a.gravite])
      .slice(0, 3);
  }, [findings]);

  const arbitratedCount = useMemo(
    () => findings.filter((f) => Boolean(f.decision_grc?.decision)).length,
    [findings]
  );

  const questionsCount = synthesis.questions_entretien?.length || 0;

  // Le décompte des indicateurs ne se joue qu'une fois par résultat d'audit (pas à chaque retour sur la vue).
  const revealKey = `${mode}:${total}:${nonConformes}:${maturityScore}:${verifiedQuotes}`;
  const [firstReveal] = useState(() => !playedKpiReveals.has(revealKey));
  useEffect(() => {
    playedKpiReveals.add(revealKey);
  }, [revealKey]);
  const kpiCardProps = {
    theme: theme === 'dark' ? ('dark' as const) : ('light' as const),
    spotlightColor: '#86BC25',
    intensity: theme === 'dark' ? 0.1 : 0.35,
    borderGlow: 0.5,
    spotlightSize: 220,
    style: {
      '--spotlight-card-surface': 'var(--bg-surface)',
      '--spotlight-card-border': 'var(--border-subtle)',
      '--spotlight-card-shadow': 'var(--shadow-panel)',
    } as React.CSSProperties,
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      {/* BARRE EXÉCUTIVE ÉPURÉE */}
      <div className="surface-panel rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--accent-soft)] text-accent text-[11px] font-extrabold">
            <Scale className="w-3.5 h-3.5" />
            <span>NIS2 Art. 20 &amp; 34</span>
          </span>

          <span className="font-mono text-xs px-2.5 py-1 rounded-full surface-subtle text-main font-bold tabular-nums">
            {comexSimulation.workload_jh.estimated_jh} j.h
          </span>

          <span className="font-mono text-xs px-2.5 py-1 rounded-full surface-subtle text-accent font-extrabold tabular-nums">
            Cible 90j : {comexSimulation.projected_score}% (+
            {comexSimulation.score_delta})
          </span>

          {comparisonSummary && (
            <button
              type="button"
              onClick={onOpenComparator}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full surface-card hover:border-[var(--deloitte)] text-[11px] font-bold text-main transition cursor-pointer"
            >
              <GitCompareArrows className="w-3.5 h-3.5 text-accent" />
              <span className="font-mono tabular-nums">
                {comparisonSummary.scoreAvant}% → {comparisonSummary.scoreApres}%
              </span>
              {comparisonSummary.ditContradictionsCount > 0 && (
                <span className="badge-critical px-1.5 py-0.2 rounded-full text-[10px] font-extrabold">
                  +{comparisonSummary.ditContradictionsCount} Dit
                </span>
              )}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDetailsDrawerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-bold text-main transition cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-accent" />
            <span>
              Détails{mode === 'AVANT' && questionsCount > 0 ? ` & Trame DSI (${questionsCount})` : ''}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setComexModeOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black text-xs font-extrabold shadow-sm transition cursor-pointer"
          >
            <Presentation className="w-4 h-4" />
            <span>Présentation COMEX</span>
          </button>
        </div>
      </div>

      {/* LIGNE 1 : 4 INDICATEURS (lueur React Bits SpotlightCard + décompte CountUp joué une fois par résultat) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        {/* KPI 1 : Maturité NIS2 */}
        <SpotlightCard {...kpiCardProps} className="rounded-2xl p-5 flex items-center gap-4">
          <div className="relative w-16 h-16 shrink-0 flex items-center justify-center">
            <svg className="w-16 h-16 -rotate-90" viewBox="0 0 68 68" aria-hidden="true">
              <circle
                cx="34"
                cy="34"
                r={radius}
                fill="none"
                stroke={theme === 'dark' ? 'rgba(255,255,255,0.08)' : '#E2E8F0'}
                strokeWidth="6"
              />
              <motion.circle
                cx="34"
                cy="34"
                r={radius}
                fill="none"
                stroke={
                  maturityScore >= 70
                    ? '#86BC25'
                    : maturityScore >= 40
                    ? '#F59E0B'
                    : '#F43F5E'
                }
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circumference}
                initial={{ strokeDashoffset: firstReveal ? circumference : strokeOffset }}
                animate={{ strokeDashoffset: strokeOffset }}
                transition={{ duration: 0.75, ease: [0.16, 1, 0.3, 1] }}
              />
            </svg>
            <span className="absolute text-sm font-extrabold tabular-nums text-main">
              <CountUp to={maturityScore} from={firstReveal ? 0 : maturityScore} duration={0.75} trigger="load" />%
            </span>
          </div>
          <div>
            <div className="text-xs font-semibold text-sub">Maturité NIS2</div>
            <div className="text-sm font-extrabold text-main mt-1 tabular-nums">
              {conformes}/{total} constats conformes
            </div>
            <div className="text-[11px] text-sub mt-0.5 tabular-nums">
              {partiels} partiel{partiels > 1 ? 's' : ''}
            </div>
          </div>
        </SpotlightCard>

        {/* KPI 2 : Écarts Non Conformes */}
        <SpotlightCard {...kpiCardProps} className="rounded-2xl p-5 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold text-sub">Écarts majeurs</div>
            <div className="flex items-baseline gap-2 mt-1.5">
              <span className="text-3xl font-extrabold tabular-nums tone-critical">
                <CountUp to={nonConformes} from={firstReveal ? 0 : nonConformes} duration={0.6} trigger="load" />
              </span>
              {critiques > 0 && (
                <span className="text-xs font-bold tabular-nums text-sub">
                  dont {critiques} critique{critiques > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="text-[11px] text-sub mt-1">Dit × Écrit × Réel</div>
          </div>
          <div className="w-10 h-10 rounded-xl badge-critical flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
        </SpotlightCard>

        {/* KPI 3 : Sas DLP Douanier */}
        <SpotlightCard {...kpiCardProps} className="rounded-2xl p-5 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold text-sub">Pièces en quarantaine</div>
            <div className="flex items-baseline gap-2 mt-1.5">
              <span className="text-3xl font-extrabold tabular-nums tone-warning">
                <CountUp to={quarDocs.length} from={firstReveal ? 0 : quarDocs.length} duration={0.6} trigger="load" />
              </span>
              <span className="text-xs font-semibold text-sub">
                pièce{quarDocs.length > 1 ? 's' : ''} isolée{quarDocs.length > 1 ? 's' : ''}
              </span>
            </div>
            <div className="text-[11px] text-sub mt-1 tabular-nums">
              {totalRedactions} donnée{totalRedactions > 1 ? 's' : ''} personnelle{totalRedactions > 1 ? 's' : ''} masquée{totalRedactions > 1 ? 's' : ''} (DLP)
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl badge-warning flex items-center justify-center shrink-0">
            <FileLock2 className="w-5 h-5" />
          </div>
        </SpotlightCard>

        {/* KPI 4 : Preuves Exactes */}
        <SpotlightCard {...kpiCardProps} className="rounded-2xl p-5 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold text-sub">Citations vérifiées mot à mot</div>
            <div className="flex items-baseline gap-2 mt-1.5">
              <span className="text-3xl font-extrabold tabular-nums tone-success">
                <CountUp to={verifiedQuotes} from={firstReveal ? 0 : verifiedQuotes} duration={0.6} trigger="load" />
                <span className="text-xl text-sub">/{total}</span>
              </span>
            </div>
            <div className="text-[11px] text-sub mt-1 tabular-nums">
              {arbitratedCount} arbitrage{arbitratedCount > 1 ? 's' : ''} GRC
              {elapsedSeconds
                ? ` • audit en ${elapsedSeconds.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
                : ''}
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl badge-success flex items-center justify-center shrink-0">
            <Quote className="w-5 h-5" />
          </div>
        </SpotlightCard>
      </div>

      {/* LIGNE 2 : GRAPHIQUES (RADAR NIS2 + TOPOLOGIE CLOUD GCP) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-5">
          <Nis2RadarChart findings={findings} theme={theme} />
        </div>
        <div className="xl:col-span-7">
          <CloudTopologyViz
            findings={findings}
            proof={proof}
            theme={theme}
            onSelectFinding={onSelectFinding}
            onNotify={onNotify}
          />
        </div>
      </div>

      {/* LIGNE 3 : TOP 3 RISQUES PRIORITAIRES (1 LIGNE CHACUN, DÉPLIABLE AU CLIC) */}
      {synthesis.top_3_risques && synthesis.top_3_risques.length > 0 && (
        <div className="surface-panel rounded-2xl p-5 edge-accent space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-accent" />
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-accent">
                Top 3 Risques Prioritaires
              </h3>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setDetailsDrawerOpen(true)}
                className="text-xs font-semibold text-sub hover:text-main transition cursor-pointer"
              >
                Détails piliers
              </button>
              <button
                type="button"
                onClick={onOpenTriadView}
                className="inline-flex items-center gap-1 text-xs font-bold text-accent hover:underline cursor-pointer"
              >
                <span>Constats ({total})</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {synthesis.top_3_risques.slice(0, 3).map((risk, idx) => {
              const isExpanded = expandedRiskIdx === idx;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() =>
                    setExpandedRiskIdx(isExpanded ? null : idx)
                  }
                  className="w-full text-left surface-card hover:border-strong rounded-xl px-3.5 py-2.5 flex items-start justify-between gap-3 transition cursor-pointer"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <span className="px-2 py-0.5 rounded-md bg-[var(--deloitte)] text-black font-mono font-extrabold text-[11px] shrink-0">
                      0{idx + 1}
                    </span>
                    <span
                      className={`text-xs text-main font-medium leading-relaxed ${
                        isExpanded ? '' : 'line-clamp-1'
                      }`}
                    >
                      {risk}
                    </span>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-dim shrink-0 mt-0.5 transition-transform ${
                      isExpanded ? 'rotate-180' : ''
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* LIGNE 4 : CONFORMITÉ MULTI-RÉFÉRENTIELS PAR SOUS-ONGLETS */}
      <Nis2CoverageMatrix
        mode={mode}
        sessionId={sessionId}
        findings={findings}
        docs={[...cleanDocs, ...quarDocs]}
        onInspectFindingInExplorer={
          onInspectFindingInExplorer || onSelectFinding
        }
      />

      {/* TIROIR COULISSANT « DÉTAILS PILIERS & TRAME DSI » */}
      {detailsDrawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Détails des 5 Piliers NIS2 et Trame DSI"
          className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-xs"
          onClick={() => setDetailsDrawerOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl h-full overflow-y-auto surface-panel border-l border-hairline p-6 space-y-6 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3 pb-4 border-b border-hairline">
              <div className="flex items-center gap-2.5">
                <SlidersHorizontal className="w-4 h-4 text-accent" />
                <h2 className="text-base font-extrabold text-main">
                  Ventilation des 5 Piliers NIS2
                </h2>
              </div>
              <button
                type="button"
                aria-label="Fermer le tiroir Détails"
                onClick={() => setDetailsDrawerOpen(false)}
                className="p-2 rounded-xl surface-card hover:border-[var(--deloitte)] text-sub hover:text-main transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 5 Piliers détaillés */}
            <div className="space-y-3">
              {pillars.map((p, idx) => {
                const gravMeta = GRAVITE_PILL[p.worstGravite];
                const barColor =
                  p.score >= 70
                    ? '#86BC25'
                    : p.score >= 40
                    ? '#F59E0B'
                    : '#F43F5E';

                return (
                  <div
                    key={p.id}
                    onClick={() => {
                      if (p.primaryFinding) {
                        setDetailsDrawerOpen(false);
                        onSelectFinding(p.primaryFinding);
                      }
                    }}
                    className={`surface-card rounded-xl p-4 space-y-2 transition ${
                      p.primaryFinding ? 'hover:border-strong cursor-pointer' : ''
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-extrabold text-main">
                          {p.title}
                        </span>
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded surface-subtle text-sub">
                          {p.article}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {p.contradiction && (
                          <span className="badge-critical inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold">
                            <Zap className="w-2.5 h-2.5" />
                            {p.contradiction}
                          </span>
                        )}
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${gravMeta.cls}`}
                        >
                          {gravMeta.label}
                        </span>
                        <span className="font-mono text-xs font-extrabold tabular-nums text-main pl-1">
                          {p.score}%
                        </span>
                        {p.primaryFinding && (
                          <ArrowUpRight className="w-3.5 h-3.5 text-accent" />
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-sub leading-relaxed">
                      {p.summaryText}
                    </p>

                    <div className="relative h-2 w-full rounded-full surface-subtle overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${p.score}%` }}
                        transition={{
                          duration: 0.55,
                          delay: idx * 0.04,
                          ease: 'easeOut',
                        }}
                        className="h-full rounded-full"
                        style={{ backgroundColor: barColor }}
                      />
                      <div
                        title={`Déclaré : ${p.declaredScore}%`}
                        className="absolute top-0 bottom-0 w-0.5 bg-sky-400/80"
                        style={{ left: `${p.declaredScore}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-dim font-mono">
                      <span>{p.matchedCount} contrôle(s)</span>
                      <span>
                        Déclaré {p.declaredScore}% • Écart -
                        {Math.max(0, p.declaredScore - p.score)} pts
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Questions d'entretien DSI (Phase AVANT ou si présentes) */}
            {synthesis.questions_entretien &&
              synthesis.questions_entretien.length > 0 && (
                <div className="pt-4 border-t border-hairline space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <MessageCircleQuestion className="w-4 h-4 tone-warning" />
                      <h3 className="text-xs font-extrabold uppercase tracking-wider tone-warning">
                        Questions Ciblées DSI ({synthesis.questions_entretien.length})
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={copyQuestions}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-main transition cursor-pointer"
                    >
                      {copiedQuestions ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-accent" />
                          <span>Copié</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copier la trame</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="space-y-2">
                    {synthesis.questions_entretien.map((q, idx) => (
                      <div
                        key={idx}
                        className="surface-card rounded-xl p-3 flex gap-2.5 items-start"
                      >
                        <span className="w-5 h-5 rounded-full badge-warning font-bold text-[11px] flex items-center justify-center shrink-0 mt-0.5">
                          {idx + 1}
                        </span>
                        <p className="text-xs text-main leading-relaxed">{q}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>
        </div>
      )}

      {/* VUE PLEIN ÉCRAN « MODE PRÉSENTATION COMEX » */}
      {comexModeOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mode Présentation COMEX — Soutenance Direction Générale NIS2"
          className="fixed inset-0 z-50 overflow-y-auto bg-[var(--bg-canvas)] text-main"
        >
          <div className="max-w-[1440px] mx-auto px-6 py-6 lg:px-10 lg:py-8 space-y-6">
            <header className="surface-panel rounded-2xl p-5 edge-accent flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-md bg-[var(--deloitte)] text-black text-[11px] font-extrabold uppercase tracking-wider">
                    Soutenance COMEX
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full surface-subtle text-[11px] font-mono font-bold text-main">
                    Phase {mode}
                  </span>
                  <span className="badge-critical px-2.5 py-0.5 rounded-full text-[11px] font-bold">
                    {comexSimulation.art34_exposure.entity_category}
                  </span>
                </div>
                <h2 className="text-2xl font-extrabold tracking-tight text-main">
                  {synthesis.client || 'Centre Hospitalier de Valmont'} — Arbitrage NIS2
                </h2>
              </div>

              <button
                type="button"
                onClick={() => setComexModeOpen(false)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-extrabold text-main transition cursor-pointer shrink-0"
              >
                <X className="w-4 h-4 text-accent" />
                <span>Quitter (Échap)</span>
              </button>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="surface-panel rounded-2xl p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold uppercase tracking-wider text-dim">
                    Maturité NIS2
                  </span>
                  <TrendingUp className="w-4 h-4 text-accent" />
                </div>
                <div className="flex items-baseline gap-2.5">
                  <span className="text-4xl font-extrabold font-mono tabular-nums text-main">
                    {maturityScore}%
                  </span>
                  <span className="text-sm font-mono font-extrabold text-accent">
                    → {comexSimulation.projected_score}% (+
                    {comexSimulation.score_delta})
                  </span>
                </div>
                <div className="text-xs text-sub">
                  {critiques} critique(s) • {nonConformes + partiels}/{total} à traiter
                </div>
              </div>

              <div className="surface-panel rounded-2xl p-5 space-y-2 border border-rose-500/25">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold uppercase tracking-wider tone-critical">
                    Exposition Art. 34
                  </span>
                  <Scale className="w-4 h-4 tone-critical" />
                </div>
                <div className="text-lg font-extrabold font-mono text-main">
                  {comexSimulation.art34_exposure.plafond_label}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="badge-critical px-2 py-0.5 rounded-full font-bold">
                    {comexSimulation.art34_exposure.risk_level_before}
                  </span>
                  <span className="text-dim">→</span>
                  <span className="badge-success px-2 py-0.5 rounded-full font-bold">
                    {comexSimulation.art34_exposure.risk_level_after} (-
                    {comexSimulation.art34_exposure.exposure_reduction_pct}%)
                  </span>
                </div>
              </div>

              <div className="surface-panel rounded-2xl p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold uppercase tracking-wider text-dim">
                    Charge 90 Jours
                  </span>
                  <Clock className="w-4 h-4 text-accent" />
                </div>
                <div className="text-3xl font-extrabold font-mono tabular-nums text-main">
                  {comexSimulation.workload_jh.estimated_jh} j.h
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-[11px] font-mono">
                  <div className="surface-subtle rounded-lg px-2 py-1">
                    <div className="text-dim text-[10px]">0–30j</div>
                    <div className="font-bold text-main">
                      {comexSimulation.workload_jh.by_horizon['0_30'].estimated_jh}
                    </div>
                  </div>
                  <div className="surface-subtle rounded-lg px-2 py-1">
                    <div className="text-dim text-[10px]">30–60j</div>
                    <div className="font-bold text-main">
                      {comexSimulation.workload_jh.by_horizon['30_60'].estimated_jh}
                    </div>
                  </div>
                  <div className="surface-subtle rounded-lg px-2 py-1">
                    <div className="text-dim text-[10px]">60–90j</div>
                    <div className="font-bold text-main">
                      {comexSimulation.workload_jh.by_horizon['60_90'].estimated_jh}
                    </div>
                  </div>
                </div>
              </div>

              <div className="surface-panel rounded-2xl p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold uppercase tracking-wider text-dim">
                    {comparisonSummary ? 'Delta AVANT → APRÈS' : 'Gouvernance'}
                  </span>
                  <GitCompareArrows className="w-4 h-4 text-accent" />
                </div>
                {comparisonSummary ? (
                  <>
                    <div className="text-2xl font-extrabold font-mono tabular-nums text-main">
                      {comparisonSummary.scoreAvant}% → {comparisonSummary.scoreApres}%
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="badge-critical px-2 py-0.5 rounded-full font-bold">
                        {comparisonSummary.ditContradictionsCount} rupture(s) Dit
                      </span>
                      <span className="badge-warning px-2 py-0.5 rounded-full font-bold">
                        +{comparisonSummary.newGapsCount} écart(s)
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-2xl font-extrabold font-mono tabular-nums text-main">
                      {verifiedQuotes}/{total} preuves
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="badge-success px-2 py-0.5 rounded-full font-bold">
                        {arbitratedCount}/{comexSimulation.actionable_findings} arbitrés
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              <div className="xl:col-span-7 space-y-4">
                <div className="surface-panel rounded-2xl p-5 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-extrabold uppercase tracking-wider text-main">
                      Top 3 Risques Prioritaires
                    </h3>
                    <span className="badge-critical px-2.5 py-0.5 rounded-full text-[11px] font-extrabold">
                      Priorité COMEX
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {(synthesis.top_3_risques || []).slice(0, 3).map((risk, idx) => (
                      <div
                        key={idx}
                        className="surface-card rounded-xl p-3.5 flex items-start gap-3 edge-accent"
                      >
                        <span className="px-2 py-0.5 rounded-lg bg-[var(--deloitte)] text-black font-mono font-extrabold text-xs shrink-0">
                          0{idx + 1}
                        </span>
                        <p className="text-xs text-main font-medium leading-relaxed">
                          {risk}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {topCriticalFindings.length > 0 && (
                  <div className="surface-panel rounded-2xl p-5 space-y-3">
                    <h3 className="text-xs font-extrabold uppercase tracking-wider text-dim">
                      Contradictions Majeures
                    </h3>
                    <div className="space-y-2">
                      {topCriticalFindings.map((f) => {
                        const grcMeta = f.decision_grc?.decision
                          ? GRC_DECISION_META[f.decision_grc.decision]
                          : null;
                        return (
                          <div
                            key={f.id}
                            onClick={() => {
                              setComexModeOpen(false);
                              onSelectFinding(f);
                            }}
                            className="surface-card hover:border-[var(--deloitte)] rounded-xl p-3 transition cursor-pointer space-y-1"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-extrabold text-accent">
                                  {f.id}
                                </span>
                                <span className="text-xs font-extrabold text-main">
                                  {f.theme}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {grcMeta && (
                                  <span
                                    className={`${grcMeta.badgeCls} px-2 py-0.5 rounded-full text-[10px] font-bold`}
                                  >
                                    {grcMeta.shortLabel}
                                  </span>
                                )}
                                <span
                                  className={`${
                                    GRAVITE_PILL[f.gravite].cls
                                  } px-2 py-0.5 rounded-full text-[10px] font-bold`}
                                >
                                  {GRAVITE_PILL[f.gravite].label}
                                </span>
                              </div>
                            </div>
                            <p className="text-xs text-sub line-clamp-2">
                              {f.contradiction || f.recommandation}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="xl:col-span-5 space-y-4">
                <div className="surface-panel rounded-2xl p-5 space-y-3.5">
                  <h3 className="text-xs font-extrabold uppercase tracking-wider text-main">
                    Trajectoire 90 Jours par Pilier
                  </h3>

                  <div className="space-y-3">
                    {comexSimulation.pillars.map((p) => (
                      <div key={p.id} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-main truncate pr-2">
                            {p.title}
                          </span>
                          <span className="font-mono font-extrabold tabular-nums shrink-0">
                            <span className="text-sub">{p.current_score}%</span>{' '}
                            <span className="text-accent">
                              → {p.projected_score}%
                            </span>
                          </span>
                        </div>
                        <div className="h-2 rounded-full surface-subtle overflow-hidden relative">
                          <div
                            className="h-full bg-[var(--deloitte)]/35 rounded-full"
                            style={{ width: `${p.projected_score}%` }}
                          />
                          <div
                            className="h-full bg-[var(--deloitte)] rounded-full absolute inset-y-0 left-0"
                            style={{ width: `${p.current_score}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="surface-panel rounded-2xl p-5 border border-[var(--deloitte)]/35 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                    <h3 className="text-xs font-extrabold uppercase tracking-wider text-main">
                      Décisions COMEX (Art. 20)
                    </h3>
                  </div>
                  <ul className="space-y-2 text-xs text-sub">
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)] mt-1.5 shrink-0" />
                      <span>
                        <strong className="text-main">Quick-Wins (0–30j) :</strong>{' '}
                        {comexSimulation.workload_jh.by_horizon['0_30'].count} action(s) (
                        {comexSimulation.workload_jh.by_horizon['0_30'].estimated_jh} j.h).
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)] mt-1.5 shrink-0" />
                      <span>
                        <strong className="text-main">Plan 90j :</strong>{' '}
                        {comexSimulation.workload_jh.label} ({maturityScore}% →{' '}
                        {comexSimulation.projected_score}%).
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)] mt-1.5 shrink-0" />
                      <span>
                        <strong className="text-main">Double guichet :</strong>{' '}
                        circuit ANSSI 24h/72h &amp; CNIL 72h.
                      </span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};
