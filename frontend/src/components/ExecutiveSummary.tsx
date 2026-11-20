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
import { ConcordanceRow, RibbonLegend, rankFindings } from './ConcordanceRibbon';
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
  critique: { label: 'Critique', cls: 'bg-[var(--rupture)] text-white' },
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

  // Sujet du chiffre-titre : affirmations du Dit (APRÈS) ou engagements de l'Écrit (AVANT, sans entretien).
  const ditBase = findings.filter((f) => Boolean(f.dit));
  const useDit = ditBase.length > 0;
  const ledeSubject = useDit
    ? { unit: 'affirmation', owner: 'de la DSI', base: ditBase.length }
    : {
        unit: 'exigence',
        owner: 'de la PSSI',
        base: findings.filter((f) => Boolean(f.ecrit)).length || total,
      };
  const contradictedList = (useDit ? ditBase : findings.filter((f) => Boolean(f.ecrit))).filter(
    (f) => f.statut === 'non_conforme' || f.statut === 'partiel'
  );
  const contradicted = contradictedList.length;
  const critiquesContredits = contradictedList.filter((f) => f.gravite === 'critique').length;

  const rankedFindings = rankFindings(findings).filter((f) => f.statut !== 'conforme');

  const fmt1 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const ledeFacts: { label: string; value: string; tone?: string }[] = [
    { label: 'Maturité NIS2', value: `${maturityScore} %`, tone: maturityScore < 40 ? 'text-[var(--rupture)]' : undefined },
    { label: 'Constats conformes', value: `${conformes} / ${total}` },
    { label: 'Citations vérifiées', value: `${verifiedQuotes} / ${total}` },
    { label: 'Pièces en quarantaine', value: `${quarDocs.length}`, tone: quarDocs.length > 0 ? 'text-[var(--warning-text)]' : undefined },
    { label: 'Effort de remédiation', value: `${fmt1(comexSimulation.workload_jh.estimated_jh)} j·h` },
    { label: 'Maturité visée à 90 jours', value: `${comexSimulation.projected_score} %`, tone: 'text-[var(--accent-text)]' },
  ];

  // Le décompte des indicateurs ne se joue qu'une fois par résultat d'audit (pas à chaque retour sur la vue).
  const revealKey = `${mode}:${total}:${nonConformes}:${maturityScore}:${verifiedQuotes}`;
  const [firstReveal] = useState(() => !playedKpiReveals.has(revealKey));
  useEffect(() => {
    playedKpiReveals.add(revealKey);
  }, [revealKey]);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      {/* CHIFFRE-TITRE ÉDITORIAL : la contradiction dite en une phrase, chiffres intégrés au texte */}
      <section aria-labelledby="cockpit-lede" className="pt-1 pb-6 border-b border-hairline">
        <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-5">
          <div className="min-w-0 max-w-4xl">
            <p className="text-sm text-sub">
              {synthesis.client || 'Centre Hospitalier de Valmont'} · Phase{' '}
              {mode === 'APRES' ? 'APRÈS' : 'AVANT'} entretiens · {total} constat{total > 1 ? 's' : ''}
            </p>
            <h2
              id="cockpit-lede"
              className="mt-2 text-[1.75rem] sm:text-[2.35rem] leading-[1.12] font-semibold tracking-[-0.025em] text-main"
            >
              <span className="text-[var(--rupture)] font-bold tabular-nums">
                <CountUp to={contradicted} from={firstReveal ? 0 : contradicted} duration={0.7} trigger="load" />
              </span>{' '}
              {ledeSubject.unit}
              {contradicted > 1 ? 's' : ''} {ledeSubject.owner} sur{' '}
              <span className="tabular-nums">{ledeSubject.base}</span>{' '}
              {contradicted > 1 ? 'sont contredites' : 'est contredite'} par la configuration réelle
              {critiquesContredits > 0 ? (
                <>
                  , dont{' '}
                  <span className="text-[var(--rupture)] font-bold tabular-nums">{critiquesContredits}</span> critique
                  {critiquesContredits > 1 ? 's' : ''}.
                </>
              ) : (
                '.'
              )}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {comparisonSummary && (
              <button
                type="button"
                onClick={onOpenComparator}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline hover:border-strong text-xs font-semibold text-main transition cursor-pointer"
              >
                <GitCompareArrows className="w-3.5 h-3.5" />
                <span className="tabular-nums">
                  AVANT {comparisonSummary.scoreAvant} % → APRÈS {comparisonSummary.scoreApres} %
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setDetailsDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline hover:border-strong text-xs font-semibold text-main transition cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>
                Piliers{mode === 'AVANT' && questionsCount > 0 ? ` et trame DSI (${questionsCount})` : ''}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setComexModeOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-[#0B100D] text-xs font-bold transition cursor-pointer"
            >
              <Presentation className="w-4 h-4" />
              <span>Présentation COMEX</span>
            </button>
          </div>
        </div>

        {/* Faits secondaires, séparés par des filets (pas de cartes) */}
        <dl className="mt-6 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 border-t border-hairline">
          {ledeFacts.map((fact) => (
            <div
              key={fact.label}
              className="pt-3 pr-4 pb-1 border-r border-hairline last:border-r-0 [&:nth-child(2n)]:max-sm:border-r-0 sm:[&:nth-child(3n)]:max-xl:border-r-0"
            >
              <dt className="text-xs text-sub">{fact.label}</dt>
              <dd className={`mt-1 text-xl font-semibold tabular-nums ${fact.tone || 'text-main'}`}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* RUPTURES PAR GRAVITÉ (rubans de concordance) + TROIS RISQUES À PORTER AU COMEX */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <section aria-labelledby="ruptures-title" className="xl:col-span-8 surface-panel rounded-2xl overflow-hidden">
          <header className="px-4 sm:px-5 pt-4 pb-3 border-b border-hairline flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 id="ruptures-title" className="text-base font-semibold text-main">
                Ruptures, par gravité
              </h3>
              <RibbonLegend className="mt-1.5" />
            </div>
            <button
              type="button"
              onClick={onOpenTriadView}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent-text)] hover:underline underline-offset-4 cursor-pointer"
            >
              <span>Tous les constats ({total})</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </header>
          {rankedFindings.length > 0 ? (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {rankedFindings.slice(0, 6).map((f) => (
                <ConcordanceRow key={f.id} finding={f} onOpen={onSelectFinding} />
              ))}
            </ul>
          ) : (
            <p className="px-5 py-8 text-sm text-sub">
              Aucune rupture : le Dit, l&apos;Écrit et le Réel concordent sur tous les constats.
            </p>
          )}
        </section>

        <section aria-labelledby="comex-risks-title" className="xl:col-span-4 surface-panel rounded-2xl p-5">
          <h3 id="comex-risks-title" className="text-base font-semibold text-main">
            Trois risques à porter au COMEX
          </h3>
          {synthesis.top_3_risques && synthesis.top_3_risques.length > 0 ? (
            <ol className="mt-3 space-y-3">
              {synthesis.top_3_risques.slice(0, 3).map((risk, idx) => (
                <li key={idx} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 text-sm leading-relaxed text-main">
                  <span className="font-semibold text-[var(--rupture)] tabular-nums">{idx + 1}.</span>
                  <span>{risk}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-sub">La synthèse ne remonte aucun risque prioritaire.</p>
          )}
        </section>
      </div>

      {/* GRAPHIQUES : RADAR DÉCLARÉ vs RÉEL + TOPOLOGIE CLOUD GCP */}
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
            <div className="flex items-start justify-between gap-3 pb-4 border-b border-hairline">
              <div>
                <h2 className="text-lg font-semibold text-main">Les cinq piliers NIS2</h2>
                <p className="mt-0.5 text-xs text-sub">
                  Score vérifié (barre) face au niveau déclaré par l&apos;établissement (repère bleu).
                </p>
              </div>
              <button
                type="button"
                aria-label="Fermer le tiroir des piliers"
                onClick={() => setDetailsDrawerOpen(false)}
                className="p-2 rounded-lg hover:bg-[var(--bg-hover)] text-sub hover:text-main transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 5 piliers : une ligne chacun, écart déclaré / vérifié lisible d'un coup d'œil */}
            <ul className="-mx-6 divide-y divide-[var(--border-subtle)] border-y border-hairline">
              {pillars.map((p, idx) => {
                const barColor = p.score >= 70 ? 'var(--reel)' : p.score >= 40 ? 'var(--warning-text)' : 'var(--rupture)';
                const gap = Math.max(0, p.declaredScore - p.score);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={!p.primaryFinding}
                      onClick={() => {
                        if (p.primaryFinding) {
                          setDetailsDrawerOpen(false);
                          onSelectFinding(p.primaryFinding);
                        }
                      }}
                      className="w-full text-left px-6 py-4 space-y-2 hover:bg-[var(--bg-hover)] disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-default"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="text-sm font-semibold text-main">
                          {p.title} <span className="font-normal text-sub">· {p.article}</span>
                        </span>
                        <span className="text-sm tabular-nums">
                          <span className="font-semibold" style={{ color: barColor }}>{p.score} %</span>
                          {gap > 0 && <span className="text-[var(--rupture)]"> · écart −{gap} pts</span>}
                        </span>
                      </div>
                      <p className="text-xs text-sub leading-relaxed">{p.summaryText}</p>
                      <div className="relative h-2 w-full rounded-full bg-[var(--bg-subtle)]">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${p.score}%` }}
                          transition={{ duration: 0.5, delay: idx * 0.04, ease: [0.16, 1, 0.3, 1] }}
                          className="h-full rounded-full"
                          style={{ backgroundColor: barColor }}
                        />
                        <span
                          aria-hidden="true"
                          title={`Déclaré : ${p.declaredScore} %`}
                          className="absolute -top-1 -bottom-1 w-0.5 rounded bg-[var(--dit)]"
                          style={{ left: `${p.declaredScore}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-sub">
                        <span>
                          {p.matchedCount} contrôle{p.matchedCount > 1 ? 's' : ''}
                          {p.contradiction ? ` · ${p.contradiction}` : ''}
                        </span>
                        <span className="tabular-nums">Déclaré {p.declaredScore} %</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Questions d'entretien DSI (Phase AVANT ou si présentes) */}
            {synthesis.questions_entretien &&
              synthesis.questions_entretien.length > 0 && (
                <div className="pt-4 border-t border-hairline space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <MessageCircleQuestion className="w-4 h-4 tone-warning" />
                      <h3 className="text-base font-semibold text-main">
                        Questions à poser à la DSI ({synthesis.questions_entretien.length})
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

      {/* MODE PRÉSENTATION COMEX : brief d'une page à l'échelle de la projection */}
      {comexModeOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Présentation au comité de direction"
          data-lenis-prevent
          className="fixed inset-0 z-50 overflow-y-auto bg-[var(--bg-canvas)] text-main"
        >
          <div className="max-w-[1320px] mx-auto px-6 py-8 lg:px-12 lg:py-12 space-y-10">
            <header className="flex flex-wrap items-start justify-between gap-6 pb-6 border-b border-hairline">
              <div className="min-w-0">
                <p className="text-base text-sub">
                  Présentation au comité de direction · {comexSimulation.art34_exposure.entity_category} · Phase{' '}
                  {mode === 'APRES' ? 'APRÈS' : 'AVANT'} entretiens
                </p>
                <h2 className="mt-1 text-3xl lg:text-4xl font-semibold tracking-[-0.025em] text-main">
                  {synthesis.client || 'Centre Hospitalier de Valmont'} — arbitrage NIS2
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setComexModeOpen(false)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-hairline hover:border-strong text-sm font-semibold text-main transition cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
                Quitter <kbd className="kbd-pill">Échap</kbd>
              </button>
            </header>

            <p className="max-w-5xl text-[2rem] lg:text-[3.1rem] leading-[1.08] font-semibold tracking-[-0.03em] text-main">
              <span className="text-[var(--rupture)] font-bold tabular-nums">{contradicted}</span> {ledeSubject.unit}
              {contradicted > 1 ? 's' : ''} {ledeSubject.owner} sur{' '}
              <span className="tabular-nums">{ledeSubject.base}</span>{' '}
              {contradicted > 1 ? 'sont contredites' : 'est contredite'} par la configuration réelle. Le plan à 90 jours
              porte la maturité de <span className="tabular-nums">{maturityScore} %</span> à{' '}
              <span className="text-[var(--accent-text)] font-bold tabular-nums">{comexSimulation.projected_score} %</span>.
            </p>

            <dl className="grid grid-cols-2 lg:grid-cols-4 border-t border-hairline">
              {[
                {
                  label: 'Maturité NIS2',
                  value: `${maturityScore} % → ${comexSimulation.projected_score} %`,
                  note: `${critiques} constat${critiques > 1 ? 's' : ''} critique${critiques > 1 ? 's' : ''}`,
                },
                {
                  label: 'Exposition aux sanctions (Art. 34)',
                  value: `Risque ${comexSimulation.art34_exposure.risk_level_before.toLowerCase()}`,
                  note: `${comexSimulation.art34_exposure.risk_level_after.toLowerCase()} après le plan · ${comexSimulation.art34_exposure.plafond_label}`,
                  tone: 'text-[var(--rupture)]',
                },
                {
                  label: 'Effort sur 90 jours',
                  value: `${fmt1(comexSimulation.workload_jh.estimated_jh)} j·h`,
                  note: `0–30 j : ${fmt1(comexSimulation.workload_jh.by_horizon['0_30'].estimated_jh)} · 30–60 j : ${fmt1(comexSimulation.workload_jh.by_horizon['30_60'].estimated_jh)} · 60–90 j : ${fmt1(comexSimulation.workload_jh.by_horizon['60_90'].estimated_jh)}`,
                },
                comparisonSummary
                  ? {
                      label: 'Effet des entretiens',
                      value: `${comparisonSummary.scoreAvant} % → ${comparisonSummary.scoreApres} %`,
                      note: `${comparisonSummary.ditContradictionsCount} déclaration${comparisonSummary.ditContradictionsCount > 1 ? 's' : ''} démentie${comparisonSummary.ditContradictionsCount > 1 ? 's' : ''}`,
                    }
                  : {
                      label: 'Preuves citées',
                      value: `${verifiedQuotes} / ${total}`,
                      note: `${arbitratedCount} / ${comexSimulation.actionable_findings} constats arbitrés`,
                    },
              ].map((fact, i) => (
                <div
                  key={fact.label}
                  className={`pt-4 pb-1 pr-5 ${i > 0 ? 'pl-5 border-l border-hairline' : ''} ${i === 2 ? 'max-lg:border-l-0 max-lg:pl-0' : ''}`}
                >
                  <dt className="text-sm text-sub">{fact.label}</dt>
                  <dd className={`mt-1 text-2xl font-semibold tabular-nums ${'tone' in fact && fact.tone ? fact.tone : 'text-main'}`}>
                    {fact.value}
                  </dd>
                  <dd className="mt-0.5 text-sm text-sub">{fact.note}</dd>
                </div>
              ))}
            </dl>

            <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
              <div className="xl:col-span-7 space-y-8">
                <section aria-labelledby="comex-risks">
                  <h3 id="comex-risks" className="text-xl font-semibold text-main">
                    Trois risques à arbitrer
                  </h3>
                  <ol className="mt-3 space-y-4">
                    {(synthesis.top_3_risques || []).slice(0, 3).map((risk, idx) => (
                      <li key={idx} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 text-base leading-relaxed text-main">
                        <span className="text-xl font-semibold text-[var(--rupture)] tabular-nums leading-snug">{idx + 1}.</span>
                        <span>{risk}</span>
                      </li>
                    ))}
                  </ol>
                </section>

                {rankedFindings.length > 0 && (
                  <section aria-labelledby="comex-contradictions">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <h3 id="comex-contradictions" className="text-xl font-semibold text-main">
                        Les contradictions qui fondent ces risques
                      </h3>
                      <RibbonLegend />
                    </div>
                    <ul className="mt-3 surface-panel rounded-2xl overflow-hidden divide-y divide-[var(--border-subtle)]">
                      {rankedFindings.slice(0, 4).map((f) => (
                        <ConcordanceRow
                          key={f.id}
                          finding={f}
                          onOpen={(finding) => {
                            setComexModeOpen(false);
                            onSelectFinding(finding);
                          }}
                          note={f.decision_grc?.decision ? `Arbitré : ${f.decision_grc.decision_label}` : undefined}
                        />
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              <div className="xl:col-span-5 space-y-8">
                <section aria-labelledby="comex-trajectory">
                  <h3 id="comex-trajectory" className="text-xl font-semibold text-main">
                    Trajectoire à 90 jours, par pilier
                  </h3>
                  <ul className="mt-4 space-y-4">
                    {comexSimulation.pillars.map((pl) => (
                      <li key={pl.id}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="text-main">{pl.title}</span>
                          <span className="tabular-nums shrink-0">
                            <span className="text-sub">{pl.current_score} %</span>{' '}
                            <span className="text-[var(--accent-text)] font-semibold">→ {pl.projected_score} %</span>
                          </span>
                        </div>
                        <div
                          className="mt-1.5 h-2 rounded-full bg-[var(--bg-subtle)] relative overflow-hidden"
                          role="img"
                          aria-label={`${pl.title} : ${pl.current_score} % aujourd'hui, ${pl.projected_score} % visé`}
                        >
                          <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--reel-soft)] border border-[var(--accent-border)]" style={{ width: `${pl.projected_score}%` }} />
                          <div
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{
                              width: `${pl.current_score}%`,
                              background: pl.current_score < 40 ? 'var(--rupture)' : pl.current_score < 70 ? 'var(--warning-text)' : 'var(--reel)',
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-sub">Barre pleine : aujourd&apos;hui · contour vert : visé à 90 jours.</p>
                </section>

                <section aria-labelledby="comex-decisions" className="rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-soft)] p-6">
                  <h3 id="comex-decisions" className="text-xl font-semibold text-main">
                    Décisions attendues du COMEX (Art. 20)
                  </h3>
                  <ul className="mt-3 space-y-3 text-base text-main leading-relaxed">
                    <li>
                      <strong className="font-semibold">Engager les gains rapides (0–30 jours)</strong> :{' '}
                      {comexSimulation.workload_jh.by_horizon['0_30'].count} action
                      {comexSimulation.workload_jh.by_horizon['0_30'].count > 1 ? 's' : ''},{' '}
                      {fmt1(comexSimulation.workload_jh.by_horizon['0_30'].estimated_jh)} j·h.
                    </li>
                    <li>
                      <strong className="font-semibold">Valider le plan à 90 jours</strong> : {comexSimulation.workload_jh.label},
                      maturité de {maturityScore} % à {comexSimulation.projected_score} %.
                    </li>
                    <li>
                      <strong className="font-semibold">Activer le double circuit de notification</strong> : ANSSI (24 h / 72 h)
                      et CNIL (72 h).
                    </li>
                  </ul>
                </section>
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};
