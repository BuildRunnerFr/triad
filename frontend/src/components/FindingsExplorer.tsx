import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useReactTable,
  type ExpandedState,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import {
  Search,
  LayoutGrid,
  Table2,
  MessageSquareQuote,
  FileText,
  Server,
  CheckCircle2,
  Zap,
  ArrowUpRight,
  Terminal,
  BookOpenCheck,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  ChevronDown,
  Download,
  Copy,
  Check,
  X,
  Scale,
  Triangle,
  Box,
  Loader2,
} from 'lucide-react';
import type {
  AuditMode,
  Finding,
  GraviteFinding,
  SanitizedDocument,
  StatutFinding,
  ThemeMode,
} from '../types';
import { GRAVITE_RANK, STATUT_RISK_RANK } from '../utils/auditMetrics';
import { GRC_DECISION_META } from '../utils/grcSimulation';
import { TriadTriangleViz } from './TriadTriangleViz';

const LazyCloud3DTopology = lazy(() => import('./Cloud3DTopology'));

interface FindingsExplorerProps {
  findings: Finding[];
  docs: SanitizedDocument[];
  mode: AuditMode;
  onSelectFinding: (finding: Finding) => void;
  onOpenQuoteInDoc: (sourceName: string, quote: string) => void;
}

type ExplorerTab = 'constats' | 'triangle' | 'topology';

const STATUS_META: Record<
  StatutFinding,
  { label: string; badge: string; border: string; dot: string }
> = {
  non_conforme: {
    label: 'Non conforme',
    badge: 'badge-critical',
    border: 'border-l-rose-500',
    dot: 'bg-rose-500',
  },
  partiel: {
    label: 'Partiel',
    badge: 'badge-warning',
    border: 'border-l-amber-500',
    dot: 'bg-amber-500',
  },
  conforme: {
    label: 'Conforme',
    badge: 'badge-success',
    border: 'border-l-[#86BC25]',
    dot: 'bg-[#86BC25]',
  },
  a_confirmer: {
    label: 'À confirmer',
    badge: 'surface-subtle text-sub border border-hairline',
    border: 'border-l-slate-400',
    dot: 'bg-slate-400',
  },
};

const GRAVITE_META: Record<GraviteFinding, { label: string; cls: string }> = {
  critique: { label: 'Critique', cls: 'bg-rose-600 text-white' },
  haute: { label: 'Haute', cls: 'badge-high' },
  moyenne: { label: 'Moyenne', cls: 'badge-warning' },
  faible: {
    label: 'Faible',
    cls: 'surface-subtle text-sub border border-hairline',
  },
};

function extractShortArticle(raw: string): string {
  const m = raw.match(/Art\.?\s*\d+(?:\s*§\s*\d+(?:\s*\([a-z]\))?)?/i);
  if (m) return m[0];
  return raw.length <= 26 ? raw : `${raw.slice(0, 24).trimEnd()}…`;
}

function useDocumentTheme(): ThemeMode {
  const [docTheme, setDocTheme] = useState<ThemeMode>(() => {
    if (typeof document === 'undefined') return 'dark';
    return document.documentElement.getAttribute('data-theme') === 'light'
      ? 'light'
      : 'dark';
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => {
      setDocTheme(
        root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
      );
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return docTheme;
}

const columnHelper = createColumnHelper<Finding>();

export const FindingsExplorer: React.FC<FindingsExplorerProps> = ({
  findings,
  mode,
  onSelectFinding,
  onOpenQuoteInDoc,
}) => {
  const docTheme = useDocumentTheme();
  const [activeTab, setActiveTab] = useState<ExplorerTab>('constats');
  const [listLayout, setListLayout] = useState<'cards' | 'table'>('cards');
  const [statusFilter, setStatusFilter] = useState<'ALL' | StatutFinding>('ALL');
  const [graviteFilter, setGraviteFilter] = useState<'ALL' | GraviteFinding>(
    'ALL'
  );
  const [onlyContradictions, setOnlyContradictions] = useState(false);
  const [onlyArbitrated, setOnlyArbitrated] = useState(false);
  const [query, setQuery] = useState('');
  const [focusedFinding, setFocusedFinding] = useState<Finding | null>(
    findings[0] || null
  );
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>(
    {}
  );
  const [copiedCardCmdId, setCopiedCardCmdId] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([
    { id: 'gravite', desc: true },
  ]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [copiedCommands, setCopiedCommands] = useState(false);

  useEffect(() => {
    setFocusedFinding(
      (prev) =>
        (prev ? findings.find((x) => x.id === prev.id) : null) ||
        findings[0] ||
        null
    );
    setRowSelection({});
    setExpanded({});
  }, [findings, mode]);

  const counts = useMemo(
    () => ({
      ALL: findings.length,
      non_conforme: findings.filter((f) => f.statut === 'non_conforme').length,
      partiel: findings.filter((f) => f.statut === 'partiel').length,
      conforme: findings.filter((f) => f.statut === 'conforme').length,
      a_confirmer: findings.filter((f) => f.statut === 'a_confirmer').length,
    }),
    [findings]
  );

  const arbitratedCount = useMemo(
    () => findings.filter((f) => Boolean(f.decision_grc)).length,
    [findings]
  );

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      findings.filter((f) => {
        if (statusFilter !== 'ALL' && f.statut !== statusFilter) return false;
        if (graviteFilter !== 'ALL' && f.gravite !== graviteFilter) return false;
        if (onlyContradictions && !f.contradiction) return false;
        if (onlyArbitrated && !f.decision_grc) return false;
        if (!normalizedQuery) return true;
        return JSON.stringify(f).toLowerCase().includes(normalizedQuery);
      }),
    [
      findings,
      statusFilter,
      graviteFilter,
      onlyContradictions,
      onlyArbitrated,
      normalizedQuery,
    ]
  );

  const sortedCards = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const rankDiff =
        (GRAVITE_RANK[b.gravite] || 0) - (GRAVITE_RANK[a.gravite] || 0);
      if (rankDiff !== 0) return rankDiff;
      return (
        (STATUT_RISK_RANK[b.statut] || 0) - (STATUT_RISK_RANK[a.statut] || 0)
      );
    });
  }, [filtered]);

  const hasActiveFilters =
    statusFilter !== 'ALL' ||
    graviteFilter !== 'ALL' ||
    onlyContradictions ||
    onlyArbitrated ||
    Boolean(normalizedQuery);

  const resetFilters = () => {
    setStatusFilter('ALL');
    setGraviteFilter('ALL');
    setOnlyContradictions(false);
    setOnlyArbitrated(false);
    setQuery('');
  };

  const toggleCardProof = (id: string) => {
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copySingleCommand = (id: string, cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCardCmdId(id);
    window.setTimeout(() => setCopiedCardCmdId(null), 1800);
  };

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Tout sélectionner"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
            className="accent-[#86BC25] rounded cursor-pointer"
          />
        ),
        cell: ({ row }) => (
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5"
          >
            <input
              type="checkbox"
              aria-label={`Sélectionner ${row.original.id}`}
              checked={row.getIsSelected()}
              onChange={row.getToggleSelectedHandler()}
              className="accent-[#86BC25] rounded cursor-pointer"
            />
            <button
              type="button"
              aria-label="Déplier les preuves"
              onClick={row.getToggleExpandedHandler()}
              className="p-0.5 rounded surface-subtle text-dim hover:text-main cursor-pointer"
            >
              {row.getIsExpanded() ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        ),
        size: 56,
      }),
      columnHelper.accessor('id', {
        header: 'Constat & Article',
        cell: (info) => {
          const f = info.row.original;
          const dec = f.decision_grc;
          const decMeta = dec ? GRC_DECISION_META[dec.decision] : null;
          return (
            <div className="min-w-[200px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-[#86BC25] text-black shrink-0">
                  {f.id}
                </span>
                <span className="font-bold text-main text-xs">{f.theme}</span>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded surface-subtle text-sub">
                  {extractShortArticle(f.exigence_nis2)}
                </span>
                {dec && decMeta && (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.2 rounded-full text-[10px] font-extrabold ${decMeta.badgeCls}`}
                  >
                    <Scale className="w-2.5 h-2.5" />
                    <span>{decMeta.shortLabel}</span>
                  </span>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('gravite', {
        header: 'Gravité',
        sortingFn: (rowA, rowB) =>
          (GRAVITE_RANK[rowA.original.gravite] || 0) -
          (GRAVITE_RANK[rowB.original.gravite] || 0),
        cell: (info) => {
          const g = GRAVITE_META[info.getValue()] || GRAVITE_META.moyenne;
          return (
            <span
              className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide whitespace-nowrap ${g.cls}`}
            >
              {g.label}
            </span>
          );
        },
      }),
      columnHelper.accessor('statut', {
        header: 'Statut',
        sortingFn: (rowA, rowB) =>
          (STATUT_RISK_RANK[rowA.original.statut] || 0) -
          (STATUT_RISK_RANK[rowB.original.statut] || 0),
        cell: (info) => {
          const meta = STATUS_META[info.getValue()] || STATUS_META.a_confirmer;
          return (
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${meta.badge}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
              <span>{meta.label}</span>
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => row.contradiction || '', {
        id: 'contradiction',
        header: 'Triangulation',
        cell: (info) => {
          const f = info.row.original;
          return f.contradiction ? (
            <span className="badge-critical inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-extrabold whitespace-nowrap">
              <Zap className="w-3 h-3" />
              <span>{f.contradiction}</span>
            </span>
          ) : (
            <span className="badge-success inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap">
              <CheckCircle2 className="w-3 h-3" />
              <span>Aligné</span>
            </span>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectFinding(row.original);
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-subtle hover:border-[#86BC25]/60 text-[11px] font-bold text-accent transition cursor-pointer whitespace-nowrap"
          >
            <span>Inspecter</span>
            <ArrowUpRight className="w-3 h-3" />
          </button>
        ),
      }),
    ],
    [onSelectFinding]
  );

  const table = useReactTable({
    data: filtered,
    columns,
    getRowId: (row) => row.id,
    state: {
      sorting,
      expanded,
      rowSelection,
    },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);

  const exportFindingsCsv = (rowsToExport: Finding[]) => {
    const headers = [
      'ID',
      'Theme',
      'Exigence_NIS2',
      'Statut',
      'Gravite',
      'Contradiction',
      'Dit',
      'Ecrit',
      'Reel',
      'Ressource_GCP',
      'Recommandation',
    ];
    const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const lines = [
      headers.join(';'),
      ...rowsToExport.map((f) =>
        [
          f.id,
          f.theme,
          f.exigence_nis2,
          f.statut,
          f.gravite,
          f.contradiction || 'Aligné',
          f.dit?.extrait || '',
          f.ecrit?.extrait || '',
          f.reel?.constat || '',
          f.reel?.ressource || '',
          f.recommandation,
        ]
          .map(escapeCsv)
          .join(';')
      ),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Matrice_TRIAD_${mode}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copySelectedCommands = () => {
    const cmds = selectedRows
      .map((f) => f.commande_correction)
      .filter((c): c is string => Boolean(c));
    if (!cmds.length) return;
    navigator.clipboard.writeText(cmds.join('\n'));
    setCopiedCommands(true);
    setTimeout(() => setCopiedCommands(false), 1800);
  };

  const renderEvidenceBlock = (f: Finding) => (
    <div
      onClick={(e) => e.stopPropagation()}
      className="space-y-3 pt-3 border-t border-hairline"
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* 1. LE DIT */}
        <div className="surface-subtle rounded-xl p-3 flex flex-col justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider tone-info">
              <MessageSquareQuote className="w-3.5 h-3.5" />
              <span>Le Dit (Entretien)</span>
            </div>
            {f.dit ? (
              <p className="text-xs text-main italic leading-relaxed">
                « {f.dit.extrait} »
              </p>
            ) : (
              <p className="text-xs text-dim">
                {mode === 'AVANT' ? 'Phase AVANT entretien' : 'Non évoqué'}
              </p>
            )}
          </div>
          {f.dit && (
            <button
              type="button"
              onClick={() => onOpenQuoteInDoc(f.dit!.source, f.dit!.extrait)}
              className="self-start inline-flex items-center gap-1 text-[10px] font-mono tone-info hover:underline cursor-pointer"
            >
              <BookOpenCheck className="w-3 h-3" />
              <span>{f.dit.source}</span>
            </button>
          )}
        </div>

        {/* 2. L'ÉCRIT */}
        <div className="surface-subtle rounded-xl p-3 flex flex-col justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider tone-violet">
              <FileText className="w-3.5 h-3.5" />
              <span>L&apos;Écrit (Corpus)</span>
            </div>
            {f.ecrit ? (
              <p className="text-xs text-main leading-relaxed">
                « {f.ecrit.extrait} »
              </p>
            ) : (
              <p className="text-xs text-dim">Non documenté</p>
            )}
          </div>
          {f.ecrit && (
            <button
              type="button"
              onClick={() =>
                onOpenQuoteInDoc(f.ecrit!.source, f.ecrit!.extrait)
              }
              className="self-start inline-flex items-center gap-1 text-[10px] font-mono tone-violet hover:underline cursor-pointer"
            >
              <BookOpenCheck className="w-3 h-3" />
              <span>
                {f.ecrit.source}
                {f.ecrit.section && f.ecrit.section !== 'N/A'
                  ? ` (${f.ecrit.section})`
                  : ''}
              </span>
            </button>
          )}
        </div>

        {/* 3. LE RÉEL */}
        <div className="surface-subtle rounded-xl p-3 flex flex-col justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider text-accent">
              <Server className="w-3.5 h-3.5" />
              <span>Le Réel (Cloud GCP)</span>
            </div>
            <p className="text-xs text-main font-medium leading-relaxed">
              {f.reel ? f.reel.constat : 'Contrôle organisationnel hors sonde'}
            </p>
          </div>
          {f.reel?.ressource && (
            <div className="text-[10px] font-mono text-dim truncate">
              {f.reel.ressource}
            </div>
          )}
        </div>
      </div>

      {/* Commande gcloud à la demande */}
      {f.commande_correction && (
        <div className="rounded-xl px-3.5 py-2.5 surface-subtle border border-hairline flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Terminal className="w-3.5 h-3.5 text-accent shrink-0" />
            <code className="font-mono text-[11px] text-main overflow-x-auto whitespace-nowrap">
              {f.commande_correction}
            </code>
          </div>
          <button
            type="button"
            onClick={() => copySingleCommand(f.id, f.commande_correction!)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-card text-[11px] font-bold text-sub hover:text-main transition cursor-pointer shrink-0"
          >
            {copiedCardCmdId === f.id ? (
              <>
                <Check className="w-3 h-3 text-accent" />
                <span>Copié ✓</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copier gcloud</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-4"
    >
      {/* Barre d'outils épurée (zéro paragraphe superflu) */}
      <div className="surface-panel rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Sélecteur de vue principal : Constats | Triangle | Topologie 3D */}
          <div
            role="tablist"
            aria-label="Sélecteur de vue de l'explorateur"
            className="flex flex-wrap items-center gap-1 p-1 rounded-xl surface-subtle"
          >
            {(
              [
                ['constats', 'Constats', LayoutGrid],
                ['triangle', 'Triangle', Triangle],
                ['topology', 'Topologie 3D', Box],
              ] as const
            ).map(([key, label, Icon]) => {
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
                  role="tab"
                  type="button"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(key)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-extrabold transition cursor-pointer ${
                    isActive
                      ? 'bg-[#86BC25] text-black shadow-xs'
                      : 'text-sub hover:text-main'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                  {key === 'constats' && (
                    <span
                      className={`font-mono text-[10px] px-1.5 rounded-full tabular-nums ${
                        isActive
                          ? 'bg-black/15 text-black'
                          : 'surface-card text-sub'
                      }`}
                    >
                      {filtered.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Recherche compacte + bascule Cartes/Tableau + CSV */}
          <div className="flex flex-wrap items-center gap-2 flex-1 sm:flex-initial justify-end">
            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-dim absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Rechercher un constat"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="F-001, SSH, bucket, Art. 23…"
                className="w-full pl-8 pr-7 py-1.5 text-xs surface-card rounded-xl text-main placeholder:text-dim focus:outline-none focus:border-[#86BC25] transition"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Effacer la recherche"
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dim hover:text-main cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {activeTab === 'constats' && (
              <div
                role="group"
                aria-label="Affichage Cartes ou Tableau"
                className="inline-flex surface-subtle p-0.5 rounded-xl"
              >
                <button
                  type="button"
                  aria-pressed={listLayout === 'cards'}
                  onClick={() => setListLayout('cards')}
                  className={`p-1.5 rounded-lg transition cursor-pointer ${
                    listLayout === 'cards'
                      ? 'bg-[#86BC25] text-black'
                      : 'text-sub hover:text-main'
                  }`}
                  title="Vue Cartes"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  aria-pressed={listLayout === 'table'}
                  onClick={() => setListLayout('table')}
                  className={`p-1.5 rounded-lg transition cursor-pointer ${
                    listLayout === 'table'
                      ? 'bg-[#86BC25] text-black'
                      : 'text-sub hover:text-main'
                  }`}
                  title="Vue Tableau"
                >
                  <Table2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => exportFindingsCsv(filtered)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl surface-card text-xs font-semibold text-sub hover:text-main transition cursor-pointer"
              title="Exporter en CSV"
            >
              <Download className="w-3.5 h-3.5 text-accent" />
              <span>CSV</span>
            </button>
          </div>
        </div>

        {/* Pastilles compactes de filtre Statut & Gravité */}
        {activeTab !== 'topology' && (
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-hairline">
            {(
              [
                ['ALL', 'Tous'],
                ['non_conforme', 'Non conformes'],
                ['partiel', 'Partiels'],
                ['conforme', 'Conformes'],
                ...(counts.a_confirmer > 0
                  ? ([['a_confirmer', 'À confirmer']] as const)
                  : []),
              ] as const
            ).map(([key, label]) => {
              const active = statusFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStatusFilter(key)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                    active
                      ? 'bg-[#86BC25] text-black'
                      : 'surface-card text-sub hover:text-main'
                  }`}
                >
                  <span>{label}</span>
                  <span
                    className={`text-[10px] px-1.5 rounded-full tabular-nums ${
                      active
                        ? 'bg-black/20 text-black'
                        : 'surface-subtle text-sub'
                    }`}
                  >
                    {counts[key]}
                  </span>
                </button>
              );
            })}

            <span className="h-4 w-px bg-[var(--border-subtle)] mx-0.5 hidden sm:inline-block" />

            {(
              [
                ['critique', 'Critique'],
                ['haute', 'Haute'],
                ['moyenne', 'Moyenne'],
                ['faible', 'Faible'],
              ] as const
            ).map(([gKey, gLabel]) => {
              const active = graviteFilter === gKey;
              return (
                <button
                  key={gKey}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setGraviteFilter((prev) => (prev === gKey ? 'ALL' : gKey))
                  }
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                    active
                      ? GRAVITE_META[gKey].cls
                      : 'surface-subtle text-sub hover:text-main'
                  }`}
                >
                  {gLabel}
                </button>
              );
            })}

            <button
              type="button"
              aria-pressed={onlyContradictions}
              onClick={() => setOnlyContradictions(!onlyContradictions)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                onlyContradictions
                  ? 'badge-critical'
                  : 'surface-card text-sub hover:text-main'
              }`}
            >
              <Zap className="w-3 h-3" />
              <span>Ruptures</span>
            </button>

            {arbitratedCount > 0 && (
              <button
                type="button"
                aria-pressed={onlyArbitrated}
                onClick={() => setOnlyArbitrated(!onlyArbitrated)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                  onlyArbitrated
                    ? 'bg-[#86BC25] text-black'
                    : 'surface-card text-sub hover:text-main'
                }`}
              >
                <Scale className="w-3 h-3" />
                <span>Arbitrés ({arbitratedCount})</span>
              </button>
            )}

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold text-dim hover:text-main cursor-pointer"
              >
                <X className="w-3 h-3" />
                <span>Réinitialiser</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* VUE 2 : TRIANGLE INTERACTIF */}
      {activeTab === 'triangle' && (
        <TriadTriangleViz
          findings={filtered.length > 0 ? filtered : findings}
          selectedFinding={focusedFinding}
          mode={mode}
          onSelectFinding={setFocusedFinding}
          onInspectFinding={onSelectFinding}
        />
      )}

      {/* VUE 3 : TOPOLOGIE 3D PLEIN FOCUS */}
      {activeTab === 'topology' && (
        <div className="surface-panel rounded-2xl p-3">
          <Suspense
            fallback={
              <div className="h-[350px] rounded-xl surface-card flex items-center justify-center gap-2 text-xs text-sub">
                <Loader2 className="w-4 h-4 animate-spin text-accent" />
                <span>Chargement de la scène 3D WebGL…</span>
              </div>
            }
          >
            <LazyCloud3DTopology
              findings={findings}
              proof={null}
              theme={docTheme}
              onSelectFinding={onSelectFinding}
            />
          </Suspense>
        </div>
      )}

      {/* VUE 1 : CONSTATS (CARTES CONDENSÉES OU TABLEAU) */}
      {activeTab === 'constats' && (
        <>
          {selectedRows.length > 0 && listLayout === 'table' && (
            <div className="rounded-xl px-4 py-2.5 badge-success flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs font-bold">
                {selectedRows.length} constat(s) sélectionné(s)
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {selectedRows.some((r) => r.commande_correction) && (
                  <button
                    type="button"
                    onClick={copySelectedCommands}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg surface-panel text-xs font-bold text-main cursor-pointer"
                  >
                    {copiedCommands ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-accent" />
                        <span>Copié ✓</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copier gcloud</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => exportFindingsCsv(selectedRows)}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg surface-panel text-xs font-bold text-main cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Exporter (.csv)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRowSelection({})}
                  className="text-xs underline px-2 cursor-pointer"
                >
                  Désélectionner
                </button>
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="surface-panel rounded-2xl py-10 text-center space-y-2">
              <p className="text-xs text-sub font-semibold">
                Aucun constat ne correspond aux filtres actifs.
              </p>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-xs font-bold text-accent hover:underline cursor-pointer"
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          ) : listLayout === 'cards' ? (
            /* Cartes Constat épurées : 1 coup d'œil + accordéon Preuves Dit / Écrit / Réel */
            <div className="space-y-3">
              {sortedCards.map((f) => {
                const meta = STATUS_META[f.statut] || STATUS_META.a_confirmer;
                const grav = GRAVITE_META[f.gravite] || GRAVITE_META.moyenne;
                const isCardOpen = Boolean(expandedCards[f.id]);
                const summaryLine = f.reel?.constat || f.recommandation;

                return (
                  <article
                    key={f.id}
                    onMouseEnter={() => setFocusedFinding(f)}
                    className={`rounded-2xl surface-panel border-l-4 ${meta.border} p-4 space-y-3 transition`}
                  >
                    {/* Ligne 1 : ID, titre court, article NIS2 + badges statut / gravité / arbitrage GRC */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="font-mono text-xs font-extrabold px-2 py-0.5 rounded-md bg-[#86BC25] text-black shrink-0">
                          {f.id}
                        </span>
                        <h3 className="text-sm font-extrabold text-main">
                          {f.theme}
                        </h3>
                        <span
                          title={f.exigence_nis2}
                          className="font-mono text-[10px] font-bold px-2 py-0.5 rounded surface-subtle text-sub"
                        >
                          {extractShortArticle(f.exigence_nis2)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {f.decision_grc && (
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                              GRC_DECISION_META[f.decision_grc.decision]
                                ?.badgeCls || 'badge-info'
                            }`}
                            title={
                              [
                                f.decision_grc.decision_label,
                                f.decision_grc.porteur,
                                f.decision_grc.echeance,
                              ]
                                .filter(Boolean)
                                .join(' • ')
                            }
                          >
                            <Scale className="w-3 h-3" />
                            <span>
                              {GRC_DECISION_META[f.decision_grc.decision]
                                ?.shortLabel || f.decision_grc.decision_label}
                            </span>
                          </span>
                        )}
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide ${grav.cls}`}
                        >
                          {grav.label}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold ${meta.badge}`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${meta.dot}`}
                          />
                          <span>{meta.label}</span>
                        </span>
                      </div>
                    </div>

                    {/* Ligne 2 : 1 ligne de synthèse/contradiction + Accordéon Preuves + Inspecter */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {f.contradiction ? (
                          <span className="badge-critical inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0">
                            <Zap className="w-3 h-3" />
                            <span>{f.contradiction}</span>
                          </span>
                        ) : (
                          <span className="badge-success inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Aligné</span>
                          </span>
                        )}
                        <p className="text-xs text-sub line-clamp-1 min-w-0">
                          {summaryLine}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          aria-expanded={isCardOpen}
                          onClick={() => toggleCardProof(f.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-sub hover:text-main transition cursor-pointer"
                        >
                          <span>Preuves Dit / Écrit / Réel</span>
                          <ChevronDown
                            className={`w-3.5 h-3.5 transition-transform ${
                              isCardOpen ? 'rotate-180 text-accent' : ''
                            }`}
                          />
                        </button>

                        <button
                          type="button"
                          onClick={() => onSelectFinding(f)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#86BC25] hover:bg-[#96cf2e] text-black text-xs font-extrabold transition cursor-pointer"
                        >
                          <span>Inspecter</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Accordéon dépliable : 3 colonnes Dit / Écrit / Réel + commande gcloud */}
                    {isCardOpen && renderEvidenceBlock(f)}
                  </article>
                );
              })}
            </div>
          ) : (
            /* Vue Tableau compacte (@tanstack/react-table) */
            <div className="surface-panel rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="surface-subtle border-b border-hairline text-[10px] uppercase tracking-wider text-sub select-none">
                    {table.getHeaderGroups().map((hg) => (
                      <tr key={hg.id}>
                        {hg.headers.map((header) => {
                          const canSort = header.column.getCanSort();
                          const sorted = header.column.getIsSorted();
                          return (
                            <th
                              key={header.id}
                              onClick={
                                canSort
                                  ? header.column.getToggleSortingHandler()
                                  : undefined
                              }
                              className={`py-2.5 px-3.5 font-bold ${
                                canSort ? 'cursor-pointer hover:text-main' : ''
                              }`}
                            >
                              <div className="inline-flex items-center gap-1">
                                {header.isPlaceholder
                                  ? null
                                  : flexRender(
                                      header.column.columnDef.header,
                                      header.getContext()
                                    )}
                                {canSort && (
                                  <span className="text-dim">
                                    {sorted === 'asc' ? (
                                      <ArrowUp className="w-3 h-3 text-accent" />
                                    ) : sorted === 'desc' ? (
                                      <ArrowDown className="w-3 h-3 text-accent" />
                                    ) : (
                                      <ArrowUpDown className="w-3 h-3 opacity-50" />
                                    )}
                                  </span>
                                )}
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    ))}
                  </thead>

                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {table.getRowModel().rows.map((row) => {
                      const f = row.original;
                      const meta =
                        STATUS_META[f.statut] || STATUS_META.a_confirmer;
                      const isFocused = focusedFinding?.id === f.id;

                      return (
                        <React.Fragment key={row.id}>
                          <tr
                            onMouseEnter={() => setFocusedFinding(f)}
                            onClick={() => {
                              setFocusedFinding(f);
                              onSelectFinding(f);
                            }}
                            className={`row-interactive cursor-pointer border-l-4 ${meta.border} ${
                              isFocused ? 'bg-[var(--accent-soft)]/30' : ''
                            }`}
                          >
                            {row.getVisibleCells().map((cell) => (
                              <td key={cell.id} className="py-2.5 px-3.5 align-middle">
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext()
                                )}
                              </td>
                            ))}
                          </tr>

                          {row.getIsExpanded() && (
                            <tr className="surface-card">
                              <td
                                colSpan={row.getVisibleCells().length}
                                className="px-4 pb-4 border-l-4 border-l-[#86BC25]"
                              >
                                {renderEvidenceBlock(f)}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </motion.div>
  );
};
