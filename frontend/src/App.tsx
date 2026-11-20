import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MotionConfig } from 'framer-motion';
import {
  Play,
  RotateCcw,
  ShieldAlert,
  CheckCircle2,
  FileText,
  Lock,
  Loader2,
  Zap,
  X,
  Sun,
  Moon,
  Compass,
  LayoutDashboard,
  Triangle,
  ShieldCheck,
  GitCompareArrows,
  Search,
  ChevronRight,
  Minimize2,
  Maximize2,
} from 'lucide-react';
import type {
  AuditLogEntry,
  AuditMode,
  AuditorProof,
  AuditSynthesis,
  DrawerContent,
  FindingDecisionPatchPayload,
  NavSection,
  SanitizedDocument,
  SessionSummary,
  StatusResponse,
  ThemeMode,
} from './types';
import {
  DEFAULT_SESSION_ID,
  apiFetch,
  buildStreamUrl,
  createMissionSessionId,
  deletePersistedSession,
  exportSessionSnapshot,
  extractRetryAfterSeconds,
  fetchSessionsList,
  getEffectiveSessionId,
  importSessionSnapshot,
  patchFindingGrcDecision,
  setActiveSessionIdInUrl,
  setGlobalRateLimitListener,
} from './api';
import { compareSyntheses } from './utils/auditMetrics';
import { UiTooltip, UiTooltipProvider } from './components/UiTooltip';
import { KeyboardShortcutsDialog } from './components/KeyboardShortcutsDialog';
import { MissionLaunchpad } from './components/MissionLaunchpad';
import type { DeliverablesSubTab } from './components/SecurityAndDeliverablesView';
import { LiveExecutionOverlay } from './components/LiveExecutionOverlay';
import {
  ToastStack,
  type ToastItem,
  type ToastTone,
} from './components/ToastStack';

const loadExecutiveSummary = () =>
  import('./components/ExecutiveSummary').then((m) => ({
    default: m.ExecutiveSummary,
  }));
const loadFindingsExplorer = () =>
  import('./components/FindingsExplorer').then((m) => ({
    default: m.FindingsExplorer,
  }));
const loadComparatorView = () =>
  import('./components/ComparatorView').then((m) => ({
    default: m.ComparatorView,
  }));
const loadSecurityAndDeliverablesView = () =>
  import('./components/SecurityAndDeliverablesView').then((m) => ({
    default: m.SecurityAndDeliverablesView,
  }));
const loadInspectorDrawer = () =>
  import('./components/InspectorDrawer').then((m) => ({
    default: m.InspectorDrawer,
  }));
const loadCommandPalette = () =>
  import('./components/CommandPalette').then((m) => ({
    default: m.CommandPalette,
  }));

const LazyExecutiveSummary = lazy(loadExecutiveSummary);
const LazyFindingsExplorer = lazy(loadFindingsExplorer);
const LazyComparatorView = lazy(loadComparatorView);
const LazySecurityAndDeliverablesView = lazy(loadSecurityAndDeliverablesView);
const LazyInspectorDrawer = lazy(loadInspectorDrawer);
const LazyCommandPalette = lazy(loadCommandPalette);
/** Défilement fluide Lenis chargé après le premier rendu (hors budget du bundle initial). */
const LazySmoothScroll = lazy(() => import('./motion/SmoothScroll'));

const ViewSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Chargement de la vue"
    className="space-y-5 animate-pulse"
  >
    <div className="surface-panel rounded-2xl h-12" />
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <div className="surface-panel rounded-2xl h-24" />
      <div className="surface-panel rounded-2xl h-24" />
      <div className="surface-panel rounded-2xl h-24" />
      <div className="surface-panel rounded-2xl h-24" />
    </div>
    <div className="surface-panel rounded-2xl h-80" />
  </div>
);

type DensityMode = 'comfort' | 'compact';
const DENSITY_STORAGE_KEY = 'triad_ui_density';

function readStoredDensity(): DensityMode {
  try {
    const raw = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    return raw === 'compact' ? 'compact' : 'comfort';
  } catch {
    return 'comfort';
  }
}

const THEME_STORAGE_KEY = 'triad.theme';

/** Thème clair par défaut (usage en salle de réunion et projection COMEX) ; préférence persistée. */
function readStoredTheme(): ThemeMode {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export const App: React.FC = () => {
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);
  const [density, setDensity] = useState<DensityMode>(readStoredDensity);
  const [activeNav, setActiveNav] = useState<NavSection>('mission');
  const [deliverablesSubTab, setDeliverablesSubTab] =
    useState<DeliverablesSubTab | null>(null);
  const [mode, setMode] = useState<AuditMode>('APRES');
  const [useCache, setUseCache] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [sequenceLabel, setSequenceLabel] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hasOpenedPalette, setHasOpenedPalette] = useState(false);
  const [hasOpenedDrawer, setHasOpenedDrawer] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (title: string, detail?: string, tone: ToastTone = 'success') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-2), { id, title, detail, tone }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3800);
    },
    []
  );

  const [statusData, setStatusData] = useState<StatusResponse | null>(null);
  const [synthesesByMode, setSynthesesByMode] = useState<
    Partial<Record<AuditMode, AuditSynthesis>>
  >({});
  const [timingsByMode, setTimingsByMode] = useState<
    Partial<Record<AuditMode, Record<string, number>>>
  >({});
  const [sessionId, setSessionId] = useState<string>(() =>
    getEffectiveSessionId()
  );
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [proof, setProof] = useState<AuditorProof | null>(null);
  const [drawer, setDrawer] = useState<DrawerContent>(null);

  // États temps réel SSE pendant l'analyse
  const [liveStatuses, setLiveStatuses] = useState<Record<string, string>>({});
  const [liveEntries, setLiveEntries] = useState<AuditLogEntry[]>([]);

  // Contenus débloqués après validation humaine
  const [reportMarkdown, setReportMarkdown] = useState('');
  const [mailText, setMailText] = useState('');
  const [anssiDraftMarkdown, setAnssiDraftMarkdown] = useState('');
  const [comexBriefMarkdown, setComexBriefMarkdown] = useState('');
  const [terraformHcl, setTerraformHcl] = useState('');
  const [interviewGuideMarkdown, setInterviewGuideMarkdown] = useState('');
  const [riskRegisterMarkdown, setRiskRegisterMarkdown] = useState('');
  const [cnilDraftMarkdown, setCnilDraftMarkdown] = useState('');

  const modeRef = useRef<AuditMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* stockage indisponible : préférence non persistée */
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
    } catch {
      // Ignorer en navigation privée stricte
    }
  }, [density]);

  // Gestion globale propre du limiteur anti-abus HTTP 429 avec délai Retry-After
  const lastRateLimitToastRef = useRef<number>(0);
  const notifyRateLimited = useCallback(
    (retryAfterSeconds: number | null) => {
      const now = Date.now();
      if (now - lastRateLimitToastRef.current < 1500) return;
      lastRateLimitToastRef.current = now;
      const delayMsg = retryAfterSeconds
        ? `Protection anti-abus active — réessayez dans ${retryAfterSeconds} s (Retry-After).`
        : 'Protection anti-abus active — veuillez patienter quelques secondes avant de relancer.';
      pushToast('Limite de requêtes atteinte (HTTP 429)', delayMsg, 'warning');
    },
    [pushToast]
  );

  useEffect(() => {
    setGlobalRateLimitListener(notifyRateLimited);
    return () => setGlobalRateLimitListener(null);
  }, [notifyRateLimited]);

  const fetchDeliverables = useCallback(async (targetMode: AuditMode) => {
    const [
      repRes,
      mailRes,
      anssiRes,
      comexRes,
      tfRes,
      guideRes,
      grcRes,
      cnilRes,
    ] = await Promise.all([
      apiFetch(`/api/export/report?mode=${targetMode}`),
      apiFetch(`/api/export/mail?mode=${targetMode}`),
      apiFetch(`/api/export/anssi-draft?mode=${targetMode}`),
      apiFetch(`/api/export/comex-brief?mode=${targetMode}`),
      apiFetch(`/api/export/terraform?mode=${targetMode}`),
      apiFetch(`/api/export/interview-guide?mode=${targetMode}`),
      apiFetch(`/api/export/risk-register?mode=${targetMode}`),
      apiFetch(`/api/export/cnil-draft?mode=${targetMode}`),
    ]);
    if (repRes.ok) {
      setReportMarkdown(await repRes.text());
    }
    if (mailRes.ok) {
      setMailText(await mailRes.text());
    }
    if (anssiRes.ok) {
      setAnssiDraftMarkdown(await anssiRes.text());
    }
    if (comexRes.ok) {
      setComexBriefMarkdown(await comexRes.text());
    }
    if (tfRes.ok) {
      setTerraformHcl(await tfRes.text());
    }
    if (guideRes.ok) {
      setInterviewGuideMarkdown(await guideRes.text());
    }
    if (grcRes.ok) {
      setRiskRegisterMarkdown(await grcRes.text());
    }
    if (cnilRes.ok) {
      setCnilDraftMarkdown(await cnilRes.text());
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const list = await fetchSessionsList();
    setSessions(list);
  }, []);

  const syncOtherModeIfReady = useCallback(
    async (otherMode: AuditMode) => {
      const res = await apiFetch(`/api/status?mode=${otherMode}`);
      if (!res.ok) return;
      const otherData: StatusResponse = await res.json();
      if (otherData.synthesis) {
        setSynthesesByMode((prev) => ({
          ...prev,
          [otherMode]: otherData.synthesis!,
        }));
      }
      if (otherData.timings_ms) {
        setTimingsByMode((prev) => ({
          ...prev,
          [otherMode]: otherData.timings_ms!,
        }));
      }
    },
    []
  );

  const fetchStatus = useCallback(
    async (targetMode?: AuditMode) => {
      const m = targetMode || modeRef.current;
      const res = await apiFetch(`/api/status?mode=${m}`);
      if (res.ok) {
        const data: StatusResponse = await res.json();
        setStatusData(data);
        setLiveStatuses(data.agent_statuses || {});
        setTimingsByMode((prev) => {
          const next = { ...prev };
          if (data.timings_by_mode?.AVANT) {
            next.AVANT = data.timings_by_mode.AVANT;
          }
          if (data.timings_by_mode?.APRES) {
            next.APRES = data.timings_by_mode.APRES;
          }
          if (data.timings_ms) {
            next[m] = data.timings_ms;
          }
          return next;
        });
        if (data.syntheses_by_mode) {
          setSynthesesByMode((prev) => {
            const next = { ...prev };
            if (data.syntheses_by_mode?.AVANT) {
              next.AVANT = data.syntheses_by_mode.AVANT;
            }
            if (data.syntheses_by_mode?.APRES) {
              next.APRES = data.syntheses_by_mode.APRES;
            }
            return next;
          });
          const otherMode: AuditMode = m === 'AVANT' ? 'APRES' : 'AVANT';
          if (data.modes_ready?.[otherMode] && !data.timings_by_mode?.[otherMode]) {
            syncOtherModeIfReady(otherMode);
          }
        } else {
          if (data.synthesis) {
            setSynthesesByMode((prev) => ({ ...prev, [m]: data.synthesis! }));
          }
          const otherMode: AuditMode = m === 'AVANT' ? 'APRES' : 'AVANT';
          if (data.modes_ready?.[otherMode]) {
            syncOtherModeIfReady(otherMode);
          }
        }
        if (data.validated) {
          fetchDeliverables(m);
        } else {
          setReportMarkdown('');
          setMailText('');
          setAnssiDraftMarkdown('');
          setComexBriefMarkdown('');
          setTerraformHcl('');
          setInterviewGuideMarkdown('');
          setRiskRegisterMarkdown('');
          setCnilDraftMarkdown('');
        }
        return data;
      }
      return null;
    },
    [fetchDeliverables, syncOtherModeIfReady]
  );

  // Chargement initial, synchronisation par session et flux Server-Sent Events (SSE)
  useEffect(() => {
    apiFetch('/api/gcp/auditor-proof')
      .then((r) => r.json())
      .then(setProof)
      .catch(() => null);

    refreshSessions();

    fetchStatus('APRES').then((initial) => {
      if (initial?.synthesis) {
        setMode('APRES');
        setActiveNav('cockpit');
      } else if (initial?.modes_ready?.AVANT) {
        setMode('AVANT');
        fetchStatus('AVANT').then((av) => {
          if (av?.synthesis) setActiveNav('cockpit');
        });
      } else {
        setActiveNav('mission');
      }
    });

    const es = new EventSource(buildStreamUrl('/api/audit/stream'));
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.type === 'run_start') {
          setLiveEntries([]);
        } else if (payload.type === 'agent_status' && payload.agent_statuses) {
          setLiveStatuses(payload.agent_statuses);
        } else if (payload.type === 'audit_entry' && payload.entry) {
          setLiveEntries((prev) => [...prev, payload.entry]);
        } else if (
          payload.type === 'run_complete' &&
          payload.timings_ms &&
          (payload.mode === 'AVANT' || payload.mode === 'APRES')
        ) {
          const doneMode: AuditMode = payload.mode;
          setTimingsByMode((prev) => ({
            ...prev,
            [doneMode]: payload.timings_ms,
          }));
        }
      } catch {
        // Ignorer les trames keepalive
      }
    };
    return () => es.close();
  }, [fetchStatus, refreshSessions, sessionId]);

  // Synchronisation avec les boutons Précédent / Suivant du navigateur (?session_id=...)
  useEffect(() => {
    const onPopState = () => {
      const nextId = getEffectiveSessionId();
      setSessionId((prev) => {
        if (prev === nextId) return prev;
        setDrawer(null);
        setStatusData(null);
        setSynthesesByMode({});
        setTimingsByMode({});
        setReportMarkdown('');
        setMailText('');
        setAnssiDraftMarkdown('');
        setComexBriefMarkdown('');
        setTerraformHcl('');
        setInterviewGuideMarkdown('');
        setRiskRegisterMarkdown('');
        setCnilDraftMarkdown('');
        return nextId;
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleSelectSession = useCallback(
    (targetSessionId: string, opts?: { created?: boolean }) => {
      const normalized = setActiveSessionIdInUrl(targetSessionId);
      if (normalized === sessionId && !opts?.created) return;

      setDrawer(null);
      setStatusData(null);
      setSynthesesByMode({});
      setTimingsByMode({});
      setReportMarkdown('');
      setMailText('');
      setAnssiDraftMarkdown('');
      setComexBriefMarkdown('');
      setTerraformHcl('');
      setInterviewGuideMarkdown('');
      setRiskRegisterMarkdown('');
      setCnilDraftMarkdown('');
      setLiveEntries([]);
      setLiveStatuses({});
      setSessionId(normalized);

      if (opts?.created) {
        pushToast(
          "Nouvelle session d'audit ouverte",
          `Espace isolé ?session_id=${normalized} — la démo CH de Valmont reste intacte`,
          'success'
        );
      } else if (normalized === DEFAULT_SESSION_ID) {
        pushToast(
          'Session principale sélectionnée',
          'Dossier de référence Centre Hospitalier de Valmont restauré',
          'info'
        );
      } else {
        pushToast(
          'Session chargée',
          `Bascule vers l'espace d'audit ${normalized}`,
          'info'
        );
      }
    },
    [pushToast, sessionId]
  );

  const handleCreateNewSession = useCallback(() => {
    const freshId = createMissionSessionId();
    handleSelectSession(freshId, { created: true });
  }, [handleSelectSession]);

  const handleDeleteSession = useCallback(
    async (targetSessionId: string) => {
      if (targetSessionId === DEFAULT_SESSION_ID) return;
      await deletePersistedSession(targetSessionId);
      if (targetSessionId === sessionId) {
        const fallback = setActiveSessionIdInUrl(DEFAULT_SESSION_ID);
        setDrawer(null);
        setStatusData(null);
        setSynthesesByMode({});
        setTimingsByMode({});
        setReportMarkdown('');
        setMailText('');
        setAnssiDraftMarkdown('');
        setComexBriefMarkdown('');
        setTerraformHcl('');
        setInterviewGuideMarkdown('');
        setRiskRegisterMarkdown('');
        setCnilDraftMarkdown('');
        setSessionId(fallback);
      }
      await refreshSessions();
      pushToast(
        'Session secondaire supprimée',
        `L'espace ${targetSessionId} a été retiré sans impacter la démo Valmont`,
        'info'
      );
    },
    [pushToast, refreshSessions, sessionId]
  );

  const handleExportSession = useCallback(
    async (targetSessionId: string): Promise<boolean> => {
      const outcome = await exportSessionSnapshot(targetSessionId);
      if (!outcome.ok) {
        if (outcome.status !== 429) {
          pushToast("Échec de l'export de session", outcome.detail, 'critical');
        }
        return false;
      }

      const blob = new Blob([outcome.jsonText], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      pushToast(
        'Snapshot de session exporté',
        `${outcome.filename} • État complet et chaîne SHA-256 scellée`,
        'success'
      );
      return true;
    },
    [pushToast]
  );

  const handleImportSession = useCallback(
    async (
      file: File
    ): Promise<{ ok: boolean; status?: number; detail?: string }> => {
      const outcome = await importSessionSnapshot(file);
      if (!outcome.ok) {
        if (outcome.status !== 429) {
          pushToast(
            outcome.status === 400
              ? 'Import refusé (HTTP 400)'
              : "Échec de l'import de session",
            outcome.detail,
            'critical'
          );
        }
        return {
          ok: false,
          status: outcome.status,
          detail: outcome.detail,
        };
      }

      const restoredId = outcome.sessionId;
      const restoredMode: AuditMode =
        outcome.data.mode === 'AVANT' || outcome.data.mode === 'APRES'
          ? outcome.data.mode
          : outcome.data.modes_ready?.APRES
          ? 'APRES'
          : outcome.data.modes_ready?.AVANT
          ? 'AVANT'
          : modeRef.current;

      const normalized = setActiveSessionIdInUrl(restoredId);
      const sameSession = normalized === sessionId;

      setDrawer(null);
      setStatusData(null);
      setSynthesesByMode({});
      setTimingsByMode({});
      setReportMarkdown('');
      setMailText('');
      setAnssiDraftMarkdown('');
      setComexBriefMarkdown('');
      setTerraformHcl('');
      setInterviewGuideMarkdown('');
      setRiskRegisterMarkdown('');
      setCnilDraftMarkdown('');
      setLiveEntries([]);
      setLiveStatuses({});
      setMode(restoredMode);
      setSessionId(normalized);

      await refreshSessions();

      if (sameSession) {
        const refreshed = await fetchStatus(restoredMode);
        if (refreshed?.synthesis) {
          setActiveNav('cockpit');
        }
      }

      pushToast(
        'Session restaurée et vérifiée SHA-256',
        `Session ${normalized} (${outcome.data.nb_entrees ?? 0} bloc(s) authentifié(s)) chargée`,
        'success'
      );
      return { ok: true };
    },
    [fetchStatus, pushToast, refreshSessions, sessionId]
  );

  const handleModeChange = async (nextMode: AuditMode) => {
    setMode(nextMode);
    const updated = await fetchStatus(nextMode);
    if (!updated?.synthesis && (activeNav === 'cockpit' || activeNav === 'triad')) {
      setActiveNav('mission');
    }
  };

  const handleLoadDemo = async () => {
    await apiFetch('/api/demo/load', { method: 'POST' });
    setSynthesesByMode({});
    setTimingsByMode({});
    const loaded = await fetchStatus(mode);
    await refreshSessions();
    pushToast(
      'Dossier CH de Valmont chargé',
      `${loaded?.files?.length || 4} pièces prêtes pour l'inspection DLP du Douanier`,
      'success'
    );
  };

  const handleUploadFiles = async (files: FileList) => {
    const fd = new FormData();
    const count = files.length;
    Array.from(files).forEach((f) => fd.append('files', f));
    const res = await apiFetch('/api/upload', { method: 'POST', body: fd });
    if (res.status === 429) {
      notifyRateLimited(extractRetryAfterSeconds(res));
      return;
    }
    if (!res.ok) {
      let detail = `Le dépôt a été refusé par le serveur (HTTP ${res.status}).`;
      try {
        const errJson = await res.json();
        if (typeof errJson?.detail === 'string') detail = errJson.detail;
      } catch {
        // Conserver le détail générique
      }
      pushToast("Dépôt refusé par le sas d'entrée", detail, 'critical');
      return;
    }
    setSynthesesByMode({});
    setTimingsByMode({});
    await fetchStatus(mode);
    await refreshSessions();
    pushToast(
      'Pièces ajoutées au dossier',
      `${count} fichier(s) transmis au sas d'entrée`,
      'success'
    );
  };

  const handleReset = async () => {
    await apiFetch('/api/reset', { method: 'POST' });
    setDrawer(null);
    setSynthesesByMode({});
    setTimingsByMode({});
    setReportMarkdown('');
    setMailText('');
    setAnssiDraftMarkdown('');
    setComexBriefMarkdown('');
    setTerraformHcl('');
    setInterviewGuideMarkdown('');
    setRiskRegisterMarkdown('');
    setCnilDraftMarkdown('');
    setActiveNav('mission');
    await fetchStatus(mode);
    await refreshSessions();
    pushToast(
      'Session réinitialisée',
      'Registre SHA-256 et livrables remis à zéro',
      'info'
    );
  };

  const playCachedSequenceIfEnabled = async () => {
    if (!useCache) return;
    const steps: Array<Record<string, string>> = [
      {
        Douanier: 'terminé',
        AnalysteConformite: 'en_cours',
        ContreAuditeur: 'en_attente',
        GardeDuCorps: 'en_attente',
      },
      {
        Douanier: 'terminé',
        AnalysteConformite: 'terminé',
        ContreAuditeur: 'en_cours',
        GardeDuCorps: 'en_attente',
      },
      {
        Douanier: 'terminé',
        AnalysteConformite: 'terminé',
        ContreAuditeur: 'terminé',
        GardeDuCorps: 'en_cours',
      },
    ];
    for (const st of steps) {
      await new Promise((r) => setTimeout(r, 340));
      setLiveStatuses(st);
    }
  };

  const executeSingleMode = async (
    targetMode: AuditMode,
    destNav: NavSection = 'cockpit'
  ) => {
    setMode(targetMode);
    setIsRunning(true);
    setSequenceLabel(null);
    setLiveEntries([]);
    setLiveStatuses({
      Douanier: 'en_cours',
      AnalysteConformite: 'en_attente',
      ContreAuditeur: 'en_attente',
      GardeDuCorps: 'en_attente',
    });

    const pollId = window.setInterval(() => {
      fetchStatus(targetMode);
    }, 1100);

    try {
      const runPromise = apiFetch('/api/audit/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: targetMode,
          use_cache: useCache ? true : null,
        }),
      });
      await playCachedSequenceIfEnabled();
      const runRes = await runPromise;
      if (runRes.status === 429) {
        notifyRateLimited(extractRetryAfterSeconds(runRes));
        await fetchStatus(targetMode);
        return;
      }
      if (runRes.ok) {
        try {
          const runJson = await runRes.json();
          if (runJson?.timings_ms && typeof runJson.timings_ms === 'object') {
            setTimingsByMode((prev) => ({
              ...prev,
              [targetMode]: runJson.timings_ms,
            }));
          }
        } catch {
          // Lecture couverte par fetchStatus ci-dessous
        }
      }
      const done = await fetchStatus(targetMode);
      await refreshSessions();
      setActiveNav(destNav);
      if (done?.synthesis) {
        pushToast(
          `Synthèse ${targetMode} assemblée`,
          `${done.synthesis.findings.length} constat(s) croisés et vérifiés`,
          'success'
        );
      }
    } finally {
      window.clearInterval(pollId);
      setIsRunning(false);
    }
  };

  const handleRunAudit = () => executeSingleMode(mode, 'cockpit');

  const handleRunBothModes = async () => {
    setIsRunning(true);
    setLiveEntries([]);

    const pollId = window.setInterval(() => {
      fetchStatus(modeRef.current);
    }, 1100);

    try {
      for (const stepMode of ['AVANT', 'APRES'] as const) {
        setMode(stepMode);
        setSequenceLabel(
          stepMode === 'AVANT'
            ? 'Étape 1/2 • Phase AVANT'
            : 'Étape 2/2 • Phase APRÈS'
        );
        setLiveStatuses({
          Douanier: 'en_cours',
          AnalysteConformite: 'en_attente',
          ContreAuditeur: 'en_attente',
          GardeDuCorps: 'en_attente',
        });

        const runPromise = apiFetch('/api/audit/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: stepMode,
            use_cache: useCache ? true : null,
          }),
        });
        await playCachedSequenceIfEnabled();
        const stepRes = await runPromise;
        if (stepRes.status === 429) {
          notifyRateLimited(extractRetryAfterSeconds(stepRes));
          await fetchStatus(stepMode);
          return;
        }
        if (stepRes.ok) {
          try {
            const stepJson = await stepRes.json();
            if (stepJson?.timings_ms && typeof stepJson.timings_ms === 'object') {
              setTimingsByMode((prev) => ({
                ...prev,
                [stepMode]: stepJson.timings_ms,
              }));
            }
          } catch {
            // Lecture couverte par fetchStatus ci-dessous
          }
        }
        await fetchStatus(stepMode);
      }
      await refreshSessions();
      setActiveNav('compare');
      pushToast(
        'Séquence AVANT → APRÈS terminée',
        'Comparateur de trajectoire et ruptures du Dit disponibles',
        'success'
      );
    } finally {
      window.clearInterval(pollId);
      setSequenceLabel(null);
      setIsRunning(false);
    }
  };

  const handleValidate = async (): Promise<boolean> => {
    let res: Response;
    try {
      res = await apiFetch(`/api/validate?mode=${mode}`, { method: 'POST' });
    } catch {
      pushToast(
        'Validation impossible',
        'Le serveur TRIAD ne répond pas. Vérifiez la connexion puis réessayez.',
        'critical'
      );
      return false;
    }
    if (!res.ok) {
      if (res.status !== 429) {
        pushToast(
          'Validation refusée',
          `Le serveur a répondu ${res.status}. Les livrables restent verrouillés.`,
          'critical'
        );
      }
      return false;
    }
    await fetchStatus(mode);
    await fetchDeliverables(mode);
    await refreshSessions();
    pushToast(
      'Synthèse validée par le consultant',
      `Signature scellée SHA-256 — Livrables ${mode} débloqués`,
      'success'
    );
    return true;
  };

  const openValidationGate = () => {
    preloadNavChunk('deliverables');
    setDeliverablesSubTab('deliverables');
    setActiveNav('deliverables');
  };

  const handleSaveFindingDecision = useCallback(
    async (
      findingId: string,
      payload: FindingDecisionPatchPayload
    ): Promise<boolean> => {
      const outcome = await patchFindingGrcDecision(findingId, payload);
      if (!outcome.ok) {
        if (outcome.status !== 429) {
          pushToast(
            "Échec d'enregistrement GRC",
            outcome.detail,
            'critical'
          );
        }
        return false;
      }

      if (outcome.data.validation_reset) {
        setReportMarkdown('');
        setMailText('');
        setAnssiDraftMarkdown('');
        setComexBriefMarkdown('');
        setTerraformHcl('');
        setInterviewGuideMarkdown('');
        setRiskRegisterMarkdown('');
        setCnilDraftMarkdown('');
      }

      const freshStatus = await fetchStatus(payload.mode);
      await refreshSessions();

      const updatedFinding =
        freshStatus?.synthesis?.findings?.find(
          (f) => f.id.toUpperCase() === findingId.toUpperCase()
        ) || outcome.data.finding;

      if (updatedFinding) {
        setDrawer((prev) =>
          prev?.type === 'finding' &&
          prev.finding.id.toUpperCase() === findingId.toUpperCase()
            ? { ...prev, finding: updatedFinding }
            : prev
        );
      }

      if (outcome.data.validation_reset) {
        pushToast(
          `Arbitrage GRC enregistré (${outcome.data.finding_id})`,
          `${outcome.data.decision.decision_label} — Scellé SHA-256 (re-validation consultant requise avant export)`,
          'warning'
        );
      } else {
        pushToast(
          `Arbitrage GRC enregistré (${outcome.data.finding_id})`,
          `${outcome.data.decision.decision_label} — Scellé dans le registre SHA-256`,
          'success'
        );
      }
      return true;
    },
    [fetchStatus, refreshSessions, pushToast]
  );

  const handleSimulateViolation = async () => {
    await apiFetch('/api/security/simulate-violation', { method: 'POST' });
    await fetchStatus(mode);
    setDeliverablesSubTab('chain');
    setActiveNav('deliverables');
    pushToast(
      'Action interdite bloquée',
      'Tentative delete_bucket enregistrée dans la chaîne SHA-256',
      'critical'
    );
  };

  const synthesis = statusData?.synthesis || synthesesByMode[mode] || null;
  const validated = Boolean(statusData?.validated);
  const avantSynthesis = synthesesByMode.AVANT || null;
  const apresSynthesis = synthesesByMode.APRES || null;
  const bothModesReady = Boolean(avantSynthesis && apresSynthesis);

  useEffect(() => {
    if (paletteOpen) setHasOpenedPalette(true);
  }, [paletteOpen]);

  useEffect(() => {
    if (drawer !== null) setHasOpenedDrawer(true);
  }, [drawer]);

  const preloadNavChunk = useCallback((section: NavSection) => {
    if (section === 'cockpit') {
      void loadExecutiveSummary();
      void loadInspectorDrawer();
    } else if (section === 'triad') {
      void loadFindingsExplorer();
      void loadInspectorDrawer();
    } else if (section === 'compare') {
      void loadComparatorView();
      void loadInspectorDrawer();
    } else if (section === 'deliverables') {
      void loadSecurityAndDeliverablesView();
    }
  }, []);

  // Raccourcis clavier globaux : Ctrl+K / Cmd+K, Alt+1..Alt+5 (QWERTY + AZERTY), '?' et '1'..'5'
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        void loadCommandPalette();
        setHasOpenedPalette(true);
        setPaletteOpen((prev) => !prev);
        return;
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const digit =
          e.key === '1' || e.code === 'Digit1'
            ? 1
            : e.key === '2' || e.code === 'Digit2'
            ? 2
            : e.key === '3' || e.code === 'Digit3'
            ? 3
            : e.key === '4' || e.code === 'Digit4'
            ? 4
            : e.key === '5' || e.code === 'Digit5'
            ? 5
            : 0;

        if (digit >= 1 && digit <= 5) {
          e.preventDefault();
          if (paletteOpen) setPaletteOpen(false);
          if (digit === 1) {
            setActiveNav('mission');
          } else if (digit === 2 && synthesis) {
            preloadNavChunk('cockpit');
            setActiveNav('cockpit');
          } else if (digit === 3 && synthesis) {
            preloadNavChunk('triad');
            setActiveNav('triad');
          } else if (digit === 4) {
            preloadNavChunk('compare');
            setActiveNav('compare');
          } else if (digit === 5) {
            preloadNavChunk('deliverables');
            setActiveNav('deliverables');
          }
          return;
        }
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
        return;
      }

      if (paletteOpen || shortcutsOpen || drawer) return;

      if (e.key === '1') {
        setActiveNav('mission');
      } else if (e.key === '2' && synthesis) {
        preloadNavChunk('cockpit');
        setActiveNav('cockpit');
      } else if (e.key === '3' && synthesis) {
        preloadNavChunk('triad');
        setActiveNav('triad');
      } else if (e.key === '4') {
        preloadNavChunk('compare');
        setActiveNav('compare');
      } else if (e.key === '5') {
        preloadNavChunk('deliverables');
        setActiveNav('deliverables');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, shortcutsOpen, drawer, synthesis, preloadNavChunk]);

  const comparisonSummary = useMemo(() => {
    if (!avantSynthesis || !apresSynthesis) return null;
    return compareSyntheses(avantSynthesis, apresSynthesis);
  }, [avantSynthesis, apresSynthesis]);

  const displayedDocs: SanitizedDocument[] = synthesis
    ? [
        ...(synthesis.documents_nettoyes || []),
        ...(synthesis.documents_quarantaine || []),
      ]
    : (statusData?.files || []).map((name) => ({
        nom_fichier: name,
        statut: 'pret',
      }));

  const handleOpenQuoteInDoc = (sourceName: string, quote: string) => {
    const targetDoc = displayedDocs.find(
      (d) => d.nom_fichier.toLowerCase() === sourceName.toLowerCase()
    );
    if (targetDoc) {
      setDrawer({
        type: 'doc',
        doc: targetDoc,
        highlightQuote: quote,
      });
    }
  };

  const nonConformesCount =
    synthesis?.findings.filter((f) => f.statut === 'non_conforme').length || 0;
  const arbitratedCount =
    synthesis?.findings.filter((f) => Boolean(f.decision_grc?.decision))
      .length || 0;

  const workflowSteps: ReadonlyArray<{
    key: string;
    label: string;
    done: boolean;
    active: boolean;
    targetNav: NavSection;
    disabled?: boolean;
    meta?: string;
  }> = [
    {
      key: 'dossier',
      label: 'Dossier',
      done: displayedDocs.length > 0,
      active: activeNav === 'mission',
      targetNav: 'mission',
      meta: displayedDocs.length > 0 ? `${displayedDocs.length}` : undefined,
    },
    {
      key: 'audit',
      label: 'Audit',
      done: Boolean(synthesis),
      active: activeNav === 'cockpit' || activeNav === 'compare',
      targetNav: synthesis ? 'cockpit' : 'mission',
    },
    {
      key: 'arbitrage',
      label: 'Arbitrage',
      done: arbitratedCount > 0,
      active: activeNav === 'triad',
      targetNav: synthesis ? 'triad' : 'mission',
      disabled: !synthesis,
      meta: arbitratedCount > 0 ? `${arbitratedCount}` : undefined,
    },
    {
      key: 'scellement',
      label: 'Scellement',
      done: validated,
      active: activeNav === 'deliverables',
      targetNav: 'deliverables',
    },
  ];

  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: string | number;
    badgeTone?: string;
    disabled?: boolean;
  }> = [
    {
      id: 'mission',
      label: 'Mission',
      icon: Compass,
      badge: displayedDocs.length || undefined,
      badgeTone: 'bg-white/10 text-slate-300',
    },
    {
      id: 'cockpit',
      label: 'Cockpit',
      icon: LayoutDashboard,
      disabled: !synthesis,
      badge: synthesis ? `${synthesis.findings.length}` : undefined,
      badgeTone: 'bg-white/[0.08] text-slate-300',
    },
    {
      id: 'triad',
      label: 'Investigation',
      icon: Triangle,
      disabled: !synthesis,
      badge: nonConformesCount > 0 ? `${nonConformesCount}` : undefined,
      badgeTone: 'bg-rose-500/20 text-rose-300',
    },
    {
      id: 'compare',
      label: 'Comparateur',
      icon: GitCompareArrows,
      badge: comparisonSummary
        ? `+${comparisonSummary.ditContradictionsCount}`
        : undefined,
      badgeTone: 'bg-white/[0.08] text-slate-300',
    },
    {
      id: 'deliverables',
      label: 'Livrables',
      icon: ShieldCheck,
      badge: validated ? 'Validé' : 'À signer',
      badgeTone: validated
        ? 'bg-[var(--deloitte)] text-black'
        : 'bg-amber-500/20 text-amber-300',
    },
  ];

  const sectionTitles: Record<NavSection, string> = {
    mission: 'Mission & Dossier',
    cockpit: 'Cockpit Exécutif',
    triad: 'Investigation TRIAD',
    compare: 'Comparateur AVANT / APRÈS',
    deliverables: 'Livrables & Gouvernance',
  };

  return (
    <MotionConfig reducedMotion="user">
      <UiTooltipProvider>
        <div className="min-h-screen flex flex-col lg:flex-row app-canvas text-main">
          {/* Lien d'évitement clavier WCAG */}
          <a href="#main-content" className="skip-to-content">
            Aller au contenu principal
          </a>
          <Suspense fallback={null}>
            <LazySmoothScroll />
          </Suspense>

          {/* RAIL DE NAVIGATION LATÉRAL GAUCHE (OBSIDIENNE #07090F) */}
        <aside className="lg:w-56 bg-[var(--bg-rail)] text-white border-b lg:border-b-0 lg:border-r border-white/10 flex flex-col justify-between shrink-0 lg:sticky lg:top-0 lg:h-screen z-30">
          <div>
            {/* Marque TRIAD */}
            <div className="px-4 py-4 border-b border-white/8 flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-[var(--deloitte)] text-black flex items-center justify-center shadow-[0_0_16px_rgba(134,188,37,0.28)] shrink-0">
                <svg
                  viewBox="0 0 24 24"
                  className="w-4 h-4 fill-none stroke-current"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="12 3 21 19 3 19" />
                  <circle cx="12" cy="14" r="1.5" fill="currentColor" />
                </svg>
              </div>
              <div className="min-w-0 flex items-center gap-1.5">
                <span className="font-display text-base font-extrabold tracking-tight leading-none">
                  TRIAD
                </span>
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)]" />
              </div>
            </div>

            {/* Raccourci Palette de Commandes & Aide Clavier dans le rail */}
            <div className="px-3 pt-3 hidden lg:flex items-center gap-1.5">
              <button
                type="button"
                onMouseEnter={() => void loadCommandPalette()}
                onFocus={() => void loadCommandPalette()}
                onClick={() => {
                  void loadCommandPalette();
                  setHasOpenedPalette(true);
                  setPaletteOpen(true);
                }}
                className="flex-1 min-w-0 flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-xs text-slate-300 transition cursor-pointer"
              >
                <span className="inline-flex items-center gap-2 truncate">
                  <Search className="w-3.5 h-3.5 text-[var(--accent-text)] shrink-0" />
                  <span className="truncate">Rechercher…</span>
                </span>
                <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-white/10 text-slate-300 shrink-0">
                  Ctrl K
                </kbd>
              </button>

              <UiTooltip label="Raccourcis clavier" shortcut="?">
                <button
                  type="button"
                  aria-label="Afficher les raccourcis clavier"
                  onClick={() => setShortcutsOpen(true)}
                  className="px-2.5 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 font-mono text-xs font-bold text-slate-300 hover:text-white transition cursor-pointer shrink-0"
                >
                  ?
                </button>
              </UiTooltip>
            </div>

            {/* Menu épuré des 5 vues (préchargement au survol/focus + Alt+1..Alt+5) */}
            <nav
              aria-label="Navigation principale TRIAD"
              className="p-2.5 flex lg:flex-col gap-1 overflow-x-auto no-scrollbar"
            >
              {navItems.map((item, idx) => {
                const Icon = item.icon;
                const isActive = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    aria-current={isActive ? 'page' : undefined}
                    title={`${item.label} (Alt+${idx + 1})`}
                    onMouseEnter={() => {
                      if (!item.disabled) preloadNavChunk(item.id);
                    }}
                    onFocus={() => {
                      if (!item.disabled) preloadNavChunk(item.id);
                    }}
                    onClick={() => setActiveNav(item.id)}
                    className={`min-h-[38px] flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left transition shrink-0 lg:w-full ${
                      item.disabled
                        ? 'opacity-35 cursor-not-allowed'
                        : 'cursor-pointer'
                    } ${
                      isActive
                        ? 'bg-[var(--deloitte)]/15 text-white border border-[var(--deloitte)]/40'
                        : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Icon
                        className={`w-4 h-4 shrink-0 ${
                          isActive ? 'text-[var(--accent-text)]' : 'text-slate-400'
                        }`}
                      />
                      <span className="text-xs font-bold leading-tight truncate">
                        {item.label}
                      </span>
                    </div>
                    {item.badge && (
                      <span
                        className={`text-[10px] font-mono font-extrabold px-2 py-0.5 rounded-full shrink-0 tabular-nums ${item.badgeTone}`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Bloc inférieur du rail : État d'intégrité SHA-256 compact */}
          <div className="hidden lg:block p-3.5 border-t border-white/8 space-y-2">
            <div className="rounded-xl bg-white/[0.03] border border-white/8 px-3 py-2.5 flex items-center justify-between text-[11px]">
              <span className="text-slate-400 font-mono tabular-nums">
                SHA-256 ({statusData?.audit_log?.length || 0})
              </span>
              <span
                className={`font-bold ${
                  statusData?.chain?.valide !== false
                    ? 'text-[var(--accent-text)]'
                    : 'text-rose-400'
                }`}
              >
                {statusData?.chain?.valide !== false ? 'Intègre ✓' : 'Altéré !'}
              </span>
            </div>

            <button
              type="button"
              onClick={handleSimulateViolation}
              className="w-full inline-flex items-center gap-2 text-left text-[11px] text-slate-400 hover:text-rose-400 transition px-2 py-1 rounded-lg hover:bg-white/[0.03] cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Tester Garde du Corps</span>
            </button>
          </div>
        </aside>

        {/* ZONE PRINCIPALE DROITE */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* EN-TÊTE MINIMALISTE + FIL D'ÉTAPES CLIQUABLE (SANS AUCUN BADGE DE STACK TECHNIQUE) */}
          <header className="sticky top-0 z-20 surface-panel border-x-0 border-t-0 px-4 sm:px-6 py-2.5 backdrop-blur-md">
            <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                <h1 className="text-sm sm:text-base font-extrabold tracking-tight text-main truncate">
                  {sectionTitles[activeNav]}
                </h1>
                <span className="text-dim hidden sm:inline">•</span>
                <button
                  type="button"
                  onClick={() => setActiveNav('mission')}
                  title="Gérer la session d'audit active"
                  className={`font-mono text-[11px] font-bold px-2.5 py-0.5 rounded-full transition cursor-pointer ${
                    sessionId === DEFAULT_SESSION_ID
                      ? 'surface-subtle text-sub hover:text-main'
                      : 'badge-info'
                  }`}
                >
                  {sessionId === DEFAULT_SESSION_ID
                    ? synthesis?.client || 'CH de Valmont'
                    : sessionId}
                </button>

                {/* Indicateur d'avancement compact cliquable : Dossier → Audit → Arbitrage → Scellement */}
                <nav
                  aria-label="Progression de la mission"
                  className="hidden md:inline-flex items-center gap-1 surface-subtle px-2 py-1 rounded-xl ml-1"
                >
                  {workflowSteps.map((step, sIdx) => (
                    <React.Fragment key={step.key}>
                      <button
                        type="button"
                        disabled={step.disabled}
                        onMouseEnter={() => {
                          if (!step.disabled) preloadNavChunk(step.targetNav);
                        }}
                        onFocus={() => {
                          if (!step.disabled) preloadNavChunk(step.targetNav);
                        }}
                        onClick={() => setActiveNav(step.targetNav)}
                        aria-current={step.active ? 'step' : undefined}
                        title={step.done ? `${step.label} : terminé` : `${step.label} : à faire`}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border transition ${
                          step.disabled
                            ? 'opacity-40 cursor-not-allowed text-dim border-transparent'
                            : step.active
                            ? 'border-[var(--accent-border)] bg-[var(--accent-soft)] cursor-pointer ' +
                              (step.done ? 'text-accent' : 'text-main')
                            : step.done
                            ? 'border-transparent text-accent hover:bg-[var(--bg-hover)] cursor-pointer'
                            : 'border-transparent text-sub hover:text-main cursor-pointer'
                        }`}
                      >
                        {step.done ? (
                          <CheckCircle2 className="w-3 h-3 text-accent shrink-0" />
                        ) : (
                          <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full border border-current opacity-60 shrink-0" />
                        )}
                        <span>{step.label}</span>
                        {step.meta && (
                          <span className="font-mono text-[10px] opacity-80 tabular-nums">
                            ({step.meta})
                          </span>
                        )}
                      </button>
                      {sIdx < workflowSteps.length - 1 && (
                        <ChevronRight className="w-3 h-3 text-dim shrink-0" />
                      )}
                    </React.Fragment>
                  ))}
                </nav>
              </div>

              {/* Contrôles globaux minimalistes */}
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Sélecteur AVANT / APRÈS compact */}
                <div
                  role="group"
                  aria-label="Sélection de la phase d'audit"
                  className="flex surface-subtle p-0.5 rounded-xl"
                >
                  {(['AVANT', 'APRES'] as const).map((m) => {
                    const active = mode === m;
                    const ready =
                      Boolean(statusData?.modes_ready?.[m]) ||
                      Boolean(synthesesByMode[m]);
                    return (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={active}
                        onClick={() => handleModeChange(m)}
                        className={`min-h-[32px] flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-extrabold transition cursor-pointer ${
                          active
                            ? 'seg-active'
                            : 'text-sub hover:text-main'
                        }`}
                      >
                        <span>{m === 'AVANT' ? 'AVANT' : 'APRÈS'}</span>
                        {ready && (
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              'bg-[var(--deloitte)]'
                            }`}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Bouton Lancer l'audit */}
                <button
                  type="button"
                  onMouseEnter={() => preloadNavChunk('cockpit')}
                  onClick={handleRunAudit}
                  disabled={isRunning}
                  className="min-h-[36px] inline-flex items-center gap-1.5 bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] disabled:opacity-50 text-black font-extrabold px-3.5 py-1.5 rounded-xl text-xs transition shadow-xs cursor-pointer"
                >
                  {isRunning ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Analyse…</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Auditer</span>
                    </>
                  )}
                </button>

                {/* Option Cache Secours compacte */}
                <UiTooltip label="Cache secours hors-ligne">
                  <label className="min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl surface-card text-xs font-semibold text-sub hover:text-main cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={useCache}
                      onChange={(e) => setUseCache(e.target.checked)}
                      className="accent-[var(--deloitte)] rounded"
                    />
                    <Zap className="w-3.5 h-3.5 text-accent" />
                    <span className="hidden xl:inline">Cache</span>
                  </label>
                </UiTooltip>

                {/* Déclencheur Palette Ctrl+K */}
                <UiTooltip label="Palette de commandes" shortcut="Ctrl K">
                  <button
                    type="button"
                    onMouseEnter={() => void loadCommandPalette()}
                    onFocus={() => void loadCommandPalette()}
                    onClick={() => {
                      void loadCommandPalette();
                      setHasOpenedPalette(true);
                      setPaletteOpen(true);
                    }}
                    className="min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl surface-card text-xs font-medium text-sub hover:text-main hover:border-strong transition cursor-pointer"
                  >
                    <Search className="w-3.5 h-3.5 text-accent" />
                    <kbd className="kbd-pill hidden sm:inline-flex">Ctrl K</kbd>
                  </button>
                </UiTooltip>

                {/* Bascule Densité Confort / Compacte (persistée localStorage) */}
                <UiTooltip
                  label={
                    density === 'comfort'
                      ? 'Passer en densité Compacte'
                      : 'Passer en densité Confort'
                  }
                >
                  <button
                    type="button"
                    aria-label="Basculer la densité d'affichage"
                    aria-pressed={density === 'compact'}
                    onClick={() =>
                      setDensity((d) => (d === 'comfort' ? 'compact' : 'comfort'))
                    }
                    className="min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl surface-card text-xs font-semibold text-sub hover:text-main hover:border-strong transition cursor-pointer"
                  >
                    {density === 'comfort' ? (
                      <>
                        <Minimize2 className="w-3.5 h-3.5 text-accent" />
                        <span className="hidden lg:inline">Confort</span>
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-3.5 h-3.5 text-accent" />
                        <span className="hidden lg:inline">Compact</span>
                      </>
                    )}
                  </button>
                </UiTooltip>

                {/* Bascule Thème */}
                <UiTooltip
                  label={
                    theme === 'dark' ? 'Thème clair' : 'Thème sombre'
                  }
                >
                  <button
                    type="button"
                    aria-label="Basculer le thème d'affichage"
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                    className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center p-2 rounded-xl surface-card text-sub hover:text-main transition cursor-pointer"
                  >
                    {theme === 'dark' ? (
                      <Sun className="w-4 h-4 text-amber-400" />
                    ) : (
                      <Moon className="w-4 h-4 text-slate-700" />
                    )}
                  </button>
                </UiTooltip>

                {/* Réinitialiser */}
                <UiTooltip label="Réinitialiser la session">
                  <button
                    type="button"
                    aria-label="Réinitialiser toute la session"
                    onClick={handleReset}
                    className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center p-2 rounded-xl surface-card text-sub hover:text-rose-500 transition cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </UiTooltip>
              </div>
            </div>
          </header>

          {/* ALERTE ROUGE SI VIOLATION DÉTECTÉE PAR LE GARDE DU CORPS */}
          {statusData?.security_alert && (
            <div className="bg-rose-600 text-white px-6 py-2.5 shadow-md">
              <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 text-xs font-bold">
                  <span className="inline-flex items-center gap-1 bg-white text-rose-700 px-2 py-0.5 rounded-md font-extrabold uppercase text-[10px]">
                    <ShieldAlert className="w-3.5 h-3.5" /> Garde du Corps — Action Bloquée
                  </span>
                  <span>{statusData.security_alert}</span>
                </div>
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-xs underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" /> Effacer et réinitialiser
                </button>
              </div>
            </div>
          )}

          {/* CONTENU DYNAMIQUE SELON LA VUE SÉLECTIONNÉE */}
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-6 focus:outline-none"
          >
            {activeNav === 'mission' && (
              <MissionLaunchpad
                mode={mode}
                clientName={synthesis?.client || null}
                activeSessionId={sessionId}
                sessions={sessions}
                timingsMs={statusData?.timings_ms || timingsByMode[mode] || null}
                docs={displayedDocs}
                modesReady={{
                  AVANT:
                    Boolean(statusData?.modes_ready?.AVANT) ||
                    Boolean(avantSynthesis),
                  APRES:
                    Boolean(statusData?.modes_ready?.APRES) ||
                    Boolean(apresSynthesis),
                }}
                onSelectSession={(id) => handleSelectSession(id)}
                onCreateNewSession={handleCreateNewSession}
                onDeleteSession={handleDeleteSession}
                onExportSession={handleExportSession}
                onImportSession={handleImportSession}
                onModeChange={handleModeChange}
                onLoadDemo={handleLoadDemo}
                onUploadFiles={handleUploadFiles}
                onRunAudit={handleRunAudit}
                onRunBothModes={handleRunBothModes}
                onOpenCockpit={() => setActiveNav('cockpit')}
                onOpenComparator={() => setActiveNav('compare')}
                onSelectDoc={(doc) => setDrawer({ type: 'doc', doc })}
              />
            )}

            {activeNav === 'cockpit' && synthesis && (
              <Suspense fallback={<ViewSkeleton />}>
                <LazyExecutiveSummary
                  synthesis={synthesis}
                  mode={mode}
                  sessionId={sessionId}
                  theme={theme}
                  elapsedSeconds={statusData?.elapsed_seconds ?? null}
                  proof={proof}
                  comparisonSummary={comparisonSummary}
                  onSelectFinding={(finding) =>
                    setDrawer({ type: 'finding', finding })
                  }
                  onInspectFindingInExplorer={(finding) => {
                    preloadNavChunk('triad');
                    setActiveNav('triad');
                    setDrawer({ type: 'finding', finding });
                  }}
                  onOpenTriadView={() => {
                    preloadNavChunk('triad');
                    setActiveNav('triad');
                  }}
                  onOpenComparator={() => {
                    preloadNavChunk('compare');
                    setActiveNav('compare');
                  }}
                  onNotify={pushToast}
                />
              </Suspense>
            )}

            {activeNav === 'triad' && synthesis && (
              <Suspense fallback={<ViewSkeleton />}>
                <LazyFindingsExplorer
                  findings={synthesis.findings || []}
                  docs={displayedDocs}
                  mode={mode}
                  onSelectFinding={(finding) =>
                    setDrawer({ type: 'finding', finding })
                  }
                  onOpenQuoteInDoc={handleOpenQuoteInDoc}
                />
              </Suspense>
            )}

            {activeNav === 'compare' && (
              <Suspense fallback={<ViewSkeleton />}>
                <LazyComparatorView
                  sessionId={sessionId}
                  avantSynthesis={avantSynthesis}
                  apresSynthesis={apresSynthesis}
                  avantTimingsMs={timingsByMode.AVANT || null}
                  apresTimingsMs={timingsByMode.APRES || null}
                  activeTimingsMs={statusData?.timings_ms || null}
                  isRunning={isRunning}
                  onRunSingleMode={(m) => executeSingleMode(m, 'compare')}
                  onRunBothModes={handleRunBothModes}
                  onSelectFinding={(finding) =>
                    setDrawer({ type: 'finding', finding })
                  }
                  onOpenQuoteInDoc={handleOpenQuoteInDoc}
                />
              </Suspense>
            )}

            {activeNav === 'deliverables' && (
              <Suspense fallback={<ViewSkeleton />}>
                <LazySecurityAndDeliverablesView
                  synthesis={synthesis}
                  comparisonSummary={comparisonSummary}
                  docs={displayedDocs}
                  auditLog={statusData?.audit_log || []}
                  chain={
                    statusData?.chain || {
                      valide: true,
                      nb_entrees: 0,
                      erreur: null,
                    }
                  }
                  validated={validated}
                  mode={mode}
                  reportMarkdown={reportMarkdown}
                  mailText={mailText}
                  anssiDraftMarkdown={anssiDraftMarkdown}
                  comexBriefMarkdown={comexBriefMarkdown}
                  terraformHcl={terraformHcl}
                  interviewGuideMarkdown={interviewGuideMarkdown}
                  riskRegisterMarkdown={riskRegisterMarkdown}
                  cnilDraftMarkdown={cnilDraftMarkdown}
                  requestedSubTab={deliverablesSubTab}
                  onSubTabHandled={() => setDeliverablesSubTab(null)}
                  onValidate={handleValidate}
                  onSelectDoc={(doc) => setDrawer({ type: 'doc', doc })}
                  onSelectFinding={(finding) =>
                    setDrawer({ type: 'finding', finding })
                  }
                  onSimulateViolation={handleSimulateViolation}
                  onNotify={pushToast}
                />
              </Suspense>
            )}
          </main>

          {/* BARRE DE GOUVERNANCE COMPACTE EN BAS */}
          {synthesis && (
            <footer className="sticky bottom-0 z-20 surface-panel border-x-0 border-b-0 px-4 sm:px-6 py-2 sm:py-2.5 backdrop-blur-md">
              <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  {validated ? (
                    <span className="badge-success inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-extrabold">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Validé ({mode === 'APRES' ? 'APRÈS' : mode})
                    </span>
                  ) : (
                    <span className="badge-warning inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold whitespace-nowrap">
                      <Lock className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Livrables verrouillés</span>
                      <span className="sm:hidden">Verrouillés</span> ({mode === 'APRES' ? 'APRÈS' : mode})
                    </span>
                  )}

                  {!validated && activeNav !== 'deliverables' && (
                    <button
                      type="button"
                      onMouseEnter={() => preloadNavChunk('deliverables')}
                      onFocus={() => preloadNavChunk('deliverables')}
                      onClick={openValidationGate}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-main transition cursor-pointer"
                    >
                      <span>Revoir et valider</span>
                      <ChevronRight className="w-3.5 h-3.5 text-dim" />
                    </button>
                  )}
                </div>

                <div className="hidden sm:flex flex-wrap items-center gap-2">
                  {bothModesReady && activeNav !== 'compare' && (
                    <button
                      type="button"
                      onMouseEnter={() => preloadNavChunk('compare')}
                      onFocus={() => preloadNavChunk('compare')}
                      onClick={() => setActiveNav('compare')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-accent transition cursor-pointer"
                    >
                      <GitCompareArrows className="w-3.5 h-3.5" />
                      <span>Comparateur</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => preloadNavChunk('deliverables')}
                    onFocus={() => preloadNavChunk('deliverables')}
                    onClick={() => setActiveNav('deliverables')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-main transition cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5 text-accent" />
                    <span>{validated ? 'Exports & Aperçu' : 'Livrables'}</span>
                  </button>
                </div>
              </div>
            </footer>
          )}
        </div>

        {/* PALETTE DE COMMANDES RAPIDES CTRL+K / CMD+K (CHUNK LAZY) */}
        {(hasOpenedPalette || paletteOpen) && (
          <Suspense fallback={null}>
            <LazyCommandPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              mode={mode}
              theme={theme}
              useCache={useCache}
              hasSynthesis={Boolean(synthesis)}
              bothModesReady={bothModesReady}
              validated={validated}
              findings={synthesis?.findings || []}
              docs={displayedDocs}
              onNavigate={(nav) => {
                preloadNavChunk(nav);
                setActiveNav(nav);
              }}
              onOpenDeliverablesSubTab={(sub) => {
                preloadNavChunk('deliverables');
                setDeliverablesSubTab(sub);
                setActiveNav('deliverables');
              }}
              onOpenShortcuts={() => setShortcutsOpen(true)}
              onSelectFinding={(f) => {
                void loadInspectorDrawer();
                setDrawer({ type: 'finding', finding: f });
              }}
              onSelectDoc={(d, quote, line) => {
                void loadInspectorDrawer();
                setDrawer({
                  type: 'doc',
                  doc: d,
                  highlightQuote: quote,
                  highlightLine: line,
                });
              }}
              onRunAudit={handleRunAudit}
              onRunBothModes={handleRunBothModes}
              onSwitchMode={handleModeChange}
              onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              onToggleCache={() => setUseCache((c) => !c)}
              onValidate={openValidationGate}
              onLoadDemo={handleLoadDemo}
              onSimulateViolation={handleSimulateViolation}
              onReset={handleReset}
              activeSessionId={sessionId}
              onCreateNewSession={handleCreateNewSession}
              onSelectDefaultSession={() =>
                handleSelectSession(DEFAULT_SESSION_ID)
              }
            />
          </Suspense>
        )}

        {/* AIDE DISCRÈTE DES RACCOURCIS CLAVIER (?) */}
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
        />

        {/* MISE EN SCÈNE TEMPS RÉEL DES 4 AGENTS PENDANT L'AUDIT */}
        <LiveExecutionOverlay
          visible={isRunning}
          mode={mode}
          sequenceLabel={sequenceLabel}
          statuses={liveStatuses}
          liveEntries={liveEntries}
          useCache={useCache}
        />

        {/* TIROIR COULISSANT D'INSPECTION 3 ONGLETS & SURLIGNAGE CONTEXTUEL (CHUNK LAZY) */}
        {(hasOpenedDrawer || drawer !== null) && (
          <Suspense fallback={null}>
            <LazyInspectorDrawer
              content={drawer}
              mode={mode}
              onClose={() => setDrawer(null)}
              onSaveFindingDecision={handleSaveFindingDecision}
            />
          </Suspense>
        )}

        {/* NOTIFICATIONS TOAST SAAS DISCRÈTES */}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
        </div>
      </UiTooltipProvider>
    </MotionConfig>
  );
};
