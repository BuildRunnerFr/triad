import type { AuditLogEntry, AuditMode, AuditSynthesis, Finding, SanitizedDocument } from '../../types';

/**
 * Mise en forme des données réelles du dossier pour le replay : rien n'est inventé.
 * Les entrées viennent du registre chaîné SHA-256 (`GET /api/audit/log`), les pièces et
 * constats de la synthèse de la phase affichée.
 */

export type ActId = 0 | 1 | 2 | 3;

export const ACTS: { name: string; agent: string; caption: string }[] = [
  {
    name: 'Réception',
    agent: 'Douanier',
    caption: 'Les pièces du dossier sont assainies ; celle qui tente d’instruire l’IA est mise à l’écart.',
  },
  {
    name: 'Sondes',
    agent: 'Garde du corps',
    caption: 'La configuration réelle est relevée ressource par ressource, en lecture seule.',
  },
  {
    name: 'Confrontation',
    agent: 'Garde du corps',
    caption: 'Chaque constat croise le Dit, l’Écrit et le Réel ; les écarts deviennent des ruptures.',
  },
  {
    name: 'Scellement',
    agent: 'Registre',
    caption: 'Chaque maillon porte l’empreinte du précédent, jusqu’à l’empreinte de tête.',
  },
];

const ACT1_ACTIONS = new Set([
  'RUN_START',
  'SANITIZED',
  'QUARANTINE',
  'PROMPT_INJECTION_QUARANTINED',
  'SECURITY_VIOLATION_BLOCKED',
  'VIOLATION',
]);
const ACT2_ACTIONS = new Set(['TOOL_CALL', 'MODEL_REQUEST', 'MODEL_RESPONSE']);

export interface ReplayToken {
  text: string;
  token: boolean;
}

export interface ReplayDoc {
  name: string;
  source: 'dit' | 'ecrit' | null;
  quarantined: boolean;
  masks: number;
  lines: ReplayToken[][];
  reason: string | null;
}

export interface ReplayResource {
  name: string;
  findingIds: string[];
}

export interface ReplayFinding {
  id: string;
  theme: string;
  dit: boolean;
  ecrit: boolean;
  reel: boolean;
  contradiction: string | null;
}

export interface ReplayModel {
  /** Chaîne complète (ordre du registre). */
  chain: AuditLogEntry[];
  /** Indices (dans `chain`) des entrées de l'exécution rejouée, par acte (0..2). */
  runByAct: [number[], number[], number[]];
  docs: ReplayDoc[];
  resources: ReplayResource[];
  findings: ReplayFinding[];
  hiddenFindings: number;
  ruptures: number;
  totalFindings: number;
  headHash: string;
}

const TOKEN_RE = /(\[[A-Z]+_\d+\])/;

function tokenize(line: string): ReplayToken[] {
  return line
    .split(TOKEN_RE)
    .filter(Boolean)
    .map((text) => ({ text, token: TOKEN_RE.test(text) && /^\[[A-Z]+_\d+\]$/.test(text) }));
}

function cleanLine(raw: string): string {
  return raw
    .replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/^·\s*|\s*·$/g, '')
    .trim();
}

const MAX_LINE = 64;

function clipAround(line: string): string {
  if (line.length <= MAX_LINE) return line;
  const m = line.match(TOKEN_RE);
  const idx = m?.index ?? 0;
  const start = m ? Math.max(0, Math.min(idx - 24, line.length - MAX_LINE)) : 0;
  const body = line.slice(start, start + MAX_LINE).trim();
  return `${start > 0 ? '…' : ''}${body}${start + MAX_LINE < line.length ? '…' : ''}`;
}

function docLines(doc: SanitizedDocument): string[] {
  if (doc.statut === 'quarantaine' && doc.extrait_quarantaine) {
    // L'extrait piégé, coupé en lignes courtes.
    const words = doc.extrait_quarantaine.split(/\s+/);
    const out: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 38) {
        out.push(cur.trim());
        cur = w;
      } else cur = `${cur} ${w}`;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.slice(0, 4);
  }
  const lines = (doc.contenu_masque || '')
    .split('\n')
    .map(cleanLine)
    .filter((l) => l.length > 6 && !/^-+$/.test(l) && !/^·/.test(l));
  const withToken = lines.filter((l) => TOKEN_RE.test(l));
  const picked: string[] = [];
  // Une ligne de titre pour situer la pièce, puis les lignes caviardées.
  if (lines[0]) picked.push(lines[0]);
  for (const l of withToken) {
    if (picked.length >= 4) break;
    if (!picked.includes(l)) picked.push(l);
  }
  for (const l of lines.slice(1)) {
    if (picked.length >= 4) break;
    if (!picked.includes(l)) picked.push(l);
  }
  return picked.map(clipAround);
}

function rankFinding(f: Finding): number {
  const g = { critique: 0, haute: 1, moyenne: 2, faible: 3 }[f.gravite] ?? 4;
  return (f.contradiction ? 0 : 10) + g;
}

export function buildReplayModel(
  chain: AuditLogEntry[],
  headHash: string | null | undefined,
  synthesis: AuditSynthesis,
  mode: AuditMode
): ReplayModel {
  // Exécution rejouée : depuis le dernier RUN_START de la phase affichée.
  let start = -1;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (chain[i].action === 'RUN_START' && (!chain[i].mode || chain[i].mode === mode)) {
      start = i;
      break;
    }
  }
  if (start < 0) start = 0;
  const runByAct: [number[], number[], number[]] = [[], [], []];
  for (let i = start; i < chain.length; i += 1) {
    const e = chain[i];
    if (e.mode && e.mode !== mode) continue;
    if (e.action === 'WORM_ARCHIVED') continue; // rejoué au scellement
    if (ACT1_ACTIONS.has(e.action)) runByAct[0].push(i);
    else if (ACT2_ACTIONS.has(e.action)) runByAct[1].push(i);
    else runByAct[2].push(i);
  }

  const rawDocs = [
    ...(synthesis.documents_nettoyes || []),
    ...(synthesis.documents_quarantaine || []),
  ];
  const docs: ReplayDoc[] = rawDocs.slice(0, 5).map((d) => ({
    name: d.nom_fichier,
    source: d.type_source ?? null,
    quarantined: d.statut === 'quarantaine',
    masks: Object.values(d.masquages || {}).reduce((a, b) => a + (Number(b) || 0), 0),
    lines: docLines(d).map(tokenize),
    reason: d.raison_quarantaine ?? null,
  }));
  // Les pièces piégées en dernier : elles sortent de la rangée vers la quarantaine.
  docs.sort((a, b) => Number(a.quarantined) - Number(b.quarantined));

  const findingsAll = synthesis.findings || [];
  const resMap = new Map<string, string[]>();
  for (const f of findingsAll) {
    const r = f.reel?.ressource;
    if (!r) continue;
    for (const part of r.split(/\s+&\s+/)) {
      const key = part.trim();
      if (!key) continue;
      const ids = resMap.get(key) || [];
      if (!ids.includes(f.id)) ids.push(f.id);
      resMap.set(key, ids);
    }
  }
  const resources = [...resMap.entries()]
    .slice(0, 8)
    .map(([name, findingIds]) => ({ name, findingIds }));

  const sorted = [...findingsAll].sort((a, b) => rankFinding(a) - rankFinding(b));
  const shown = sorted.slice(0, 7);
  const findings: ReplayFinding[] = shown
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({
      id: f.id,
      theme: f.theme,
      dit: Boolean(f.dit),
      ecrit: Boolean(f.ecrit),
      reel: Boolean(f.reel),
      contradiction: f.contradiction,
    }));

  return {
    chain,
    runByAct,
    docs,
    resources,
    findings,
    hiddenFindings: Math.max(0, findingsAll.length - shown.length),
    ruptures: findings.filter((f) => f.contradiction).length,
    totalFindings: findingsAll.length,
    headHash: headHash || chain[chain.length - 1]?.hash || '',
  };
}

export function detailFile(e: AuditLogEntry): string | null {
  if (e.details && typeof e.details === 'object') {
    const f = (e.details as Record<string, unknown>).fichier;
    if (typeof f === 'string') return f;
  }
  return null;
}

export function formatTs(ts: string | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return (
    d.toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC'
  );
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
