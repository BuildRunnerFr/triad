import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ShieldCheck,
  ShieldAlert,
  Lock,
  CheckCircle2,
  Link2,
  FileText,
  Mail,
  Printer,
  Download,
  Copy,
  Check,
  AlertOctagon,
  Eye,
  Flame,
  Target,
  Loader2,
  Cpu,
  Terminal,
  FolderArchive,
  FlaskConical,
  RotateCcw,
  Scale,
  FileCode2,
  KeyRound,
  RefreshCw,
  MessageSquareQuote,
  ClipboardList,
  FileCheck2,
  Search,
  X,
  ChevronDown,
} from 'lucide-react';
import type {
  AuditLogEntry,
  AuditLogExplorerResponse,
  AuditMode,
  AuditSynthesis,
  ChainStatus,
  Finding,
  SanitizedDocument,
  TriadSecurityPosture,
} from '../types';
import {
  apiFetch,
  fetchAnssiDraft,
  fetchCnilDraft,
  fetchComexBrief,
  fetchFilteredAuditLog,
  fetchInterviewGuide,
  fetchRiskRegister,
  fetchRuntimeSbom,
  fetchSecurityPosture,
  fetchTerraformRemediation,
} from '../api';
import type { AuditComparisonSummary } from '../utils/auditMetrics';
import {
  verifyAuditChainInBrowser,
  type BrowserChainVerificationReport,
} from '../utils/webCryptoVerify';
import {
  RemediationRoadmap,
  classifyFindingForRoadmap,
  HORIZON_META,
  type HorizonKey,
} from './RemediationRoadmap';
import {
  COVERAGE_STATUS_META,
  computeLocalNis2Coverage,
  normalizeServerNis2Coverage,
  type Nis2CoverageReport,
} from '../utils/nis2Coverage';
import { ForensicBundleVerifier } from './ForensicBundleVerifier';
import { LockedDeliverablesList, SealBanner, ValidationAttestation } from './ValidationSeal';
import type { ToastTone } from './ToastStack';

export type DeliverablesSubTab =
  | 'deliverables'
  | 'roadmap'
  | 'douanier'
  | 'chain';

interface SecurityAndDeliverablesViewProps {
  synthesis: AuditSynthesis | null;
  comparisonSummary?: AuditComparisonSummary | null;
  docs: SanitizedDocument[];
  auditLog: AuditLogEntry[];
  chain: ChainStatus;
  validated: boolean;
  mode: AuditMode;
  reportMarkdown: string;
  mailText: string;
  anssiDraftMarkdown?: string;
  comexBriefMarkdown?: string;
  terraformHcl?: string;
  interviewGuideMarkdown?: string;
  riskRegisterMarkdown?: string;
  cnilDraftMarkdown?: string;
  requestedSubTab?: DeliverablesSubTab | null;
  onSubTabHandled?: () => void;
  onValidate: () => Promise<boolean>;
  onSelectDoc: (doc: SanitizedDocument) => void;
  onSelectFinding: (finding: Finding) => void;
  onSimulateViolation: () => void;
  onNotify?: (title: string, detail?: string, tone?: ToastTone) => void;
}

interface ForensicTamperState {
  blockIndex: number;
  blockNum: number;
  fieldLabel: string;
  beforeSnippet: string;
  afterSnippet: string;
  entries: AuditLogEntry[];
}

function flipSingleChar(str: string): string {
  if (!str) return 'X';
  const last = str.slice(-1);
  const replacement = last === 'X' ? 'Y' : last === '1' ? '2' : 'X';
  return `${str.slice(0, -1)}${replacement}`;
}

function createForensicTamperInMemory(
  sourceLog: AuditLogEntry[]
): ForensicTamperState | null {
  if (sourceLog.length === 0) return null;
  // Cible l'avant-dernier bloc (si >= 2) pour illustrer à la fois le bloc falsifié ET la rupture prev_hash en aval
  const blockIndex = sourceLog.length >= 2 ? sourceLog.length - 2 : 0;
  const blockNum = blockIndex + 1;
  const original = sourceLog[blockIndex];

  let mutatedEntry: AuditLogEntry;
  let fieldLabel = 'details';
  let beforeSnippet = '';
  let afterSnippet = '';

  if (typeof original.details === 'string' && original.details.length > 0) {
    const mutatedStr = flipSingleChar(original.details);
    beforeSnippet = original.details.slice(-18);
    afterSnippet = mutatedStr.slice(-18);
    mutatedEntry = { ...original, details: mutatedStr };
  } else if (
    original.details &&
    typeof original.details === 'object' &&
    !Array.isArray(original.details)
  ) {
    const clonedDetails: Record<string, unknown> = { ...original.details };
    const keys = Object.keys(clonedDetails);
    const strKey = keys.find(
      (k) =>
        typeof clonedDetails[k] === 'string' &&
        (clonedDetails[k] as string).length > 0
    );
    const numKey = keys.find((k) => typeof clonedDetails[k] === 'number');

    if (strKey) {
      const origVal = clonedDetails[strKey] as string;
      const nextVal = flipSingleChar(origVal);
      clonedDetails[strKey] = nextVal;
      fieldLabel = `details.${strKey}`;
      beforeSnippet = origVal;
      afterSnippet = nextVal;
      mutatedEntry = { ...original, details: clonedDetails };
    } else if (numKey) {
      const origNum = clonedDetails[numKey] as number;
      const nextNum = origNum + 1;
      clonedDetails[numKey] = nextNum;
      fieldLabel = `details.${numKey}`;
      beforeSnippet = String(origNum);
      afterSnippet = String(nextNum);
      mutatedEntry = { ...original, details: clonedDetails };
    } else {
      const nextAction = flipSingleChar(original.action);
      fieldLabel = 'action';
      beforeSnippet = original.action;
      afterSnippet = nextAction;
      mutatedEntry = { ...original, action: nextAction };
    }
  } else {
    const nextAction = flipSingleChar(original.action);
    fieldLabel = 'action';
    beforeSnippet = original.action;
    afterSnippet = nextAction;
    mutatedEntry = { ...original, action: nextAction };
  }

  const entries = sourceLog.map((item, idx) =>
    idx === blockIndex ? mutatedEntry : item
  );

  return {
    blockIndex,
    blockNum,
    fieldLabel,
    beforeSnippet,
    afterSnippet,
    entries,
  };
}

const PERMISSION_MATRIX = [
  {
    agent: 'Douanier',
    tools: 'read_raw_file, redact_pii, scan_injection, quarantine_file',
    rawAccess: true,
    gcpWrite: false,
  },
  {
    agent: 'AnalysteConformite',
    tools: 'read_sanitized_doc, get_nis2_requirements, gcp_check_* (Storage, VPC, IAM, KMS)',
    rawAccess: false,
    gcpWrite: false,
  },
  {
    agent: 'ContreAuditeur',
    tools: 'verify_quote, read_sanitized_doc, get_nis2_requirements',
    rawAccess: false,
    gcpWrite: false,
  },
  {
    agent: 'GardeDuCorps',
    tools: 'assemble_synthesis, verify_chain',
    rawAccess: false,
    gcpWrite: false,
  },
];

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((token, idx) => {
    if (!token) return null;
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      return (
        <code
          key={idx}
          className="font-mono text-[11px] px-1.5 py-0.5 rounded surface-subtle text-accent break-all"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      return (
        <strong key={idx} className="font-extrabold text-main">
          {renderInlineMarkdown(token.slice(2, -2))}
        </strong>
      );
    }
    if (token.startsWith('*') && token.endsWith('*') && token.length >= 2) {
      return (
        <em key={idx} className="italic text-sub">
          {token.slice(1, -1)}
        </em>
      );
    }
    return <React.Fragment key={idx}>{token}</React.Fragment>;
  });
}

function parsePipeTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('|')) return false;
  const cells = parsePipeTableRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function renderAnssiMarkdownPreview(markdown: string): React.ReactNode {
  const lines = markdown.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const trimmed = lines[idx].trim();
    if (!trimmed) {
      idx += 1;
      continue;
    }

    // Tableau Markdown structuré (| col1 | col2 | + séparateur | :--- | :--- |)
    if (
      trimmed.startsWith('|') &&
      idx + 1 < lines.length &&
      isMarkdownTableSeparator(lines[idx + 1])
    ) {
      const headers = parsePipeTableRow(trimmed);
      idx += 2;
      const bodyRows: string[][] = [];
      while (idx < lines.length && lines[idx].trim().startsWith('|')) {
        bodyRows.push(parsePipeTableRow(lines[idx]));
        idx += 1;
      }
      elements.push(
        <div
          key={`tbl-${idx}`}
          className="overflow-x-auto rounded-xl border border-hairline my-2"
        >
          <table className="w-full text-left text-[11px]">
            <thead className="surface-subtle text-[10px] text-sub border-b border-hairline">
              <tr>
                {headers.map((h, hIdx) => (
                  <th key={hIdx} className="p-2 font-extrabold">
                    {renderInlineMarkdown(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {bodyRows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td key={cIdx} className="p-2 text-sub align-top">
                      {renderInlineMarkdown(r[cIdx] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (trimmed === '---') {
      elements.push(<hr key={idx} className="border-hairline my-3" />);
      idx += 1;
      continue;
    }

    if (trimmed.startsWith('#### ')) {
      elements.push(
        <div
          key={idx}
          className="text-xs font-bold text-main surface-subtle px-2.5 py-1.5 rounded-lg border border-hairline mt-2"
        >
          {renderInlineMarkdown(trimmed.slice(5))}
        </div>
      );
      idx += 1;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      elements.push(
        <h5 key={idx} className="text-xs font-extrabold text-main pt-1.5">
          {renderInlineMarkdown(trimmed.slice(4))}
        </h5>
      );
      idx += 1;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      elements.push(
        <div
          key={idx}
          className="pt-2.5 border-t border-hairline first:border-t-0 first:pt-0"
        >
          <h4 className="text-sm font-semibold text-accent">
            {renderInlineMarkdown(trimmed.slice(3))}
          </h4>
        </div>
      );
      idx += 1;
      continue;
    }

    if (trimmed.startsWith('# ')) {
      elements.push(
        <h4 key={idx} className="text-sm font-extrabold text-main leading-snug">
          {renderInlineMarkdown(trimmed.slice(2))}
        </h4>
      );
      idx += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      elements.push(
        <blockquote
          key={idx}
          className="border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-1.5 rounded-lg text-[11px] text-sub leading-relaxed"
        >
          {renderInlineMarkdown(trimmed.replace(/^>\s*/, ''))}
        </blockquote>
      );
      idx += 1;
      continue;
    }

    if (trimmed.startsWith('- ')) {
      const bulletContent = trimmed.slice(2);
      const isCheckboxUnchecked = bulletContent.startsWith('[ ] ');
      const isCheckboxChecked = /^\[[xX]\]\s+/.test(bulletContent);
      const cleanBullet = isCheckboxUnchecked
        ? bulletContent.slice(4)
        : isCheckboxChecked
        ? bulletContent.replace(/^\[[xX]\]\s+/, '')
        : bulletContent;
      elements.push(
        <div
          key={idx}
          className="flex items-start gap-2 text-xs text-sub leading-relaxed pl-1"
        >
          <span className="text-accent font-bold mt-0.5 shrink-0 font-mono text-[11px]">
            {isCheckboxChecked ? '☑' : isCheckboxUnchecked ? '☐' : '•'}
          </span>
          <span className="min-w-0 break-words">
            {renderInlineMarkdown(cleanBullet)}
          </span>
        </div>
      );
      idx += 1;
      continue;
    }

    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      elements.push(
        <div
          key={idx}
          className="flex items-start gap-2 text-xs text-sub leading-relaxed pl-1"
        >
          <span className="font-mono text-[11px] font-extrabold text-accent mt-0.5 shrink-0 tabular-nums">
            {numberedMatch[1]}.
          </span>
          <span className="min-w-0 break-words">
            {renderInlineMarkdown(numberedMatch[2])}
          </span>
        </div>
      );
      idx += 1;
      continue;
    }

    elements.push(
      <p key={idx} className="text-xs text-sub leading-relaxed break-words">
        {renderInlineMarkdown(trimmed)}
      </p>
    );
    idx += 1;
  }

  return <div className="space-y-2">{elements}</div>;
}

interface ParsedHclSection {
  kind: 'banner' | 'block';
  blockType?: string;
  resourceType?: string;
  resourceName?: string;
  comments: string[];
  codeLines: string[];
}

function renderTerraformHclPreview(hcl: string): React.ReactNode {
  const lines = hcl.split(/\r?\n/);
  const sections: ParsedHclSection[] = [];
  let idx = 0;

  // En-tête de commentaires initiaux
  const bannerComments: string[] = [];
  while (idx < lines.length) {
    const t = lines[idx].trim();
    if (!t) {
      if (bannerComments.length > 0 && idx + 1 < lines.length && !lines[idx + 1].trim().startsWith('#')) {
        idx += 1;
        break;
      }
      idx += 1;
      continue;
    }
    if (t.startsWith('#')) {
      const cleaned = t.replace(/^#+\s?/, '').trim();
      if (cleaned && !/^[-=]{5,}$/.test(cleaned)) {
        bannerComments.push(cleaned);
      }
      idx += 1;
    } else {
      break;
    }
  }
  if (bannerComments.length > 0) {
    sections.push({
      kind: 'banner',
      comments: bannerComments,
      codeLines: [],
    });
  }

  let pendingComments: string[] = [];
  while (idx < lines.length) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed) {
      idx += 1;
      continue;
    }
    if (trimmed.startsWith('#')) {
      const cleaned = trimmed.replace(/^#+\s?/, '').trim();
      if (cleaned && !/^[-=]{5,}$/.test(cleaned)) {
        pendingComments.push(cleaned);
      }
      idx += 1;
      continue;
    }

    const blockMatch = trimmed.match(
      /^(resource|data|variable|output|module|terraform|provider|locals)\b(?:\s+"([^"]+)")?(?:\s+"([^"]+)")?/
    );
    const codeLines: string[] = [raw];
    let depth =
      (raw.match(/\{/g)?.length || 0) - (raw.match(/\}/g)?.length || 0);
    idx += 1;
    while (idx < lines.length && depth > 0) {
      const nextLine = lines[idx];
      codeLines.push(nextLine);
      depth +=
        (nextLine.match(/\{/g)?.length || 0) -
        (nextLine.match(/\}/g)?.length || 0);
      idx += 1;
    }

    sections.push({
      kind: 'block',
      blockType: blockMatch?.[1] || 'hcl',
      resourceType: blockMatch?.[2],
      resourceName: blockMatch?.[3],
      comments: pendingComments,
      codeLines,
    });
    pendingComments = [];
  }

  if (pendingComments.length > 0) {
    sections.push({
      kind: 'banner',
      comments: pendingComments,
      codeLines: [],
    });
  }

  return (
    <div className="space-y-3">
      {sections.map((sec, sIdx) => {
        if (sec.kind === 'banner') {
          return (
            <div
              key={sIdx}
              className="rounded-xl p-3 surface-subtle edge-accent space-y-1 text-[11px] text-sub"
            >
              {sec.comments.map((c, cIdx) => (
                <div key={cIdx} className="leading-snug font-mono break-words">
                  {c}
                </div>
              ))}
            </div>
          );
        }

        return (
          <div
            key={sIdx}
            className="rounded-xl border border-hairline surface-card overflow-hidden"
          >
            <div className="px-3 py-2 surface-subtle border-b border-hairline flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <span className="px-2 py-0.5 rounded surface-subtle border border-hairline text-main font-mono text-[10px] font-bold">
                  {sec.blockType}
                </span>
                {sec.resourceType && (
                  <span className="font-mono text-[11px] font-bold text-accent truncate">
                    {sec.resourceType}
                  </span>
                )}
                {sec.resourceName && (
                  <span className="font-mono text-[11px] text-main truncate">
                    &quot;{sec.resourceName}&quot;
                  </span>
                )}
              </div>
            </div>
            {sec.comments.length > 0 && (
              <div className="px-3 py-2 border-b border-hairline text-[11px] text-sub space-y-0.5 bg-black/10">
                {sec.comments.map((c, cIdx) => (
                  <div key={cIdx} className="leading-snug">
                    {c}
                  </div>
                ))}
              </div>
            )}
            <pre className="p-3 font-mono text-[11px] text-main overflow-x-auto leading-relaxed">
              {sec.codeLines.join('\n')}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

export const SecurityAndDeliverablesView: React.FC<
  SecurityAndDeliverablesViewProps
> = ({
  synthesis,
  comparisonSummary = null,
  docs,
  auditLog,
  chain,
  validated,
  mode,
  reportMarkdown,
  mailText,
  anssiDraftMarkdown = '',
  comexBriefMarkdown = '',
  terraformHcl = '',
  interviewGuideMarkdown = '',
  riskRegisterMarkdown = '',
  cnilDraftMarkdown = '',
  requestedSubTab,
  onSubTabHandled,
  onValidate,
  onSelectDoc,
  onSelectFinding,
  onSimulateViolation,
  onNotify,
}) => {
  const [subTab, setSubTab] = useState<DeliverablesSubTab>(
    requestedSubTab || (synthesis ? 'deliverables' : 'douanier')
  );
  const [chainFilter, setChainFilter] = useState<'ALL' | 'ALERTS' | 'HUMAN'>('ALL');
  /** Horodatage de la signature effectuée dans cette session (déclenche la cérémonie de scellement). */
  const [sealedAt, setSealedAt] = useState<Date | null>(null);
  const handleAttestedValidate = async (): Promise<boolean> => {
    // Horodatage posé dès la signature : la vue « validé » peut s'afficher avant le retour
    // de onValidate (rafraîchissement du statut), la cérémonie doit donc être armée avant.
    setSealedAt(new Date());
    const ok = await onValidate();
    if (!ok) setSealedAt(null);
    return ok;
  };
  const [logFilterAgent, setLogFilterAgent] = useState<string>('');
  const [logFilterAction, setLogFilterAction] = useState<string>('');
  const [logFilterMode, setLogFilterMode] = useState<string>('');
  const [logSearchQuery, setLogSearchQuery] = useState<string>('');
  const [auditExplorerData, setAuditExplorerData] =
    useState<AuditLogExplorerResponse | null>(null);
  const [isLoadingAuditExplorer, setIsLoadingAuditExplorer] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isExportingBundle, setIsExportingBundle] = useState(false);
  const [isExportingAnssi, setIsExportingAnssi] = useState(false);
  const [isExportingComex, setIsExportingComex] = useState(false);
  const [isExportingTerraform, setIsExportingTerraform] = useState(false);
  const [isExportingInterviewGuide, setIsExportingInterviewGuide] =
    useState(false);
  const [isExportingRiskRegister, setIsExportingRiskRegister] = useState(false);
  const [isExportingCnilDraft, setIsExportingCnilDraft] = useState(false);
  const [isDownloadingSbom, setIsDownloadingSbom] = useState(false);
  const [localAnssiDraft, setLocalAnssiDraft] = useState<string>(anssiDraftMarkdown);
  const [localComexBrief, setLocalComexBrief] = useState<string>(comexBriefMarkdown);
  const [localTerraformHcl, setLocalTerraformHcl] = useState<string>(terraformHcl);
  const [localInterviewGuide, setLocalInterviewGuide] = useState<string>(
    interviewGuideMarkdown
  );
  const [localRiskRegister, setLocalRiskRegister] = useState<string>(
    riskRegisterMarkdown
  );
  const [localCnilDraft, setLocalCnilDraft] = useState<string>(cnilDraftMarkdown);
  const [isLoadingAnssiPreview, setIsLoadingAnssiPreview] = useState(false);
  const [isLoadingComexPreview, setIsLoadingComexPreview] = useState(false);
  const [isLoadingTerraformPreview, setIsLoadingTerraformPreview] = useState(false);
  const [isLoadingInterviewGuidePreview, setIsLoadingInterviewGuidePreview] =
    useState(false);
  const [isLoadingRiskRegisterPreview, setIsLoadingRiskRegisterPreview] =
    useState(false);
  const [isLoadingCnilPreview, setIsLoadingCnilPreview] = useState(false);
  const [regulatoryDocTab, setRegulatoryDocTab] = useState<
    'anssi' | 'comex' | 'terraform' | 'interview' | 'grc' | 'cnil'
  >('anssi');
  const [anssiViewMode, setAnssiViewMode] = useState<'formatted' | 'raw'>(
    'formatted'
  );
  const [securityPosture, setSecurityPosture] =
    useState<TriadSecurityPosture | null>(null);
  const [isLoadingPosture, setIsLoadingPosture] = useState(false);
  const [isVerifyingCrypto, setIsVerifyingCrypto] = useState(false);
  const [browserVerifyReport, setBrowserVerifyReport] =
    useState<BrowserChainVerificationReport | null>(null);
  const [forensicTamper, setForensicTamper] =
    useState<ForensicTamperState | null>(null);
  const [serverCoverageReport, setServerCoverageReport] =
    useState<Nis2CoverageReport | null>(null);
  const [showLockTests, setShowLockTests] = useState(false);
  const [previewSection, setPreviewSection] = useState<
    'regulatory' | 'report' | 'mail'
  >('regulatory');
  const [expandedBarriers, setExpandedBarriers] = useState<
    Record<string, boolean>
  >({});
  const [douanierInnerTab, setDouanierInnerTab] = useState<'dlp' | 'matrix'>(
    'dlp'
  );
  const [chainInnerTab, setChainInnerTab] = useState<'ledger' | 'verifier'>(
    'ledger'
  );

  const testLockedExport = async (endpoint: string, label: string) => {
    try {
      const res = await apiFetch(`/api/export/${endpoint}?mode=${mode}`);
      if (res.status === 403) {
        let detail = `Validation humaine requise avant export (${label}).`;
        try {
          const errJson = await res.json();
          if (typeof errJson?.detail === 'string') detail = errJson.detail;
        } catch {
          // Message par défaut
        }
        onNotify?.('Export bloqué (HTTP 403)', detail, 'critical');
      }
    } catch {
      onNotify?.('Export bloqué (HTTP 403)', `${label} verrouillé.`, 'critical');
    }
  };

  useEffect(() => {
    if (!synthesis) {
      setServerCoverageReport(null);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/nis2/coverage?mode=${mode}`)
      .then(async (res) => {
        if (!res.ok) return;
        const json: unknown = await res.json();
        if (cancelled) return;
        const normalized = normalizeServerNis2Coverage(json, mode);
        if (normalized) setServerCoverageReport(normalized);
      })
      .catch(() => {
        // Repli déterministe local ci-dessous
      });
    return () => {
      cancelled = true;
    };
  }, [synthesis, mode]);

  const nis2CoverageReport = useMemo(() => {
    if (!synthesis) return null;
    return (
      serverCoverageReport ||
      computeLocalNis2Coverage(synthesis.findings || [], mode)
    );
  }, [synthesis, mode, serverCoverageReport]);

  useEffect(() => {
    if (requestedSubTab) {
      setSubTab(requestedSubTab);
      onSubTabHandled?.();
    }
  }, [requestedSubTab, onSubTabHandled]);

  useEffect(() => {
    setForensicTamper(null);
    setBrowserVerifyReport(null);
  }, [auditLog]);

  const displayedAuditLog = forensicTamper ? forensicTamper.entries : auditLog;

  const handleVerifyInBrowser = async () => {
    setIsVerifyingCrypto(true);
    try {
      const report = await verifyAuditChainInBrowser(displayedAuditLog);
      setBrowserVerifyReport(report);
      onNotify?.(
        report.supported && report.allValid
          ? 'Intégrité WebCrypto confirmée'
          : 'Alerte de vérification SHA-256',
        `${report.verifiedCount}/${report.totalCount} bloc(s) recalculé(s) en ${report.durationMs} ms`,
        report.supported && report.allValid ? 'success' : 'critical'
      );
    } finally {
      setIsVerifyingCrypto(false);
    }
  };

  const handleSimulateForensicTamper = async () => {
    const tamper = createForensicTamperInMemory(auditLog);
    if (!tamper) return;
    setForensicTamper(tamper);
    setChainFilter('ALL');
    setIsVerifyingCrypto(true);
    try {
      const report = await verifyAuditChainInBrowser(tamper.entries);
      setBrowserVerifyReport(report);
      onNotify?.(
        'Falsification mémoire détectée (WebCrypto)',
        `Bloc #${String(tamper.blockNum).padStart(2, '0')} altéré (${tamper.fieldLabel}) — rupture de chaîne prouvée`,
        'critical'
      );
    } finally {
      setIsVerifyingCrypto(false);
    }
  };

  const handleRestoreIntegrity = async () => {
    setForensicTamper(null);
    setIsVerifyingCrypto(true);
    try {
      const cleanReport = await verifyAuditChainInBrowser(auditLog);
      setBrowserVerifyReport(cleanReport);
      onNotify?.(
        'Intégrité mémoire restaurée',
        `${cleanReport.verifiedCount}/${cleanReport.totalCount} bloc(s) authentifiés conformes au registre serveur`,
        'success'
      );
    } finally {
      setIsVerifyingCrypto(false);
    }
  };

  useEffect(() => {
    if (!validated || !synthesis) {
      setLocalAnssiDraft('');
      setIsLoadingAnssiPreview(false);
      return;
    }
    if (anssiDraftMarkdown) {
      setLocalAnssiDraft(anssiDraftMarkdown);
      setIsLoadingAnssiPreview(false);
      return;
    }
    let cancelled = false;
    setIsLoadingAnssiPreview(true);
    fetchAnssiDraft(mode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setLocalAnssiDraft(outcome.markdown);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAnssiPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validated, synthesis, mode, anssiDraftMarkdown]);

  const effectiveAnssiDraft = anssiDraftMarkdown || localAnssiDraft;

  useEffect(() => {
    if (!validated || !synthesis) {
      setLocalComexBrief('');
      setIsLoadingComexPreview(false);
      return;
    }
    if (comexBriefMarkdown) {
      setLocalComexBrief(comexBriefMarkdown);
      setIsLoadingComexPreview(false);
      return;
    }
    let cancelled = false;
    setIsLoadingComexPreview(true);
    fetchComexBrief(mode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setLocalComexBrief(outcome.markdown);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingComexPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validated, synthesis, mode, comexBriefMarkdown]);

  const effectiveComexBrief = comexBriefMarkdown || localComexBrief;

  useEffect(() => {
    if (!validated || !synthesis) {
      setLocalTerraformHcl('');
      setIsLoadingTerraformPreview(false);
      return;
    }
    if (terraformHcl) {
      setLocalTerraformHcl(terraformHcl);
      setIsLoadingTerraformPreview(false);
      return;
    }
    let cancelled = false;
    setIsLoadingTerraformPreview(true);
    fetchTerraformRemediation(mode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setLocalTerraformHcl(outcome.hclText);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTerraformPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validated, synthesis, mode, terraformHcl]);

  const effectiveTerraformHcl = terraformHcl || localTerraformHcl;

  useEffect(() => {
    if (!validated || !synthesis) {
      setLocalInterviewGuide('');
      setIsLoadingInterviewGuidePreview(false);
      return;
    }
    if (interviewGuideMarkdown) {
      setLocalInterviewGuide(interviewGuideMarkdown);
      setIsLoadingInterviewGuidePreview(false);
      return;
    }
    let cancelled = false;
    setIsLoadingInterviewGuidePreview(true);
    fetchInterviewGuide(mode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setLocalInterviewGuide(outcome.markdown);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingInterviewGuidePreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validated, synthesis, mode, interviewGuideMarkdown]);

  const effectiveInterviewGuide = interviewGuideMarkdown || localInterviewGuide;

  useEffect(() => {
    if (!validated || !synthesis) {
      setLocalRiskRegister('');
      setIsLoadingRiskRegisterPreview(false);
      return;
    }
    if (riskRegisterMarkdown) {
      setLocalRiskRegister(riskRegisterMarkdown);
      setIsLoadingRiskRegisterPreview(false);
      return;
    }
    let cancelled = false;
    setIsLoadingRiskRegisterPreview(true);
    fetchRiskRegister(mode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setLocalRiskRegister(outcome.markdown);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingRiskRegisterPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validated, synthesis, mode, riskRegisterMarkdown]);

  const effectiveRiskRegister = riskRegisterMarkdown || localRiskRegister;

  useEffect(() => {
    if (!validated || !synthesis) {
      setLocalCnilDraft('');
      setIsLoadingCnilPreview(false);
      return;
    }
    if (cnilDraftMarkdown) {
      setLocalCnilDraft(cnilDraftMarkdown);
      setIsLoadingCnilPreview(false);
      return;
    }
    let cancelled = false;
    setIsLoadingCnilPreview(true);
    fetchCnilDraft(mode)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setLocalCnilDraft(outcome.markdown);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingCnilPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validated, synthesis, mode, cnilDraftMarkdown]);

  const effectiveCnilDraft = cnilDraftMarkdown || localCnilDraft;

  // Synchronisation de l'explorateur forensique multi-critères (`GET /api/audit/log`)
  useEffect(() => {
    if (auditLog.length === 0) {
      setAuditExplorerData(null);
      setIsLoadingAuditExplorer(false);
      return;
    }
    if (subTab !== 'chain') return;

    const controller = new AbortController();
    const trimmedQ = logSearchQuery.trim();
    const delayMs = trimmedQ ? 180 : 0;
    setIsLoadingAuditExplorer(true);

    const timerId = window.setTimeout(() => {
      fetchFilteredAuditLog(
        {
          agent: logFilterAgent || undefined,
          action: logFilterAction || undefined,
          mode: logFilterMode || undefined,
          q: trimmedQ || undefined,
        },
        controller.signal
      )
        .then((res) => {
          if (!controller.signal.aborted && res) {
            setAuditExplorerData(res);
          }
        })
        .catch(() => {
          // Repli déterministe local ci-dessous
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsLoadingAuditExplorer(false);
          }
        });
    }, delayMs);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [
    subTab,
    auditLog.length,
    logFilterAgent,
    logFilterAction,
    logFilterMode,
    logSearchQuery,
  ]);

  const refreshSecurityPosture = async () => {
    setIsLoadingPosture(true);
    try {
      const posture = await fetchSecurityPosture(mode);
      if (posture) {
        setSecurityPosture(posture);
      }
    } finally {
      setIsLoadingPosture(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setIsLoadingPosture(true);
    fetchSecurityPosture(mode, controller.signal)
      .then((posture) => {
        if (!cancelled && posture) {
          setSecurityPosture(posture);
        }
      })
      .catch(() => {
        // Ignorer l'annulation
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPosture(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [validated, auditLog.length, mode]);

  const copyText = (
    key: string,
    text: string,
    detailMsg = 'Courriel de suivi DSI prêt à être envoyé'
  ) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
    onNotify?.('Copié dans le presse-papiers', detailMsg, 'info');
  };

  const downloadFile = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    onNotify?.('Livrable exporté', filename, 'success');
  };

  const latestHash =
    auditLog.length > 0 ? auditLog[auditLog.length - 1].hash : '0'.repeat(64);

  const exportSealedJson = async () => {
    try {
      const res = await apiFetch(`/api/export/json?mode=${mode}`);
      if (res.ok) {
        const payload = await res.text();
        downloadFile(
          `Synthese_Scellee_NIS2_${mode}.json`,
          payload,
          'application/json;charset=utf-8'
        );
        return;
      }
    } catch {
      // Repli local si nécessaire
    }
    if (synthesis) {
      downloadFile(
        `Synthese_Scellee_NIS2_${mode}.json`,
        JSON.stringify(
          { synthesis, chain, latest_hash: latestHash },
          null,
          2
        ),
        'application/json;charset=utf-8'
      );
    }
  };

  const exportSealedCsv = async () => {
    try {
      const res = await apiFetch(`/api/export/csv?mode=${mode}`);
      if (res.ok) {
        const csvPayload = await res.text();
        downloadFile(
          `Matrice_Scellee_NIS2_${mode}.csv`,
          csvPayload,
          'text/csv;charset=utf-8'
        );
        return;
      }
    } catch {
      // Repli local uniquement si déjà validé
    }
    if (validated && synthesis) {
      const esc = (v: string) => {
        const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
        return `"${safe.replace(/"/g, '""')}"`;
      };
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
        'Recommandation',
      ];
      const rows = synthesis.findings.map((f) =>
        [
          f.id,
          f.theme,
          f.exigence_nis2,
          f.statut,
          f.gravite,
          f.contradiction || '',
          f.dit?.extrait || '',
          f.ecrit?.extrait || '',
          f.reel?.constat || '',
          f.recommandation,
        ]
          .map(esc)
          .join(';')
      );
      downloadFile(
        `Matrice_Scellee_NIS2_${mode}.csv`,
        '\uFEFF' + [headers.join(';'), ...rows].join('\n'),
        'text/csv;charset=utf-8'
      );
    }
  };

  const exportDryRunPlaybook = async () => {
    try {
      const res = await apiFetch(`/api/export/playbook?mode=${mode}`);
      if (res.ok) {
        const scriptContent = await res.text();
        downloadFile(
          `Playbook_DryRun_NIS2_${mode}.sh`,
          scriptContent,
          'text/x-shellscript;charset=utf-8'
        );
        return;
      }
    } catch {
      // Repli hors-ligne uniquement si déjà validé
    }
    if (validated && synthesis) {
      const cliFindings = synthesis.findings.filter((f) => f.commande_correction);
      const fallbackLines = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `# Playbook de remédiation NIS2 (DRY-RUN) — ${synthesis.client}`,
        `# Phase : ${mode} | Empreinte SHA-256 : ${latestHash}`,
        'EXECUTE="${EXECUTE:-false}"',
        'echo "[TRIAD DRY-RUN] Vérification des commandes correctives (EXECUTE=${EXECUTE})"',
        ...cliFindings.map((f) => {
          const cleanCmd = (f.commande_correction || '')
            .replace(/\s*\(NON EXÉCUTÉE\)\s*/gi, '')
            .trim();
          return `# [${f.id}] ${f.theme}\necho "-> ${cleanCmd.replace(/"/g, '\\"')}"`;
        }),
      ];
      downloadFile(
        `Playbook_DryRun_NIS2_${mode}.sh`,
        fallbackLines.join('\n') + '\n',
        'text/x-shellscript;charset=utf-8'
      );
    }
  };

  const exportProofBundle = async () => {
    if (isExportingBundle) return;
    setIsExportingBundle(true);
    try {
      const res = await apiFetch(`/api/export/bundle?mode=${mode}`);
      if (res.status === 403) {
        let detail =
          'Validation humaine du consultant requise avant l’export du dossier probatoire.';
        try {
          const errJson = await res.json();
          if (typeof errJson?.detail === 'string') detail = errJson.detail;
        } catch {
          // Garder le message par défaut
        }
        onNotify?.('Export bloqué (HTTP 403)', detail, 'critical');
        return;
      }
      if (!res.ok) {
        onNotify?.(
          "Échec de l'export probatoire",
          `Le serveur a répondu avec le code HTTP ${res.status}`,
          'critical'
        );
        return;
      }

      const disposition = res.headers.get('Content-Disposition') || '';
      const matchedName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
      const filename =
        matchedName || `TRIAD_Dossier_Preuve_NIS2_${mode}.zip`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      onNotify?.(
        'Dossier de Preuve NIS2 exporté',
        `${filename} (12 livrables + MANIFEST_SHA256.txt)`,
        'success'
      );
    } catch {
      onNotify?.(
        "Échec de l'export probatoire",
        'Impossible de télécharger l’archive ZIP scellée',
        'critical'
      );
    } finally {
      setIsExportingBundle(false);
    }
  };

  const exportAnssiDraft = async () => {
    if (isExportingAnssi) return;
    setIsExportingAnssi(true);
    try {
      const outcome = await fetchAnssiDraft(mode);
      if (!outcome.ok) {
        if (outcome.status === 403) {
          onNotify?.('Export bloqué (HTTP 403)', outcome.detail, 'critical');
        } else if (outcome.status !== 429) {
          onNotify?.("Échec de l'export ANSSI", outcome.detail, 'critical');
        }
        return;
      }

      setLocalAnssiDraft(outcome.markdown);
      setRegulatoryDocTab('anssi');
      const blob = new Blob([outcome.markdown], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      onNotify?.(
        'Pré-Notification ANSSI exportée',
        `${outcome.filename} • Brouillon Art. 23 NIS2 scellé SHA-256`,
        'success'
      );
    } finally {
      setIsExportingAnssi(false);
    }
  };

  const exportComexBrief = async () => {
    if (isExportingComex) return;
    setIsExportingComex(true);
    try {
      const outcome = await fetchComexBrief(mode);
      if (!outcome.ok) {
        if (outcome.status === 403) {
          onNotify?.('Export bloqué (HTTP 403)', outcome.detail, 'critical');
        } else if (outcome.status !== 429) {
          onNotify?.(
            "Échec de l'export Brief COMEX",
            outcome.detail,
            'critical'
          );
        }
        return;
      }

      setLocalComexBrief(outcome.markdown);
      setRegulatoryDocTab('comex');
      const blob = new Blob([outcome.markdown], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      onNotify?.(
        'Brief COMEX Art. 20 exporté',
        `${outcome.filename} • Synthèse Direction Générale scellée${
          outcome.signatureHeader ? ' HMAC-SHA256' : ' SHA-256'
        }`,
        'success'
      );
    } finally {
      setIsExportingComex(false);
    }
  };

  const exportTerraformManifest = async () => {
    if (isExportingTerraform) return;
    setIsExportingTerraform(true);
    try {
      const outcome = await fetchTerraformRemediation(mode);
      if (!outcome.ok) {
        if (outcome.status === 403) {
          onNotify?.('Export bloqué (HTTP 403)', outcome.detail, 'critical');
        } else if (outcome.status !== 429) {
          onNotify?.(
            "Échec de l'export Terraform GitOps",
            outcome.detail,
            'critical'
          );
        }
        return;
      }

      setLocalTerraformHcl(outcome.hclText);
      setRegulatoryDocTab('terraform');
      const blob = new Blob([outcome.hclText], {
        type: 'text/plain;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      onNotify?.(
        'Manifeste Terraform GitOps exporté',
        `${outcome.filename} • HCL déclaratif scellé${
          outcome.signatureHeader ? ' HMAC-SHA256' : ' SHA-256'
        }`,
        'success'
      );
    } finally {
      setIsExportingTerraform(false);
    }
  };

  const exportInterviewGuide = async () => {
    if (isExportingInterviewGuide) return;
    setIsExportingInterviewGuide(true);
    try {
      const outcome = await fetchInterviewGuide(mode);
      if (!outcome.ok) {
        if (outcome.status === 403) {
          onNotify?.('Export bloqué (HTTP 403)', outcome.detail, 'critical');
        } else if (outcome.status !== 429) {
          onNotify?.(
            "Échec de l'export Guide d'Entretien",
            outcome.detail,
            'critical'
          );
        }
        return;
      }

      setLocalInterviewGuide(outcome.markdown);
      setRegulatoryDocTab('interview');
      const blob = new Blob([outcome.markdown], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      onNotify?.(
        "Guide d'Entretien Contradictoire exporté",
        `${outcome.filename} • Questionnaire 4 panels scellé${
          outcome.signatureHeader ? ' HMAC-SHA256' : ' SHA-256'
        }`,
        'success'
      );
    } finally {
      setIsExportingInterviewGuide(false);
    }
  };

  const exportRiskRegister = async () => {
    if (isExportingRiskRegister) return;
    setIsExportingRiskRegister(true);
    try {
      const outcome = await fetchRiskRegister(mode);
      if (!outcome.ok) {
        if (outcome.status === 403) {
          onNotify?.('Export bloqué (HTTP 403)', outcome.detail, 'critical');
        } else if (outcome.status !== 429) {
          onNotify?.(
            "Échec de l'export Registre GRC",
            outcome.detail,
            'critical'
          );
        }
        return;
      }

      setLocalRiskRegister(outcome.markdown);
      setRegulatoryDocTab('grc');
      const blob = new Blob([outcome.markdown], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      onNotify?.(
        "Registre d'Arbitrages GRC exporté",
        `${outcome.filename} • Homologation & risques résiduels scellés${
          outcome.signatureHeader ? ' HMAC-SHA256' : ' SHA-256'
        }`,
        'success'
      );
    } finally {
      setIsExportingRiskRegister(false);
    }
  };

  const exportCnilDraft = async () => {
    if (isExportingCnilDraft) return;
    setIsExportingCnilDraft(true);
    try {
      const outcome = await fetchCnilDraft(mode);
      if (!outcome.ok) {
        if (outcome.status === 403) {
          onNotify?.('Export bloqué (HTTP 403)', outcome.detail, 'critical');
        } else if (outcome.status !== 429) {
          onNotify?.(
            "Échec de l'export Évaluation CNIL",
            outcome.detail,
            'critical'
          );
        }
        return;
      }

      setLocalCnilDraft(outcome.markdown);
      setRegulatoryDocTab('cnil');
      const blob = new Blob([outcome.markdown], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      onNotify?.(
        'Évaluation CNIL Art. 33 exportée',
        `${outcome.filename} • Fiche RGPD Art. 33 & 34 scellée${
          outcome.signatureHeader ? ' HMAC-SHA256' : ' SHA-256'
        }`,
        'success'
      );
    } finally {
      setIsExportingCnilDraft(false);
    }
  };

  const downloadRuntimeSbom = async () => {
    if (isDownloadingSbom) return;
    setIsDownloadingSbom(true);
    try {
      const outcome = await fetchRuntimeSbom();
      if (!outcome.ok) {
        if (outcome.status !== 429) {
          onNotify?.(
            'Échec du téléchargement SBOM',
            outcome.detail,
            'critical'
          );
        }
        return;
      }

      const blob = new Blob([outcome.jsonText], {
        type: 'application/vnd.cyclonedx+json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      URL.revokeObjectURL(url);

      const compLabel =
        outcome.componentsCount > 0
          ? `${outcome.componentsCount} composants inventoriés`
          : `CycloneDX ${outcome.specVersion}`;
      onNotify?.(
        `SBOM CycloneDX ${outcome.specVersion} téléchargé`,
        `${outcome.filename} • ${compLabel}${
          outcome.signatureHeader ? ' • HMAC-SHA256 ✓' : ''
        }`,
        'success'
      );
    } finally {
      setIsDownloadingSbom(false);
    }
  };

  const printableRoadmapItems = useMemo(() => {
    if (!synthesis?.findings?.length) return [];
    const order: Record<HorizonKey, number> = {
      '0_30': 1,
      '30_60': 2,
      '60_90': 3,
    };
    return synthesis.findings
      .map(classifyFindingForRoadmap)
      .sort((a, b) => order[a.horizon] - order[b.horizon]);
  }, [synthesis]);

  const availableLogAgents = useMemo(() => {
    const set = new Set<string>();
    for (const ag of auditExplorerData?.available_agents || []) {
      if (ag.trim()) set.add(ag.trim());
    }
    for (const entry of auditLog) {
      if (entry.agent?.trim()) set.add(entry.agent.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
  }, [auditExplorerData, auditLog]);

  const availableLogActions = useMemo(() => {
    const set = new Set<string>();
    for (const act of auditExplorerData?.available_actions || []) {
      if (act.trim()) set.add(act.trim());
    }
    for (const entry of auditLog) {
      if (entry.action?.trim()) set.add(entry.action.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
  }, [auditExplorerData, auditLog]);

  const hasActiveLogFilters = Boolean(
    logFilterAgent ||
      logFilterAction ||
      logFilterMode ||
      logSearchQuery.trim() ||
      chainFilter !== 'ALL'
  );

  const resetLogFilters = () => {
    setLogFilterAgent('');
    setLogFilterAction('');
    setLogFilterMode('');
    setLogSearchQuery('');
    setChainFilter('ALL');
  };

  const reversedChain = useMemo(() => {
    const hashToBlockNum = new Map<string, number>();
    displayedAuditLog.forEach((entry, idx) => {
      if (entry.hash && !hashToBlockNum.has(entry.hash)) {
        hashToBlockNum.set(entry.hash, idx + 1);
      }
    });

    const normAgent = logFilterAgent.trim().toLowerCase();
    const normAction = logFilterAction.trim().toLowerCase();
    const normMode = logFilterMode.trim().toUpperCase();
    const normQ = logSearchQuery.trim().toLowerCase();

    const matchesLocalMultiCriteria = (entry: AuditLogEntry): boolean => {
      if (normAgent && (entry.agent || '').trim().toLowerCase() !== normAgent) {
        return false;
      }
      if (
        normAction &&
        (entry.action || '').trim().toLowerCase() !== normAction
      ) {
        return false;
      }
      if (normMode) {
        const em = (entry.mode || '').trim().toUpperCase();
        if (normMode === 'NONE') {
          if (em) return false;
        } else if (em !== normMode) {
          return false;
        }
      }
      if (normQ) {
        const detailsStr =
          typeof entry.details === 'object' && entry.details !== null
            ? JSON.stringify(entry.details)
            : String(entry.details || '');
        const haystack = [
          entry.agent || '',
          entry.action || '',
          entry.mode || '',
          entry.run_id || '',
          detailsStr,
          entry.hash || '',
          entry.prev_hash || '',
          entry.ts || '',
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(normQ)) return false;
      }
      return true;
    };

    let baseItems: Array<{ entry: AuditLogEntry; blockNum: number }>;
    if (!forensicTamper && auditExplorerData && !isLoadingAuditExplorer) {
      baseItems = auditExplorerData.entries.map((entry, idx) => ({
        entry,
        blockNum:
          auditExplorerData.matched_indices[idx] ||
          hashToBlockNum.get(entry.hash) ||
          idx + 1,
      }));
    } else {
      baseItems = displayedAuditLog
        .map((entry, idx) => ({ entry, blockNum: idx + 1 }))
        .filter(({ entry }) => matchesLocalMultiCriteria(entry));
    }

    const rev = [...baseItems].reverse();
    if (chainFilter === 'ALERTS') {
      return rev.filter(
        ({ entry }) =>
          entry.action === 'VIOLATION' || entry.action === 'QUARANTINE'
      );
    }
    if (chainFilter === 'HUMAN') {
      return rev.filter(({ entry }) => entry.action === 'HUMAN_VALIDATION');
    }
    return rev;
  }, [
    displayedAuditLog,
    forensicTamper,
    auditExplorerData,
    isLoadingAuditExplorer,
    logFilterAgent,
    logFilterAction,
    logFilterMode,
    logSearchQuery,
    chainFilter,
  ]);

  const totalChainEntries = forensicTamper
    ? forensicTamper.entries.length
    : auditExplorerData?.total_entries ?? auditLog.length;
  const filteredChainCount = reversedChain.length;
  const globalChainValid = auditExplorerData
    ? auditExplorerData.chain_valid
    : chain.valide;

  // Extraction propre de la ligne "Objet : ..." pour éviter tout doublon d'affichage
  const parsedMail = useMemo(() => {
    const fallbackSubject = 'Synthèse contradictoire NIS2 & Actions prioritaires';
    if (!mailText) {
      return { subject: fallbackSubject, body: '' };
    }
    const match = mailText.match(/^Objet\s*:\s*(.+?)(?:\r?\n)+/i);
    if (match) {
      return {
        subject: match[1].trim(),
        body: mailText.slice(match[0].length).trimStart(),
      };
    }
    return { subject: fallbackSubject, body: mailText };
  }, [mailText]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="space-y-5"
    >
      {/* Sous-onglets : vocabulaire de consultant, sélection neutre, outil de démonstration à part */}
      <div className="border-b border-hairline flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div role="tablist" aria-label="Sections livrables et gouvernance" className="flex flex-wrap items-end gap-1 -mb-px">
          {(
            [
              ['deliverables', 'Livrables', FileText, validated ? '12' : null],
              ['roadmap', 'Plan de remédiation', Target, synthesis ? String(synthesis.findings.length) : null],
              ['douanier', 'Posture et permissions', ShieldCheck, String(docs.length)],
              ['chain', 'Intégrité des preuves', Link2, String(auditLog.length)],
            ] as const
          ).map(([key, label, Icon, count]) => {
            const active = subTab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSubTab(key)}
                className={`inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-semibold border-b-2 transition cursor-pointer ${
                  active
                    ? 'border-[var(--text-primary)] text-main'
                    : 'border-transparent text-sub hover:text-main hover:border-[var(--border-strong)]'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
                {key === 'deliverables' && !validated && <Lock className="w-3.5 h-3.5 text-[var(--warning-text)]" aria-label="verrouillés" />}
                {count && <span className="text-xs text-sub tabular-nums">{count}</span>}
              </button>
            );
          })}
        </div>

        {subTab === 'chain' && (
          <button
            type="button"
            onClick={() => {
              onSimulateViolation();
              setChainInnerTab('ledger');
            }}
            title="Démonstration : un agent tente une action non autorisée (suppression de bucket), qui doit être bloquée et journalisée"
            className="mb-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--critical-border)] text-[var(--critical-text)] hover:bg-[var(--critical-bg)] text-xs font-semibold transition cursor-pointer"
          >
            <Flame className="w-3.5 h-3.5" />
            <span>Tester le blocage d&apos;une action interdite</span>
          </button>
        )}
      </div>

      {/* VOLET 1 : EXPORTS & APERÇU À LA DEMANDE */}
      {subTab === 'deliverables' && (
        <div className="space-y-4">
          {!synthesis ? (
            <div className="surface-panel rounded-2xl p-8 text-center space-y-2">
              <Lock className="w-7 h-7 text-dim mx-auto" />
              <h3 className="text-base font-extrabold text-main">
                Aucun livrable ({mode})
              </h3>
              <p className="text-xs text-sub">
                Lancez l&apos;audit pour générer la synthèse.
              </p>
            </div>
          ) : !validated ? (
            /* Carte verrou épurée pré-validation */
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            <div className="xl:col-span-7 surface-panel rounded-2xl p-5 sm:p-7 space-y-5">
              <ValidationAttestation
                synthesis={synthesis}
                mode={mode}
                onValidate={handleAttestedValidate}
              />

              {/* Accordéon compact des 12 verrous HTTP 403 individuels */}
              <div className="rounded-xl border border-hairline overflow-hidden">
                <button
                  type="button"
                  aria-expanded={showLockTests}
                  onClick={() => setShowLockTests((prev) => !prev)}
                  className="w-full px-4 py-2.5 surface-subtle hover:bg-[var(--bg-hover)] flex items-center justify-between gap-2 text-xs font-bold text-sub hover:text-main transition cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2">
                    <Lock className="w-3.5 h-3.5 tone-warning" />
                    <span>Vérifier les verrous un par un (HTTP 403)</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs tabular-nums">
                    <span>12 exports</span>
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${
                        showLockTests ? 'rotate-180 text-accent' : ''
                      }`}
                    />
                  </span>
                </button>

                {showLockTests && (
                  <div className="p-3 border-t border-hairline grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isExportingBundle}
                      onClick={exportProofBundle}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Dossier de Preuve (.zip)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingAnssi}
                      onClick={exportAnssiDraft}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Pré-Notification ANSSI (.md)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingCnilDraft}
                      onClick={exportCnilDraft}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Évaluation CNIL Art. 33 (.md)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingComex}
                      onClick={exportComexBrief}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Brief COMEX Art. 20 (.md)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingTerraform}
                      onClick={exportTerraformManifest}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Manifeste Terraform (.tf)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingInterviewGuide}
                      onClick={exportInterviewGuide}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Guide d&apos;Entretien (.md)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingRiskRegister}
                      onClick={exportRiskRegister}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Registre GRC (.md)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void testLockedExport('report', 'Rapport Markdown (.md)')}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Rapport Exécutif (.md)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void testLockedExport('mail', 'Courriel DSI (.txt)')}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Courriel DSI (.txt)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void testLockedExport('csv', 'Matrice CSV (.csv)')}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Matrice GRC (.csv)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void testLockedExport('json', 'Synthèse JSON (.json)')}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Synthèse Scellée (.json)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void testLockedExport('playbook', 'Playbook gcloud (.sh)')}
                      className="inline-flex items-center justify-between gap-2 surface-card hover:border-strong text-sub hover:text-main font-bold text-xs px-3 py-2 rounded-lg transition cursor-pointer"
                    >
                      <span className="truncate">Playbook gcloud (.sh)</span>
                      <span className="font-mono text-[10px] tone-warning shrink-0">403</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
              <div className="xl:col-span-5">
                <LockedDeliverablesList />
              </div>
            </div>
          ) : (
            /* Post-validation : Barre d'export compacte + Sélecteur d'aperçu à la demande */
            <div className="space-y-4">
              <SealBanner
                mode={mode}
                hash={latestHash}
                play={sealedAt !== null}
                sealedAt={sealedAt}
              />
              {/* Barre d'export compacte (actions principales + groupe secondaire propre) */}
              <div className="surface-panel rounded-2xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-main">Exporter les livrables</h3>
                  </div>

                  {/* Groupe principal mis en avant */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isExportingBundle}
                      onClick={exportProofBundle}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] disabled:opacity-50 text-black text-xs font-extrabold transition cursor-pointer"
                      title="Télécharger l'archive ZIP complète (12 pièces + MANIFEST_SHA256.txt)"
                    >
                      {isExportingBundle ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <FolderArchive className="w-3.5 h-3.5" />
                      )}
                      <span>Dossier de Preuve (.zip) (12 pièces)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[var(--deloitte)]/50 bg-[var(--accent-soft)] hover:bg-[var(--deloitte)] hover:text-black text-xs font-extrabold text-accent transition cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Imprimer / PDF</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setSubTab('chain');
                        setChainInnerTab('verifier');
                        window.setTimeout(() => {
                          document
                            .getElementById('forensic-bundle-verifier')
                            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }, 80);
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-bold text-main transition cursor-pointer"
                    >
                      <ShieldCheck className="w-3.5 h-3.5 text-accent" />
                      <span>Vérifier une archive (.zip)</span>
                    </button>
                  </div>
                </div>

                {/* Exports unitaires regroupés (11) — le dossier de preuve complet est l'action principale */}
                <div className="pt-3 border-t border-hairline grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-3">
                  <div>
                    <h4 className="px-3 text-xs font-semibold text-sub">Réglementaire</h4>
                    <div className="mt-1 space-y-0.5">
                  <button
                    type="button"
                    disabled={isExportingAnssi}
                    onClick={() => {
                      setPreviewSection('regulatory');
                      void exportAnssiDraft();
                    }}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    {isExportingAnssi ? (
                      <Loader2 className="w-3 h-3 animate-spin text-accent" />
                    ) : (
                      <ShieldAlert className="w-3 h-3 text-[var(--warning-text)]" />
                    )}
                    <span className="flex-1 min-w-0 truncate">Pré-notification ANSSI</span><span className="text-xs text-sub">.md</span>
                  </button>
                  <button
                    type="button"
                    disabled={isExportingCnilDraft}
                    onClick={() => {
                      setPreviewSection('regulatory');
                      void exportCnilDraft();
                    }}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    {isExportingCnilDraft ? (
                      <Loader2 className="w-3 h-3 animate-spin text-accent" />
                    ) : (
                      <FileCheck2 className="w-3 h-3 text-[var(--warning-text)]" />
                    )}
                    <span className="flex-1 min-w-0 truncate">Évaluation CNIL</span><span className="text-xs text-sub">.md</span>
                  </button>
                  <button
                    type="button"
                    disabled={isExportingComex}
                    onClick={() => {
                      setPreviewSection('regulatory');
                      void exportComexBrief();
                    }}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    {isExportingComex ? (
                      <Loader2 className="w-3 h-3 animate-spin text-accent" />
                    ) : (
                      <Scale className="w-3 h-3 text-accent" />
                    )}
                    <span className="flex-1 min-w-0 truncate">Brief COMEX</span><span className="text-xs text-sub">.md</span>
                  </button>
                    </div>
                  </div>
                  <div>
                    <h4 className="px-3 text-xs font-semibold text-sub">Mission</h4>
                    <div className="mt-1 space-y-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      downloadFile(
                        `Rapport_NIS2_Valmont_${mode}.md`,
                        reportMarkdown,
                        'text/markdown;charset=utf-8'
                      )
                    }
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    <Download className="w-3 h-3 text-accent" />
                    <span className="flex-1 min-w-0 truncate">Rapport d’audit</span><span className="text-xs text-sub">.md</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadFile(
                        `Mail_Suivi_DSI_${mode}.txt`,
                        mailText,
                        'text/plain;charset=utf-8'
                      )
                    }
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    <Mail className="w-3 h-3 text-accent" />
                    <span className="flex-1 min-w-0 truncate">Courriel au DSI</span><span className="text-xs text-sub">.txt</span>
                  </button>
                  <button
                    type="button"
                    disabled={isExportingInterviewGuide}
                    onClick={() => {
                      setPreviewSection('regulatory');
                      void exportInterviewGuide();
                    }}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    {isExportingInterviewGuide ? (
                      <Loader2 className="w-3 h-3 animate-spin text-accent" />
                    ) : (
                      <MessageSquareQuote className="w-3 h-3 text-accent" />
                    )}
                    <span className="flex-1 min-w-0 truncate">Guide d’entretien contradictoire</span><span className="text-xs text-sub">.md</span>
                  </button>
                  <button
                    type="button"
                    disabled={isExportingRiskRegister}
                    onClick={() => {
                      setPreviewSection('regulatory');
                      void exportRiskRegister();
                    }}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    {isExportingRiskRegister ? (
                      <Loader2 className="w-3 h-3 animate-spin text-accent" />
                    ) : (
                      <ClipboardList className="w-3 h-3 text-accent" />
                    )}
                    <span className="flex-1 min-w-0 truncate">Registre des arbitrages GRC</span><span className="text-xs text-sub">.md</span>
                  </button>
                    </div>
                  </div>
                  <div>
                    <h4 className="px-3 text-xs font-semibold text-sub">Données et preuves</h4>
                    <div className="mt-1 space-y-0.5">
                  <button
                    type="button"
                    onClick={exportSealedJson}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    <Download className="w-3 h-3 text-accent" />
                    <span className="flex-1 min-w-0 truncate">Synthèse scellée</span><span className="text-xs text-sub">.json</span>
                  </button>
                  <button
                    type="button"
                    onClick={exportSealedCsv}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    <Download className="w-3 h-3 text-accent" />
                    <span className="flex-1 min-w-0 truncate">Matrice GRC</span><span className="text-xs text-sub">.csv</span>
                  </button>
                    </div>
                  </div>
                  <div>
                    <h4 className="px-3 text-xs font-semibold text-sub">Remédiation</h4>
                    <div className="mt-1 space-y-0.5">
                  <button
                    type="button"
                    disabled={isExportingTerraform}
                    onClick={() => {
                      setPreviewSection('regulatory');
                      void exportTerraformManifest();
                    }}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    {isExportingTerraform ? (
                      <Loader2 className="w-3 h-3 animate-spin text-accent" />
                    ) : (
                      <FileCode2 className="w-3 h-3 text-[var(--info-text)]" />
                    )}
                    <span className="flex-1 min-w-0 truncate">Manifeste Terraform</span><span className="text-xs text-sub">.tf</span>
                  </button>
                  <button
                    type="button"
                    onClick={exportDryRunPlaybook}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-50 text-sm text-main text-left transition cursor-pointer"
                  >
                    <Terminal className="w-3 h-3 text-accent" />
                    <span className="flex-1 min-w-0 truncate">Playbook gcloud</span><span className="text-xs text-sub">.sh</span>
                  </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sélecteur de vue d'aperçu à la demande */}
              <div
                role="tablist"
                aria-label="Sélecteur de vue d'aperçu des livrables"
                className="surface-panel rounded-2xl p-1.5 inline-flex flex-wrap items-center gap-1.5"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewSection === 'regulatory'}
                  onClick={() => setPreviewSection('regulatory')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                    previewSection === 'regulatory'
                      ? 'seg-active'
                      : 'text-sub hover:text-main'
                  }`}
                >
                  <Scale className="w-3.5 h-3.5" />
                  <span>Livrables Réglementaires (6)</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewSection === 'report'}
                  onClick={() => setPreviewSection('report')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                    previewSection === 'report'
                      ? 'seg-active'
                      : 'text-sub hover:text-main'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Rapport Exécutif A4</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewSection === 'mail'}
                  onClick={() => setPreviewSection('mail')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                    previewSection === 'mail'
                      ? 'seg-active'
                      : 'text-sub hover:text-main'
                  }`}
                >
                  <Mail className="w-3.5 h-3.5" />
                  <span>Courriel DSI</span>
                </button>
              </div>

              {/* VUE 2 (toujours montée dans le DOM pour window.print()) : FEUILLE A4 EXÉCUTIVE */}
              <div
                id="printable-report"
                className={`${
                  previewSection === 'report'
                    ? 'block max-w-5xl mx-auto'
                    : 'hidden print:block'
                } bg-white text-slate-900 rounded-2xl shadow-xl border border-slate-200 overflow-hidden`}
              >
                  <div className="bg-[var(--bg-rail)] text-white px-8 py-6 border-b-4 border-[var(--deloitte)] flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold text-sub text-[var(--accent-text)]">
                        Rapport d&apos;Audit de Conformité Cybersécurité • NIS2
                      </div>
                      <h2 className="text-2xl font-extrabold mt-1">
                        {synthesis.client}
                      </h2>
                      <p className="text-xs text-slate-400 mt-1">
                        Méthodologie contradictoire TRIAD (Dit × Écrit × Réel Cloud) • Phase {mode}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="inline-block px-3 py-1 rounded-full text-[11px] font-extrabold bg-[var(--deloitte)] text-black">
                        VALIDÉ PAR CONSULTANT ✓
                      </span>
                      <div className="text-[10px] font-mono text-slate-400 mt-2">
                        Empreinte : #{latestHash.slice(0, 16)}
                      </div>
                    </div>
                  </div>

                  <div className="p-8 space-y-6">
                    {/* 1. Top 3 risques */}
                    <div className="print-avoid-break">
                      <h3 className="text-sm font-semibold text-slate-500 mb-2.5">
                        1. Synthèse Direction Générale — Top 3 Risques Majeurs
                      </h3>
                      <div className="space-y-2">
                        {synthesis.top_3_risques.map((r, i) => (
                          <div
                            key={i}
                            className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-800 flex gap-2.5"
                          >
                            <span className="font-mono font-extrabold text-[#457009]">
                              0{i + 1}.
                            </span>
                            <span>{r}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Récapitulatif Comparatif AVANT vs APRÈS (affiché dès que les deux phases existent) */}
                    {comparisonSummary && (
                      <div className="print-avoid-break space-y-3">
                        <h3 className="text-sm font-semibold text-slate-500">
                          2. Trajectoire Contradictoire AVANT vs APRÈS Entretien DSI
                        </h3>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                            <div className="text-[10px] font-bold text-slate-500">
                              Indice Maturité
                            </div>
                            <div className="font-mono text-sm font-extrabold text-slate-900 mt-0.5 tabular-nums">
                              {comparisonSummary.scoreAvant}% → {comparisonSummary.scoreApres}% (
                              {comparisonSummary.scoreDelta >= 0
                                ? `+${comparisonSummary.scoreDelta}`
                                : comparisonSummary.scoreDelta}{' '}
                              pts)
                            </div>
                          </div>
                          <div className="p-3 rounded-xl bg-[var(--critical-bg)] border border-[var(--critical-border)]">
                            <div className="text-[10px] font-bold text-[var(--critical-text)]">
                              Ruptures du Dit
                            </div>
                            <div className="font-mono text-sm font-extrabold text-[var(--critical-text)] mt-0.5 tabular-nums">
                              {comparisonSummary.ditContradictionsCount} dévoilée(s)
                            </div>
                          </div>
                          <div className="p-3 rounded-xl bg-[var(--warning-bg)] border border-[var(--warning-border)]">
                            <div className="text-[10px] font-bold text-[var(--warning-text)]">
                              Nouveaux Écarts
                            </div>
                            <div className="font-mono text-sm font-extrabold text-[var(--warning-text)] mt-0.5 tabular-nums">
                              +{comparisonSummary.newGapsCount} post-entretien
                            </div>
                          </div>
                          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                            <div className="text-[10px] font-bold text-slate-500">
                              Écarts Confirmés
                            </div>
                            <div className="font-mono text-sm font-extrabold text-slate-900 mt-0.5 tabular-nums">
                              {comparisonSummary.confirmedGapsCount} persistant(s)
                            </div>
                          </div>
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-slate-200">
                          <table className="w-full text-left text-[11px]">
                            <thead className="bg-[var(--bg-subtle)] text-[10px] text-slate-600 border-b border-slate-200">
                              <tr>
                                <th className="p-2.5">Réf.</th>
                                <th className="p-2.5">Domaine NIS2</th>
                                <th className="p-2.5">Évolution AVANT → APRÈS</th>
                                <th className="p-2.5">Qualification</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200">
                              {comparisonSummary.items.map((item) => (
                                <tr key={item.key} className="print-avoid-break">
                                  <td className="p-2.5 font-mono font-extrabold text-slate-900">
                                    {item.id}
                                  </td>
                                  <td className="p-2.5 font-semibold text-slate-800">
                                    {item.theme}
                                  </td>
                                  <td className="p-2.5 font-mono text-[10px] text-slate-600">
                                    {item.avant ? item.avant.statut : 'absent'} →{' '}
                                    {item.apres ? item.apres.statut : 'absent'}
                                  </td>
                                  <td className="p-2.5 font-bold text-slate-900">
                                    {item.apres?.contradiction || item.categoryLabel}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Matrice des constats détaillés */}
                    <div>
                      <h3 className="text-sm font-semibold text-slate-500 mb-2.5">
                        {comparisonSummary ? '3.' : '2.'} Matrice Détaillée des Constats (Dit × Écrit × Réel)
                      </h3>
                      <div className="space-y-3">
                        {synthesis.findings.map((f) => (
                          <div
                            key={f.id}
                            className="print-avoid-break p-4 rounded-xl border border-slate-200 space-y-2"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="font-bold text-sm text-slate-900">
                                {f.id} — {f.theme}{' '}
                                <span className="text-xs font-normal text-slate-500">
                                  ({f.exigence_nis2})
                                </span>
                              </div>
                              <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-900 text-white">
                                {f.statut} • {f.gravite}
                              </span>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-slate-700 pt-1">
                              <div className="bg-slate-50 p-2.5 rounded-lg">
                                <strong className="text-slate-900">Dit :</strong>{' '}
                                {f.dit ? `« ${f.dit.extrait} »` : 'N/A'}
                              </div>
                              <div className="bg-slate-50 p-2.5 rounded-lg">
                                <strong className="text-slate-900">Écrit :</strong>{' '}
                                {f.ecrit ? `« ${f.ecrit.extrait} »` : 'N/A'}
                              </div>
                              <div className="bg-slate-50 p-2.5 rounded-lg">
                                <strong className="text-slate-900">Réel :</strong>{' '}
                                {f.reel ? f.reel.constat : 'Organisationnel'}
                              </div>
                            </div>
                            <div className="text-xs text-slate-800 pt-1">
                              <strong>Action corrective :</strong> {f.recommandation}
                            </div>
                            {f.decision_grc && (
                              <div className="text-[11px] bg-[var(--bg-subtle)] border border-slate-200 rounded-lg px-3 py-2 text-slate-800">
                                <strong>Arbitrage GRC :</strong>{' '}
                                {f.decision_grc.decision_label}
                                {f.decision_grc.porteur
                                  ? ` • Porteur : ${f.decision_grc.porteur}`
                                  : ''}
                                {f.decision_grc.echeance
                                  ? ` • Échéance : ${f.decision_grc.echeance}`
                                  : ''}
                                {f.decision_grc.commentaire
                                  ? ` — ${f.decision_grc.commentaire}`
                                  : ''}
                              </div>
                            )}
                            {f.commande_correction && (
                              <pre className="p-2.5 rounded-lg bg-slate-900 text-[var(--accent-text)] font-mono text-[10px] overflow-x-auto">
                                {f.commande_correction}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Synthèse Tabulaire du Plan d'Action 30 / 60 / 90 Jours */}
                    {printableRoadmapItems.length > 0 && (
                      <div className="print-avoid-break space-y-2.5">
                        <h3 className="text-sm font-semibold text-slate-500">
                          {comparisonSummary ? '4.' : '3.'} Feuille de Route Opérationnelle 30 / 60 / 90 Jours
                        </h3>
                        <div className="overflow-x-auto rounded-xl border border-slate-200">
                          <table className="w-full text-left text-[11px]">
                            <thead className="bg-[var(--bg-subtle)] text-[10px] text-slate-600 border-b border-slate-200">
                              <tr>
                                <th className="p-2.5">Horizon</th>
                                <th className="p-2.5">Constat</th>
                                <th className="p-2.5">Charge &amp; Porteur</th>
                                <th className="p-2.5">Action Prioritaire</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200">
                              {printableRoadmapItems.map((it) => (
                                <tr key={it.finding.id} className="print-avoid-break">
                                  <td className="p-2.5 font-mono font-extrabold text-[10px] whitespace-nowrap text-[#457009]">
                                    {HORIZON_META[it.horizon].badge}
                                  </td>
                                  <td className="p-2.5 font-semibold text-slate-900">
                                    <div>
                                      {it.finding.id} — {it.finding.theme}
                                    </div>
                                    <div className="text-[10px] text-slate-500 font-normal">
                                      {it.finding.exigence_nis2}
                                    </div>
                                  </td>
                                  <td className="p-2.5 text-slate-700 whitespace-nowrap">
                                    <div className="font-mono font-bold text-[10px]">
                                      {it.workloadEstimate}
                                    </div>
                                    <div className="text-[10px] text-slate-500">
                                      {it.ownerRole}
                                    </div>
                                  </td>
                                  <td className="p-2.5 text-slate-800">
                                    {it.finding.recommandation}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Bloc compact de Synthèse de Couverture Réglementaire NIS2 (Art. 21 & 23) */}
                    {nis2CoverageReport && (
                      <div className="print-avoid-break space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold text-slate-500">
                            {comparisonSummary
                              ? printableRoadmapItems.length > 0
                                ? '5.'
                                : '4.'
                              : printableRoadmapItems.length > 0
                              ? '4.'
                              : '3.'}{' '}
                            Synthèse de Couverture Réglementaire NIS2 (Art. 21 &amp; 23)
                          </h3>
                          <span className="font-mono text-[11px] font-extrabold text-[#457009] tabular-nums">
                            Couverture : {nis2CoverageReport.coverageRatePct}% (
                            {nis2CoverageReport.coveredCount}/
                            {nis2CoverageReport.totalRequirements} exigences évaluées)
                          </span>
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-slate-200">
                          <table className="w-full text-left text-[11px]">
                            <thead className="bg-[var(--bg-subtle)] text-[10px] text-slate-600 border-b border-slate-200">
                              <tr>
                                <th className="p-2">Article</th>
                                <th className="p-2">Exigence Directive (UE) 2022/2555</th>
                                <th className="p-2">Statut</th>
                                <th className="p-2 text-right">Constats</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200">
                              {nis2CoverageReport.items.map((item) => {
                                const meta = COVERAGE_STATUS_META[item.statut];
                                return (
                                  <tr key={item.id} className="print-avoid-break">
                                    <td className="p-2 font-mono font-extrabold text-slate-900 whitespace-nowrap">
                                      {item.article}
                                    </td>
                                    <td className="p-2 text-slate-800">
                                      {item.intitule_resume}
                                    </td>
                                    <td className="p-2 whitespace-nowrap">
                                      <span
                                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${meta.printCls}`}
                                      >
                                        {meta.label}
                                      </span>
                                    </td>
                                    <td className="p-2 text-right font-mono text-[10px] font-bold text-slate-700 whitespace-nowrap">
                                      {item.finding_ids.length > 0
                                        ? item.finding_ids.join(', ')
                                        : '—'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Pied de page de scellement cryptographique */}
                    <div className="print-avoid-break pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-500">
                      <span>
                        Registre d&apos;audit SHA-256 : {auditLog.length} bloc(s) vérifié(s) • Aucune écriture Cloud exécutée
                      </span>
                      <span>SHA-256 : {latestHash.slice(0, 32)}…</span>
                    </div>
                  </div>
                </div>

              {/* VUE 3 (à la demande) : COURRIEL DSI */}
              {previewSection === 'mail' && (
                <div className="surface-panel rounded-2xl overflow-hidden max-w-4xl mx-auto">
                  <div className="p-4 border-b border-hairline flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-accent" />
                      <h3 className="text-sm font-extrabold text-main">
                        Courriel DSI ({synthesis.client || 'CH de Valmont'})
                      </h3>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => copyText('mail', mailText)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-card text-xs font-bold text-main cursor-pointer"
                      >
                        {copiedKey === 'mail' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-accent" />
                            <span>Copié</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copier</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          downloadFile(
                            `Mail_Suivi_DSI_${mode}.txt`,
                            mailText,
                            'text/plain;charset=utf-8'
                          )
                        }
                        className="p-1.5 rounded-lg surface-card text-sub hover:text-main cursor-pointer"
                        title="Télécharger en .txt"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="px-4 py-2.5 surface-subtle border-b border-hairline text-xs flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] font-bold text-dim">
                      Objet :
                    </span>
                    <span className="font-semibold text-main">
                      {parsedMail.subject}
                    </span>
                  </div>

                  <div className="p-5 text-xs text-main whitespace-pre-wrap leading-relaxed max-h-[540px] overflow-y-auto">
                    {parsedMail.body ||
                      "Basculez en phase APRÈS pour générer le courriel post-entretien."}
                  </div>
                </div>
              )}

              {/* VUE 1 (par défaut) : LIVRABLES RÉGLEMENTAIRES PLEINE LARGEUR (6 onglets) */}
              {previewSection === 'regulatory' && (
                <div
                  id="anssi-draft-preview"
                  className={`surface-panel rounded-2xl overflow-hidden border ${
                    regulatoryDocTab === 'comex' ||
                    regulatoryDocTab === 'interview' ||
                    regulatoryDocTab === 'grc'
                      ? 'border-[var(--deloitte)]/35'
                      : regulatoryDocTab === 'terraform'
                      ? 'border-[var(--info-border)]'
                      : 'border-[var(--warning-border)]'
                  }`}
                >
                  {/* Sélecteur de livrable réglementaire, GitOps, Contradictoire, GRC & CNIL (6 onglets) */}
                  <div
                    role="tablist"
                    aria-label="Livrables réglementaires, GitOps, contradictoires, GRC et CNIL NIS2"
                    className="px-3 pt-3 pb-2 border-b border-hairline surface-subtle flex flex-wrap items-center gap-1.5"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={regulatoryDocTab === 'anssi'}
                      onClick={() => setRegulatoryDocTab('anssi')}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                        regulatoryDocTab === 'anssi'
                          ? 'seg-active'
                          : 'surface-card text-sub hover:text-main'
                      }`}
                    >
                      <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                      <span>Pré-Notification ANSSI (Art. 23)</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={regulatoryDocTab === 'comex'}
                      onClick={() => setRegulatoryDocTab('comex')}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                        regulatoryDocTab === 'comex'
                          ? 'seg-active'
                          : 'surface-card text-sub hover:text-main'
                      }`}
                    >
                      <Scale className="w-3.5 h-3.5 shrink-0" />
                      <span>Brief COMEX (Art. 20)</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={regulatoryDocTab === 'terraform'}
                      onClick={() => setRegulatoryDocTab('terraform')}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                        regulatoryDocTab === 'terraform'
                          ? 'bg-[var(--info-text)] text-black shadow-sm'
                          : 'surface-card text-sub hover:text-main'
                      }`}
                    >
                      <FileCode2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Manifeste Terraform (.tf)</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={regulatoryDocTab === 'interview'}
                      onClick={() => setRegulatoryDocTab('interview')}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                        regulatoryDocTab === 'interview'
                          ? 'seg-active'
                          : 'surface-card text-sub hover:text-main'
                      }`}
                    >
                      <MessageSquareQuote className="w-3.5 h-3.5 shrink-0" />
                      <span>Guide d&apos;Entretien (.md)</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={regulatoryDocTab === 'grc'}
                      onClick={() => setRegulatoryDocTab('grc')}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                        regulatoryDocTab === 'grc'
                          ? 'seg-active'
                          : 'surface-card text-sub hover:text-main'
                      }`}
                    >
                      <ClipboardList className="w-3.5 h-3.5 shrink-0" />
                      <span>Registre GRC (.md)</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={regulatoryDocTab === 'cnil'}
                      onClick={() => setRegulatoryDocTab('cnil')}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                        regulatoryDocTab === 'cnil'
                          ? 'seg-active'
                          : 'surface-card text-sub hover:text-main'
                      }`}
                    >
                      <FileCheck2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Évaluation CNIL Art. 33 (.md)</span>
                    </button>
                  </div>

                  <div className="p-4 border-b border-hairline flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {regulatoryDocTab === 'comex' ? (
                        <Scale className="w-4 h-4 text-accent shrink-0" />
                      ) : regulatoryDocTab === 'terraform' ? (
                        <FileCode2 className="w-4 h-4 text-[var(--info-text)] shrink-0" />
                      ) : regulatoryDocTab === 'interview' ? (
                        <MessageSquareQuote className="w-4 h-4 text-accent shrink-0" />
                      ) : regulatoryDocTab === 'grc' ? (
                        <ClipboardList className="w-4 h-4 text-accent shrink-0" />
                      ) : regulatoryDocTab === 'cnil' ? (
                        <FileCheck2 className="w-4 h-4 text-[var(--warning-text)] shrink-0" />
                      ) : (
                        <ShieldAlert className="w-4 h-4 text-[var(--warning-text)] shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="text-sm font-extrabold text-main truncate">
                            {regulatoryDocTab === 'comex'
                              ? 'Brief COMEX — Gouvernance Art. 20'
                              : regulatoryDocTab === 'terraform'
                              ? 'Manifeste Terraform GitOps GCP (.tf)'
                              : regulatoryDocTab === 'interview'
                              ? "Guide d'Entretien Contradictoire (.md)"
                              : regulatoryDocTab === 'grc'
                              ? "Registre d'Homologation & Arbitrages GRC (.md)"
                              : regulatoryDocTab === 'cnil'
                              ? 'Évaluation Pré-Notification CNIL — RGPD Art. 33 & 34'
                              : 'Pré-Notification ANSSI (Art. 23)'}
                          </h3>
                          <span
                            className={`${
                              regulatoryDocTab === 'comex' ||
                              regulatoryDocTab === 'interview' ||
                              regulatoryDocTab === 'grc'
                                ? 'badge-success'
                                : regulatoryDocTab === 'terraform'
                                ? 'badge-info'
                                : 'badge-warning'
                            } px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0`}
                          >
                            {regulatoryDocTab === 'comex'
                              ? 'Art. 20 & 34'
                              : regulatoryDocTab === 'terraform'
                              ? 'HCL GitOps'
                              : regulatoryDocTab === 'interview'
                              ? '4 Panels'
                              : regulatoryDocTab === 'grc'
                              ? 'Homologation'
                              : regulatoryDocTab === 'cnil'
                              ? 'RGPD 72h'
                              : 'NIS2 §4'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <div
                        role="group"
                        aria-label="Mode d'affichage du livrable réglementaire"
                        className="inline-flex surface-subtle p-0.5 rounded-lg"
                      >
                        <button
                          type="button"
                          aria-pressed={anssiViewMode === 'formatted'}
                          onClick={() => setAnssiViewMode('formatted')}
                          className={`px-2 py-1 rounded-md text-[10px] font-bold transition cursor-pointer ${
                            anssiViewMode === 'formatted'
                              ? 'seg-active'
                              : 'text-sub hover:text-main'
                          }`}
                        >
                          Aperçu
                        </button>
                        <button
                          type="button"
                          aria-pressed={anssiViewMode === 'raw'}
                          onClick={() => setAnssiViewMode('raw')}
                          className={`px-2 py-1 rounded-md text-[10px] font-bold transition cursor-pointer ${
                            anssiViewMode === 'raw'
                              ? 'seg-active'
                              : 'text-sub hover:text-main'
                          }`}
                        >
                          {regulatoryDocTab === 'terraform'
                            ? 'Source .tf'
                            : 'Source .md'}
                        </button>
                      </div>

                      <button
                        type="button"
                        disabled={
                          regulatoryDocTab === 'comex'
                            ? !effectiveComexBrief
                            : regulatoryDocTab === 'terraform'
                            ? !effectiveTerraformHcl
                            : regulatoryDocTab === 'interview'
                            ? !effectiveInterviewGuide
                            : regulatoryDocTab === 'grc'
                            ? !effectiveRiskRegister
                            : regulatoryDocTab === 'cnil'
                            ? !effectiveCnilDraft
                            : !effectiveAnssiDraft
                        }
                        onClick={() =>
                          regulatoryDocTab === 'comex'
                            ? copyText(
                                'comex',
                                effectiveComexBrief,
                                'Brief COMEX Art. 20 prêt à être partagé au Comité Exécutif'
                              )
                            : regulatoryDocTab === 'terraform'
                            ? copyText(
                                'terraform',
                                effectiveTerraformHcl,
                                'Manifeste HCL Terraform prêt pour Pull Request GitOps'
                              )
                            : regulatoryDocTab === 'interview'
                            ? copyText(
                                'interview',
                                effectiveInterviewGuide,
                                "Guide d'Entretien Contradictoire prêt pour les auditions DSI / RSSI / Achats"
                              )
                            : regulatoryDocTab === 'grc'
                            ? copyText(
                                'grc',
                                effectiveRiskRegister,
                                "Registre d'Arbitrages GRC prêt pour comité d'homologation sécurité"
                              )
                            : regulatoryDocTab === 'cnil'
                            ? copyText(
                                'cnil',
                                effectiveCnilDraft,
                                'Fiche d’évaluation CNIL RGPD Art. 33 prête pour le DPO'
                              )
                            : copyText(
                                'anssi',
                                effectiveAnssiDraft,
                                'Brouillon de pré-notification ANSSI Art. 23 prêt à être collé'
                              )
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-card disabled:opacity-50 text-xs font-bold text-main cursor-pointer"
                      >
                        {copiedKey === regulatoryDocTab ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-accent" />
                            <span>Copié</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copier</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        disabled={
                          regulatoryDocTab === 'comex'
                            ? isExportingComex
                            : regulatoryDocTab === 'terraform'
                            ? isExportingTerraform
                            : regulatoryDocTab === 'interview'
                            ? isExportingInterviewGuide
                            : regulatoryDocTab === 'grc'
                            ? isExportingRiskRegister
                            : regulatoryDocTab === 'cnil'
                            ? isExportingCnilDraft
                            : isExportingAnssi
                        }
                        onClick={
                          regulatoryDocTab === 'comex'
                            ? exportComexBrief
                            : regulatoryDocTab === 'terraform'
                            ? exportTerraformManifest
                            : regulatoryDocTab === 'interview'
                            ? exportInterviewGuide
                            : regulatoryDocTab === 'grc'
                            ? exportRiskRegister
                            : regulatoryDocTab === 'cnil'
                            ? exportCnilDraft
                            : exportAnssiDraft
                        }
                        className="p-1.5 rounded-lg surface-card hover:border-[var(--deloitte)] disabled:opacity-50 text-sub hover:text-main cursor-pointer"
                        title={
                          regulatoryDocTab === 'comex'
                            ? 'Télécharger Brief COMEX Art. 20 (.md)'
                            : regulatoryDocTab === 'terraform'
                            ? 'Télécharger Manifeste Terraform (.tf)'
                            : regulatoryDocTab === 'interview'
                            ? "Télécharger Guide d'Entretien (.md)"
                            : regulatoryDocTab === 'grc'
                            ? 'Télécharger Registre GRC (.md)'
                            : regulatoryDocTab === 'cnil'
                            ? 'Télécharger Évaluation CNIL Art. 33 (.md)'
                            : 'Télécharger Pré-Notification ANSSI (.md)'
                        }
                        aria-label={
                          regulatoryDocTab === 'comex'
                            ? 'Télécharger Brief COMEX Art. 20 (.md)'
                            : regulatoryDocTab === 'terraform'
                            ? 'Télécharger Manifeste Terraform (.tf)'
                            : regulatoryDocTab === 'interview'
                            ? "Télécharger Guide d'Entretien (.md)"
                            : regulatoryDocTab === 'grc'
                            ? 'Télécharger Registre GRC (.md)'
                            : regulatoryDocTab === 'cnil'
                            ? 'Télécharger Évaluation CNIL Art. 33 (.md)'
                            : 'Télécharger Pré-Notification ANSSI (.md)'
                        }
                      >
                        {(
                          regulatoryDocTab === 'comex'
                            ? isExportingComex
                            : regulatoryDocTab === 'terraform'
                            ? isExportingTerraform
                            : regulatoryDocTab === 'interview'
                            ? isExportingInterviewGuide
                            : regulatoryDocTab === 'grc'
                            ? isExportingRiskRegister
                            : regulatoryDocTab === 'cnil'
                            ? isExportingCnilDraft
                            : isExportingAnssi
                        ) ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Badges réglementaires synthétiques (zéro surcharge textuelle) */}
                  <div className="px-4 py-2 surface-subtle border-b border-hairline flex flex-wrap items-center gap-1.5">
                    {regulatoryDocTab === 'comex' ? (
                      <>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)]" />
                          Art. 20 • Direction Générale
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--rupture)]" />
                          Art. 34 §4 • 10 M€ / 2 % CA
                        </span>
                      </>
                    ) : regulatoryDocTab === 'terraform' ? (
                      <>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--info-text)]" />
                          Revue PR GitOps &amp; terraform plan
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)]" />
                          0 terraform apply auto
                        </span>
                      </>
                    ) : regulatoryDocTab === 'interview' ? (
                      <>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)]" />
                          DSI • Admin Cloud • RSSI / DPO • Achats
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning-text)]" />
                          Preuves attendues
                        </span>
                      </>
                    ) : regulatoryDocTab === 'grc' ? (
                      <>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)]" />
                          Art. 20 &amp; 21 §1 • Homologation
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning-text)]" />
                          Risques résiduels &amp; échéances
                        </span>
                      </>
                    ) : regulatoryDocTab === 'cnil' ? (
                      <>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--rupture)]" />
                          RGPD Art. 33 ≤ 72 h
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning-text)]" />
                          Art. 34 • HDS Art. 9
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--rupture)]" />
                          24 h • Alerte précoce
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning-text)]" />
                          72 h • Évaluation
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md surface-card text-[10px] font-bold text-main">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)]" />
                          1 mois • Rapport final
                        </span>
                      </>
                    )}
                  </div>

                  <div className="p-4 max-h-[540px] overflow-y-auto">
                    {regulatoryDocTab === 'comex' ? (
                      isLoadingComexPreview && !effectiveComexBrief ? (
                        <div className="py-8 flex items-center justify-center gap-2 text-xs text-sub">
                          <Loader2 className="w-4 h-4 animate-spin text-accent" />
                          <span>Assemblage du Brief COMEX Art. 20…</span>
                        </div>
                      ) : effectiveComexBrief ? (
                        anssiViewMode === 'formatted' ? (
                          renderAnssiMarkdownPreview(effectiveComexBrief)
                        ) : (
                          <pre className="font-mono text-[11px] text-main whitespace-pre-wrap break-words leading-relaxed">
                            {effectiveComexBrief}
                          </pre>
                        )
                      ) : (
                        <div className="py-4 text-center space-y-2.5">
                          <p className="text-xs text-sub">
                            Cliquez ci-dessous pour générer et télécharger le Brief COMEX Art. 20 (.md) scellé cryptographiquement.
                          </p>
                          <button
                            type="button"
                            disabled={isExportingComex}
                            onClick={exportComexBrief}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-extrabold text-main transition cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5 text-accent" />
                            <span>Brief COMEX Art. 20 (.md)</span>
                          </button>
                        </div>
                      )
                    ) : regulatoryDocTab === 'terraform' ? (
                      isLoadingTerraformPreview && !effectiveTerraformHcl ? (
                        <div className="py-8 flex items-center justify-center gap-2 text-xs text-sub">
                          <Loader2 className="w-4 h-4 animate-spin text-accent" />
                          <span>Assemblage du Manifeste Terraform GitOps (.tf)…</span>
                        </div>
                      ) : effectiveTerraformHcl ? (
                        anssiViewMode === 'formatted' ? (
                          renderTerraformHclPreview(effectiveTerraformHcl)
                        ) : (
                          <pre className="font-mono text-[11px] text-main whitespace-pre-wrap break-words leading-relaxed">
                            {effectiveTerraformHcl}
                          </pre>
                        )
                      ) : (
                        <div className="py-4 text-center space-y-2.5">
                          <p className="text-xs text-sub">
                            Cliquez ci-dessous pour générer et télécharger le Manifeste Terraform GitOps (.tf) scellé cryptographiquement.
                          </p>
                          <button
                            type="button"
                            disabled={isExportingTerraform}
                            onClick={exportTerraformManifest}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-extrabold text-main transition cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5 text-[var(--info-text)]" />
                            <span>Manifeste Terraform (.tf)</span>
                          </button>
                        </div>
                      )
                    ) : regulatoryDocTab === 'interview' ? (
                      isLoadingInterviewGuidePreview &&
                      !effectiveInterviewGuide ? (
                        <div className="py-8 flex items-center justify-center gap-2 text-xs text-sub">
                          <Loader2 className="w-4 h-4 animate-spin text-accent" />
                          <span>
                            Assemblage du Guide d&apos;Entretien Contradictoire (.md)…
                          </span>
                        </div>
                      ) : effectiveInterviewGuide ? (
                        anssiViewMode === 'formatted' ? (
                          renderAnssiMarkdownPreview(effectiveInterviewGuide)
                        ) : (
                          <pre className="font-mono text-[11px] text-main whitespace-pre-wrap break-words leading-relaxed">
                            {effectiveInterviewGuide}
                          </pre>
                        )
                      ) : (
                        <div className="py-4 text-center space-y-2.5">
                          <p className="text-xs text-sub">
                            Cliquez ci-dessous pour générer et télécharger le Guide d&apos;Entretien Contradictoire (.md) scellé cryptographiquement.
                          </p>
                          <button
                            type="button"
                            disabled={isExportingInterviewGuide}
                            onClick={exportInterviewGuide}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-extrabold text-main transition cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5 text-accent" />
                            <span>Guide d&apos;Entretien (.md)</span>
                          </button>
                        </div>
                      )
                    ) : regulatoryDocTab === 'grc' ? (
                      isLoadingRiskRegisterPreview && !effectiveRiskRegister ? (
                        <div className="py-8 flex items-center justify-center gap-2 text-xs text-sub">
                          <Loader2 className="w-4 h-4 animate-spin text-accent" />
                          <span>
                            Assemblage du Registre d&apos;Arbitrages GRC (.md)…
                          </span>
                        </div>
                      ) : effectiveRiskRegister ? (
                        anssiViewMode === 'formatted' ? (
                          renderAnssiMarkdownPreview(effectiveRiskRegister)
                        ) : (
                          <pre className="font-mono text-[11px] text-main whitespace-pre-wrap break-words leading-relaxed">
                            {effectiveRiskRegister}
                          </pre>
                        )
                      ) : (
                        <div className="py-4 text-center space-y-2.5">
                          <p className="text-xs text-sub">
                            Cliquez ci-dessous pour générer et télécharger le Registre d&apos;Arbitrages GRC &amp; Risques Résiduels (.md) scellé cryptographiquement.
                          </p>
                          <button
                            type="button"
                            disabled={isExportingRiskRegister}
                            onClick={exportRiskRegister}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-extrabold text-main transition cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5 text-accent" />
                            <span>Registre GRC (.md)</span>
                          </button>
                        </div>
                      )
                    ) : regulatoryDocTab === 'cnil' ? (
                      isLoadingCnilPreview && !effectiveCnilDraft ? (
                        <div className="py-8 flex items-center justify-center gap-2 text-xs text-sub">
                          <Loader2 className="w-4 h-4 animate-spin text-accent" />
                          <span>
                            Assemblage de l&apos;Évaluation CNIL RGPD Art. 33 (.md)…
                          </span>
                        </div>
                      ) : effectiveCnilDraft ? (
                        anssiViewMode === 'formatted' ? (
                          renderAnssiMarkdownPreview(effectiveCnilDraft)
                        ) : (
                          <pre className="font-mono text-[11px] text-main whitespace-pre-wrap break-words leading-relaxed">
                            {effectiveCnilDraft}
                          </pre>
                        )
                      ) : (
                        <div className="py-4 text-center space-y-2.5">
                          <p className="text-xs text-sub">
                            Cliquez ci-dessous pour générer et télécharger l&apos;Évaluation CNIL RGPD Art. 33 &amp; 34 (.md) scellée cryptographiquement.
                          </p>
                          <button
                            type="button"
                            disabled={isExportingCnilDraft}
                            onClick={exportCnilDraft}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-extrabold text-main transition cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5 text-[var(--warning-text)]" />
                            <span>Évaluation CNIL Art. 33 (.md)</span>
                          </button>
                        </div>
                      )
                    ) : isLoadingAnssiPreview && !effectiveAnssiDraft ? (
                      <div className="py-8 flex items-center justify-center gap-2 text-xs text-sub">
                        <Loader2 className="w-4 h-4 animate-spin text-accent" />
                        <span>Assemblage du brouillon réglementaire ANSSI Art. 23…</span>
                      </div>
                    ) : effectiveAnssiDraft ? (
                      anssiViewMode === 'formatted' ? (
                        renderAnssiMarkdownPreview(effectiveAnssiDraft)
                      ) : (
                        <pre className="font-mono text-[11px] text-main whitespace-pre-wrap break-words leading-relaxed">
                          {effectiveAnssiDraft}
                        </pre>
                      )
                    ) : (
                      <div className="py-4 text-center space-y-2.5">
                        <p className="text-xs text-sub">
                          Cliquez ci-dessous pour générer et télécharger la Pré-Notification ANSSI Art. 23 scellée SHA-256.
                        </p>
                        <button
                          type="button"
                          disabled={isExportingAnssi}
                          onClick={exportAnssiDraft}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] text-xs font-extrabold text-main transition cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5 text-accent" />
                          <span>Pré-Notification ANSSI (.md)</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* VOLET PLAN D'ACTION OPÉRATIONNEL 30 / 60 / 90 JOURS */}
      {subTab === 'roadmap' && (
        <RemediationRoadmap
          findings={synthesis?.findings || []}
          clientName={synthesis?.client || 'Centre Hospitalier de Valmont'}
          mode={mode}
          validated={validated}
          onSelectFinding={onSelectFinding}
          onExportPlaybook={exportDryRunPlaybook}
          onRequestValidationTab={() => setSubTab('deliverables')}
          onNotify={onNotify}
        />
      )}

      {/* VOLET 2 : POSTURE & PERMISSIONS (DOUANIER) */}
      {subTab === 'douanier' && (
        <div className="space-y-4">
          {/* Posture d'Auto-Sécurité condensée (/api/security/posture) */}
          <section
            aria-label="Posture d'Auto-Sécurité TRIAD"
            className="surface-panel rounded-2xl p-5 space-y-4 border border-[var(--deloitte)]/30"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-hairline">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm sm:text-base font-extrabold text-main">
                  Posture d&apos;Auto-Sécurité
                </h3>
                {securityPosture && (
                  <span className="badge-success inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold">
                    <ShieldCheck className="w-3 h-3" />
                    {securityPosture.status}
                  </span>
                )}
                <span className="badge-warning px-2.5 py-0.5 rounded-full font-mono text-[10px] font-extrabold">
                  {securityPosture?.locked_exports_count ?? 12} verrous humains HTTP 403
                </span>
                {securityPosture && (
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${
                      securityPosture.hmac_signing_enabled
                        ? 'badge-success'
                        : 'surface-subtle text-sub border border-hairline'
                    }`}
                  >
                    <KeyRound className="w-3 h-3" />
                    <span>
                      {securityPosture.hmac_signing_enabled
                        ? 'HMAC-SHA256 : ACTIF ✓'
                        : 'HMAC-SHA256 : UNSIGNED'}
                    </span>
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={isDownloadingSbom}
                  onClick={() => void downloadRuntimeSbom()}
                  title="Télécharger l'attestation logicielle SBOM CycloneDX 1.5 (.json) (/api/security/sbom)"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] disabled:opacity-50 text-xs font-extrabold text-main transition cursor-pointer"
                >
                  {isDownloadingSbom ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                  ) : (
                    <FileCode2 className="w-3.5 h-3.5 text-accent" />
                  )}
                  <span>SBOM CycloneDX 1.5 (.json)</span>
                </button>
                <button
                  type="button"
                  disabled={isLoadingPosture}
                  onClick={() => void refreshSecurityPosture()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] disabled:opacity-50 text-xs font-bold text-main transition cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 text-accent ${
                      isLoadingPosture ? 'animate-spin' : ''
                    }`}
                  />
                  <span>Actualiser</span>
                </button>
              </div>
            </div>

            {isLoadingPosture && !securityPosture ? (
              <div className="py-5 flex items-center justify-center gap-2 text-xs text-sub">
                <Loader2 className="w-4 h-4 animate-spin text-accent" />
                <span>Chargement…</span>
              </div>
            ) : securityPosture ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                {securityPosture.barriers.map((barrier) => {
                  const isOpen = Boolean(expandedBarriers[barrier.id]);
                  return (
                    <button
                      key={barrier.id}
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpandedBarriers((prev) => ({
                          ...prev,
                          [barrier.id]: !prev[barrier.id],
                        }))
                      }
                      className={`text-left surface-card hover:border-strong rounded-xl p-3 border transition cursor-pointer ${
                        barrier.active
                          ? 'border-hairline'
                          : 'border-[var(--warning-border)]'
                      } space-y-1.5`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-sub">
                          {barrier.category}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${
                              barrier.active
                                ? 'badge-success'
                                : 'surface-subtle text-sub border border-hairline'
                            }`}
                          >
                            {barrier.status_label}
                          </span>
                          {barrier.detail && (
                            <ChevronDown
                              className={`w-3.5 h-3.5 text-sub transition-transform ${
                                isOpen ? 'rotate-180 text-accent' : ''
                              }`}
                            />
                          )}
                        </div>
                      </div>
                      <div className="text-xs font-extrabold text-main leading-snug">
                        {barrier.label}
                      </div>
                      {isOpen && barrier.detail && (
                        <p className="text-[11px] text-sub pt-2 border-t border-hairline leading-relaxed">
                          {barrier.detail}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-sub py-4 text-center">
                Posture indisponible — cliquez sur « Actualiser ».
              </p>
            )}
          </section>

          {/* Sous-bascule Sas DLP Douanier / Matrice des Droits */}
          <div
            role="tablist"
            aria-label="Sous-vues Sas DLP Douanier et Matrice des Droits"
            className="surface-panel rounded-2xl p-1.5 inline-flex flex-wrap items-center gap-1.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={douanierInnerTab === 'dlp'}
              onClick={() => setDouanierInnerTab('dlp')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                douanierInnerTab === 'dlp'
                  ? 'seg-active'
                  : 'text-sub hover:text-main'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Sas DLP Douanier ({docs.length})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={douanierInnerTab === 'matrix'}
              onClick={() => setDouanierInnerTab('matrix')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                douanierInnerTab === 'matrix'
                  ? 'seg-active'
                  : 'text-sub hover:text-main'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Matrice des Droits ({PERMISSION_MATRIX.length})</span>
            </button>
          </div>

          {douanierInnerTab === 'dlp' ? (
            <div className="surface-panel rounded-2xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm sm:text-base font-extrabold text-main">
                  Pièces Filtrées par le Douanier ({docs.length})
                </h3>
                <span className="text-[11px] font-mono text-dim">
                  DLP &amp; Anti-Injection
                </span>
              </div>

              {docs.length === 0 ? (
                <p className="text-xs text-dim py-6 text-center">
                  Aucune pièce chargée.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {docs.map((doc) => {
                    const isQuar = doc.statut === 'quarantaine';
                    const maskEntries = Object.entries(doc.masquages || {}).filter(
                      ([, v]) => v > 0
                    );
                    return (
                      <div
                        key={doc.nom_fichier}
                        onClick={() => doc.contenu_masque && onSelectDoc(doc)}
                        className={`p-3.5 rounded-xl border transition ${
                          doc.contenu_masque ? 'cursor-pointer' : ''
                        } ${
                          isQuar
                            ? 'badge-critical'
                            : 'surface-card hover:border-strong'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {isQuar ? (
                              <AlertOctagon className="w-4 h-4 tone-critical shrink-0" />
                            ) : (
                              <ShieldCheck className="w-4 h-4 text-accent shrink-0" />
                            )}
                            <div className="min-w-0">
                              <div className="text-xs font-extrabold text-main truncate">
                                {doc.nom_fichier}
                              </div>
                              <div className="text-[11px] text-sub truncate">
                                {isQuar
                                  ? doc.raison_quarantaine || 'Quarantaine injection'
                                  : 'Assaini ✓'}
                              </div>
                            </div>
                          </div>

                          {doc.contenu_masque && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-accent shrink-0">
                              <Eye className="w-3.5 h-3.5" /> Inspecter
                            </span>
                          )}
                        </div>

                        {maskEntries.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2.5">
                            {maskEntries.map(([k, count]) => (
                              <span
                                key={k}
                                className="px-2 py-0.5 rounded-md font-mono text-[10px] font-bold surface-subtle text-main"
                              >
                                [{k}] ×{count}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="surface-panel rounded-2xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm sm:text-base font-extrabold text-main">
                  Matrice des Droits par Agent
                </h3>
                <span className="badge-critical px-2.5 py-0.5 rounded-full font-mono text-[10px] font-extrabold">
                  0 écriture GCP
                </span>
              </div>

              <div className="overflow-x-auto rounded-xl border border-hairline">
                <table className="w-full text-left text-xs">
                  <thead className="surface-subtle text-[10px] text-sub border-b border-hairline">
                    <tr>
                      <th className="p-3">Agent</th>
                      <th className="p-3">Outils Autorisés</th>
                      <th className="p-3 text-center">Brut</th>
                      <th className="p-3 text-center">Écriture GCP</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {PERMISSION_MATRIX.map((row) => (
                      <tr key={row.agent}>
                        <td className="p-3 font-extrabold text-main">{row.agent}</td>
                        <td className="p-3 font-mono text-[11px] text-sub">
                          {row.tools}
                        </td>
                        <td className="p-3 text-center font-bold">
                          {row.rawAccess ? (
                            <span className="tone-warning">Oui (Seul)</span>
                          ) : (
                            <span className="text-dim">Non</span>
                          )}
                        </td>
                        <td className="p-3 text-center font-bold tone-critical">
                          Interdit
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VOLET 3 : CHAÎNE SHA-256 & VÉRIFICATEUR .ZIP (SÉLECTEUR INTERNE 2 ONGLETS) */}
      {subTab === 'chain' && (
        <div className="space-y-4">
          {/* Sélecteur interne 2 onglets : Registre SHA-256 | Vérificateur .zip */}
          <div className="surface-panel rounded-2xl p-2 flex flex-wrap items-center justify-between gap-2.5">
            <div
              role="tablist"
              aria-label="Sous-vues Registre SHA-256 et Vérificateur .zip"
              className="flex flex-wrap items-center gap-1.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={chainInnerTab === 'ledger'}
                onClick={() => setChainInnerTab('ledger')}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                  chainInnerTab === 'ledger'
                    ? 'seg-active'
                    : 'text-sub hover:text-main'
                }`}
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Registre SHA-256</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono tabular-nums ${
                    chainInnerTab === 'ledger'
                      ? 'bg-black/20'
                      : 'surface-subtle text-sub'
                  }`}
                >
                  {auditLog.length}
                </span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={chainInnerTab === 'verifier'}
                onClick={() => setChainInnerTab('verifier')}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
                  chainInnerTab === 'verifier'
                    ? 'seg-active'
                    : 'text-sub hover:text-main'
                }`}
              >
                <FolderArchive className="w-3.5 h-3.5" />
                <span>Vérificateur .zip</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono ${
                    chainInnerTab === 'verifier'
                      ? 'bg-black/20'
                      : 'surface-subtle text-sub'
                  }`}
                >
                  v1..v6
                </span>
              </button>
            </div>

            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-extrabold ${
                globalChainValid ? 'badge-success' : 'badge-critical'
              }`}
            >
              {globalChainValid ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Chaîne ({totalChainEntries}) : INTÈGRE ✓</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5" />
                  <span>Chaîne altérée : {chain.erreur || 'Rupture'}</span>
                </>
              )}
            </span>
          </div>

          {chainInnerTab === 'verifier' ? (
            <ForensicBundleVerifier onNotify={onNotify} />
          ) : (
            <div className="surface-panel rounded-2xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-hairline">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm sm:text-base font-extrabold text-main">
                    Registre Chaîné SHA-256
                  </h3>
                  <span
                    className={`px-2.5 py-0.5 rounded-full font-mono text-[11px] font-extrabold tabular-nums ${
                      hasActiveLogFilters
                        ? 'seg-active'
                        : 'surface-subtle text-main'
                    }`}
                  >
                    {filteredChainCount}/{totalChainEntries} bloc(s)
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={auditLog.length === 0 || isVerifyingCrypto}
                    onClick={handleVerifyInBrowser}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-[var(--deloitte)] disabled:opacity-45 disabled:cursor-not-allowed text-xs font-extrabold text-main transition cursor-pointer"
                  >
                    {isVerifyingCrypto ? (
                      <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
                    ) : (
                      <Cpu className="w-3.5 h-3.5 text-accent" />
                    )}
                    <span>Recalculer WebCrypto SHA-256</span>
                  </button>

                  {forensicTamper ? (
                    <button
                      type="button"
                      disabled={isVerifyingCrypto}
                      onClick={handleRestoreIntegrity}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black text-xs font-extrabold transition cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Restaurer</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={auditLog.length === 0 || isVerifyingCrypto}
                      onClick={handleSimulateForensicTamper}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl badge-warning hover:opacity-90 disabled:opacity-45 disabled:cursor-not-allowed text-xs font-extrabold transition cursor-pointer"
                      title="Altère 1 octet en mémoire locale pour démontrer la détection SHA-256"
                    >
                      <FlaskConical className="w-3.5 h-3.5" />
                      <span>Simuler altération mémoire</span>
                    </button>
                  )}

                  <div className="flex surface-subtle p-1 rounded-xl">
                    {(
                      [
                        ['ALL', 'Tous'],
                        ['ALERTS', 'Alertes'],
                        ['HUMAN', 'Signatures'],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setChainFilter(k)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                          chainFilter === k
                            ? 'seg-active'
                            : 'text-sub hover:text-main'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Barre de filtrage multi-critères compacte (/api/audit/log) */}
              <div
                role="search"
                aria-label="Filtrage multi-critères du registre SHA-256"
                className="rounded-xl p-3 surface-subtle border border-hairline grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2.5 items-center"
              >
                <div className="lg:col-span-3">
                  <select
                    aria-label="Filtrer le registre par agent"
                    value={logFilterAgent}
                    onChange={(e) => setLogFilterAgent(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg surface-card border border-hairline text-xs font-semibold text-main focus:outline-none focus:border-[var(--deloitte)] cursor-pointer"
                  >
                    <option value="">Tous les agents</option>
                    {availableLogAgents.map((ag) => (
                      <option key={ag} value={ag}>
                        {ag}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lg:col-span-3">
                  <select
                    aria-label="Filtrer le registre par action"
                    value={logFilterAction}
                    onChange={(e) => setLogFilterAction(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg surface-card border border-hairline text-xs font-semibold text-main focus:outline-none focus:border-[var(--deloitte)] cursor-pointer"
                  >
                    <option value="">Toutes les actions</option>
                    {availableLogActions.map((act) => (
                      <option key={act} value={act}>
                        {act}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lg:col-span-2">
                  <select
                    aria-label="Filtrer le registre par mode d'audit"
                    value={logFilterMode}
                    onChange={(e) => setLogFilterMode(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg surface-card border border-hairline text-xs font-semibold text-main focus:outline-none focus:border-[var(--deloitte)] cursor-pointer"
                  >
                    <option value="">Tous modes</option>
                    <option value="AVANT">AVANT</option>
                    <option value="APRES">APRÈS</option>
                    <option value="NONE">Global</option>
                  </select>
                </div>

                <div className="lg:col-span-3">
                  <div className="relative flex items-center">
                    <Search className="w-3.5 h-3.5 text-accent absolute left-2.5 pointer-events-none" />
                    <input
                      type="text"
                      value={logSearchQuery}
                      onChange={(e) => setLogSearchQuery(e.target.value)}
                      placeholder="Texte ou hash SHA-256…"
                      aria-label="Rechercher par texte ou préfixe hash SHA-256"
                      className="w-full pl-8 pr-8 py-1.5 rounded-lg surface-card border border-hairline text-xs text-main placeholder:text-dim focus:outline-none focus:border-[var(--deloitte)]"
                    />
                    {isLoadingAuditExplorer ? (
                      <Loader2 className="w-3.5 h-3.5 text-accent animate-spin absolute right-2.5" />
                    ) : (
                      logSearchQuery && (
                        <button
                          type="button"
                          aria-label="Effacer la recherche du registre"
                          onClick={() => setLogSearchQuery('')}
                          className="p-0.5 rounded hover:bg-white/10 text-sub hover:text-main absolute right-2 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )
                    )}
                  </div>
                </div>

                <div className="lg:col-span-1 flex justify-end">
                  <button
                    type="button"
                    disabled={!hasActiveLogFilters}
                    onClick={resetLogFilters}
                    title="Réinitialiser les filtres"
                    className={`inline-flex items-center justify-center p-1.5 rounded-lg text-xs font-bold transition ${
                      hasActiveLogFilters
                        ? 'surface-card hover:border-[var(--deloitte)] text-main cursor-pointer'
                        : 'surface-card text-dim opacity-50 cursor-not-allowed'
                    }`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Alerte condensée en cas d'altération mémoire simulée */}
              {forensicTamper && (
                <div className="rounded-xl px-4 py-3 border badge-warning flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <FlaskConical className="w-4 h-4 shrink-0" />
                    <span className="font-extrabold">
                      Altération mémoire Bloc #{String(forensicTamper.blockNum).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-[11px] opacity-90">
                      ({forensicTamper.fieldLabel} :{' '}
                      <span className="line-through">{forensicTamper.beforeSnippet}</span> →{' '}
                      <strong>{forensicTamper.afterSnippet}</strong> • serveur intact)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleRestoreIntegrity}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black text-xs font-extrabold transition cursor-pointer shrink-0"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Restaurer</span>
                  </button>
                </div>
              )}

              {/* Bandeau condensé du recalcul WebCrypto */}
              {browserVerifyReport && (
                <div
                  className={`rounded-xl px-4 py-2.5 border flex flex-wrap items-center justify-between gap-2 text-xs ${
                    browserVerifyReport.supported && browserVerifyReport.allValid
                      ? 'badge-success'
                      : 'badge-critical'
                  }`}
                >
                  <div className="flex items-center gap-2 font-extrabold">
                    {browserVerifyReport.supported && browserVerifyReport.allValid ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                    )}
                    <span>
                      {browserVerifyReport.supported && browserVerifyReport.allValid
                        ? `WebCrypto SHA-256 : ${browserVerifyReport.verifiedCount}/${browserVerifyReport.totalCount} blocs validés (${browserVerifyReport.durationMs} ms)`
                        : browserVerifyReport.errorMessage ||
                          'Discordance WebCrypto SHA-256 détectée'}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] px-2.5 py-0.5 rounded-lg bg-black/15">
                    #{browserVerifyReport.headHash.slice(0, 18)}…
                  </span>
                </div>
              )}

              {reversedChain.length === 0 ? (
                <p className="text-xs text-dim py-8 text-center">
                  Aucun bloc correspondant.
                </p>
              ) : (
                <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1">
                  {reversedChain.map(({ entry, blockNum }) => {
                    const isViolation = entry.action === 'VIOLATION';
                    const isQuar = entry.action === 'QUARANTINE';
                    const isVal = entry.action === 'HUMAN_VALIDATION';
                    const blockProof = browserVerifyReport?.byBlock[blockNum];
                    const isTamperedTarget = forensicTamper?.blockNum === blockNum;
                    const isCryptoInvalid = Boolean(blockProof && !blockProof.valid);

                    return (
                      <div
                        key={`${entry.hash}-${blockNum}`}
                        className={`p-3 rounded-xl border font-mono text-xs ${
                          isTamperedTarget || isCryptoInvalid || isViolation
                            ? 'badge-critical'
                            : isQuar
                            ? 'badge-warning'
                            : isVal
                            ? 'badge-success'
                            : 'surface-card'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="px-2 py-0.5 rounded surface-subtle text-[10px] font-bold text-sub">
                              #{String(blockNum).padStart(2, '0')}
                            </span>
                            {isTamperedTarget && (
                              <span className="px-2 py-0.5 rounded-full badge-critical text-[10px] font-sans font-extrabold">
                                ALTÉRÉ
                              </span>
                            )}
                            {entry.mode && (
                              <span className="px-1.5 py-0.5 rounded surface-subtle text-[10px] font-bold text-main">
                                {entry.mode}
                              </span>
                            )}
                            {entry.run_id && (
                              <span className="px-1.5 py-0.5 rounded surface-subtle text-[10px] text-dim">
                                lot:{entry.run_id.slice(0, 8)}
                              </span>
                            )}
                            <span className="font-extrabold text-accent">
                              {entry.agent}
                            </span>
                            <span className="font-bold text-main">
                              → {entry.action}
                            </span>
                          </div>
                          <span className="text-[10px] text-dim">
                            {entry.ts?.slice(11, 19)} UTC
                          </span>
                        </div>

                        <div className="text-[11px] text-sub mt-1 break-all line-clamp-2">
                          {typeof entry.details === 'object'
                            ? JSON.stringify(entry.details)
                            : String(entry.details)}
                        </div>

                        <div className="mt-2 pt-1.5 border-t border-hairline flex flex-wrap items-center justify-between gap-2 text-[10px] text-dim">
                          <span>préc.: {entry.prev_hash.slice(0, 18)}…</span>
                          <div className="flex flex-wrap items-center gap-2">
                            {blockProof && (
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold font-sans ${
                                  blockProof.valid
                                    ? 'badge-success'
                                    : 'badge-critical'
                                }`}
                              >
                                {blockProof.valid ? (
                                  <>
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>SHA-256 ✓</span>
                                  </>
                                ) : !blockProof.prevHashValid ? (
                                  <>
                                    <ShieldAlert className="w-3 h-3" />
                                    <span>
                                      Cascade prev_hash (#{String(blockNum).padStart(2, '0')})
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <ShieldAlert className="w-3 h-3" />
                                    <span>
                                      Falsifié ({blockProof.recomputedHash.slice(0, 10)}…)
                                    </span>
                                  </>
                                )}
                              </span>
                            )}
                            <span className="text-accent font-semibold">
                              sha256: {entry.hash.slice(0, 20)}…
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
};
