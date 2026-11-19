import React, { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Search,
  Compass,
  LayoutDashboard,
  Triangle,
  GitCompareArrows,
  ShieldCheck,
  Play,
  CheckCircle2,
  Sun,
  Moon,
  ArrowLeftRight,
  FileText,
  AlertOctagon,
  Zap,
  RotateCcw,
  Sparkles,
  ShieldAlert,
  CornerDownLeft,
  Target,
  Link2,
  Keyboard,
  Plus,
  Layers,
  Loader2,
  FolderArchive,
} from 'lucide-react';
import type {
  AuditMode,
  DocumentSearchHit,
  Finding,
  NavSection,
  SanitizedDocument,
  ThemeMode,
} from '../types';
import {
  searchDocumentsInSession,
  searchDocumentsLocally,
} from '../api';
import type { DeliverablesSubTab } from './SecurityAndDeliverablesView';
import { buildFindingAliases } from '../utils/auditMetrics';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: AuditMode;
  theme: ThemeMode;
  useCache: boolean;
  hasSynthesis: boolean;
  bothModesReady: boolean;
  validated: boolean;
  findings: Finding[];
  docs: SanitizedDocument[];
  onNavigate: (section: NavSection) => void;
  onOpenDeliverablesSubTab?: (subTab: DeliverablesSubTab) => void;
  onOpenShortcuts?: () => void;
  onSelectFinding: (finding: Finding) => void;
  onSelectDoc: (
    doc: SanitizedDocument,
    highlightQuote?: string,
    highlightLine?: number
  ) => void;
  onRunAudit: () => void;
  onRunBothModes: () => void;
  onSwitchMode: (mode: AuditMode) => void;
  onToggleTheme: () => void;
  onToggleCache: () => void;
  onValidate: () => void;
  onLoadDemo: () => void;
  onSimulateViolation: () => void;
  onReset: () => void;
  activeSessionId?: string;
  onCreateNewSession?: () => void;
  onSelectDefaultSession?: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onOpenChange,
  mode,
  theme,
  useCache,
  hasSynthesis,
  bothModesReady,
  validated,
  findings,
  docs,
  onNavigate,
  onOpenDeliverablesSubTab,
  onOpenShortcuts,
  onSelectFinding,
  onSelectDoc,
  onRunAudit,
  onRunBothModes,
  onSwitchMode,
  onToggleTheme,
  onToggleCache,
  onValidate,
  onLoadDemo,
  onSimulateViolation,
  onReset,
  activeSessionId,
  onCreateNewSession,
  onSelectDefaultSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [serverHits, setServerHits] = useState<DocumentSearchHit[] | null>(null);
  const [isSearchingDocs, setIsSearchingDocs] = useState(false);

  // Réinitialise la recherche à la fermeture
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setServerHits(null);
      setIsSearchingDocs(false);
    }
  }, [open]);

  // Repli local instantané sur les pièces anonymisées déjà en mémoire
  const localHits = useMemo(
    () => searchDocumentsLocally(docs, searchQuery, 20),
    [docs, searchQuery]
  );

  // Recherche plein-texte inter-documents côté serveur (`GET /api/documents/search?q=...&mode=...`) avec debounce ~180 ms
  useEffect(() => {
    if (!open) return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      setServerHits(null);
      setIsSearchingDocs(false);
      return;
    }

    const controller = new AbortController();
    setIsSearchingDocs(true);

    const timer = window.setTimeout(async () => {
      try {
        const hits = await searchDocumentsInSession(
          trimmed,
          mode,
          controller.signal
        );
        if (!controller.signal.aborted) {
          setServerHits(hits);
          setIsSearchingDocs(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setIsSearchingDocs(false);
        }
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchQuery, mode, activeSessionId]);

  const trimmedQuery = searchQuery.trim();
  const effectiveDocHits = useMemo(() => {
    if (trimmedQuery.length < 2) return [];
    if (
      serverHits !== null &&
      (serverHits.length > 0 || localHits.length === 0)
    ) {
      return serverHits;
    }
    return localHits;
  }, [trimmedQuery, serverHits, localHits]);

  const renderSnippetWithMatch = (snippet: string, matchTerm: string) => {
    const cleanMatch = matchTerm.trim();
    if (!cleanMatch) return snippet;
    const idx = snippet.toLowerCase().indexOf(cleanMatch.toLowerCase());
    if (idx === -1) return snippet;
    const before = snippet.slice(0, idx);
    const highlighted = snippet.slice(idx, idx + cleanMatch.length);
    const after = snippet.slice(idx + cleanMatch.length);
    return (
      <>
        {before}
        <mark className="bg-[#86BC25]/30 text-main border-b border-[#86BC25] px-0.5 rounded font-semibold">
          {highlighted}
        </mark>
        {after}
      </>
    );
  };

  const handleOpenSearchHit = (hit: DocumentSearchHit) => {
    const foundDoc = docs.find((d) => d.nom_fichier === hit.nom_fichier);
    const normalizedStatut: SanitizedDocument['statut'] =
      hit.statut === 'quarantaine'
        ? 'quarantaine'
        : hit.statut === 'pret'
        ? 'pret'
        : 'nettoye';
    const targetDoc: SanitizedDocument =
      foundDoc && foundDoc.contenu_masque
        ? foundDoc
        : {
            nom_fichier: hit.nom_fichier,
            statut: foundDoc?.statut || normalizedStatut,
            contenu_masque: foundDoc?.contenu_masque || hit.snippet,
            masquages: foundDoc?.masquages,
            raison_quarantaine: foundDoc?.raison_quarantaine,
            extrait_quarantaine: foundDoc?.extrait_quarantaine,
          };

    const quoteToHighlight =
      hit.match && hit.match.trim().length >= 2
        ? hit.match.trim()
        : trimmedQuery;

    onSelectDoc(targetDoc, quoteToHighlight, hit.line);
  };

  const runAndClose = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs animate-in fade-in-0 duration-150" />
        <Dialog.Content
          aria-describedby="command-palette-desc"
          className="fixed left-1/2 top-[13%] z-50 w-[94vw] max-w-2xl -translate-x-1/2 surface-elevated rounded-2xl overflow-hidden focus:outline-none"
        >
          <Dialog.Title className="sr-only">
            Palette de commandes rapide TRIAD
          </Dialog.Title>
          <Dialog.Description id="command-palette-desc" className="sr-only">
            Recherchez une vue, un contrôle NIS2, un extrait plein-texte dans les pièces anonymisées ou déclenchez une action d&apos;audit.
          </Dialog.Description>

          <Command
            label="Palette de commandes TRIAD"
            className="flex flex-col w-full text-main"
          >
            {/* Barre de saisie */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-hairline">
              <Search className="w-4 h-4 text-accent shrink-0" />
              <Command.Input
                autoFocus
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder="Chercher dans les pièces (radiologie, MFA, PRA…), un constat (F-01), une vue ou une action…"
                className="flex-1 bg-transparent text-sm text-main placeholder:text-dim focus:outline-none"
              />
              {isSearchingDocs && (
                <Loader2
                  className="w-3.5 h-3.5 text-accent animate-spin shrink-0"
                  aria-label="Recherche plein-texte en cours"
                />
              )}
              <span className="text-[10px] font-mono px-2 py-0.5 rounded surface-subtle text-sub shrink-0">
                Mode {mode}
              </span>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="kbd-pill cursor-pointer hover:text-main"
              >
                Échap
              </button>
            </div>

            {/* Résultats filtrés en direct */}
            <Command.List className="max-h-[440px] overflow-y-auto p-2 space-y-1">
              <Command.Empty className="py-10 text-center text-xs text-sub">
                Aucun résultat trouvé pour cette recherche. Essayez « radiologie », « F-01 », « SSH », « PSSI » ou « Comparateur ».
              </Command.Empty>

              {/* GROUPE 0 : RECHERCHE PLEIN-TEXTE INTER-DOCUMENTS (`GET /api/documents/search`) */}
              {trimmedQuery.length >= 2 && effectiveDocHits.length > 0 && (
                <Command.Group
                  forceMount
                  heading={`Extraits Plein-Texte — Pièces Anonymisées (${effectiveDocHits.length})`}
                >
                  {effectiveDocHits.map((hit, idx) => {
                    const isQuar = hit.statut === 'quarantaine';
                    return (
                      <Command.Item
                        forceMount
                        key={`ft-${hit.nom_fichier}-${hit.line}-${idx}`}
                        value={`${trimmedQuery} extrait texte document ${hit.nom_fichier} ligne ${hit.line} ${hit.snippet}`}
                        onSelect={() =>
                          runAndClose(() => handleOpenSearchHit(hit))
                        }
                        className="flex flex-col gap-1 px-3 py-2.5 rounded-xl text-xs"
                      >
                        <div className="flex items-center justify-between gap-2 w-full">
                          <div className="flex items-center gap-2 min-w-0">
                            {isQuar ? (
                              <AlertOctagon className="w-3.5 h-3.5 tone-critical shrink-0" />
                            ) : (
                              <FileText className="w-3.5 h-3.5 text-accent shrink-0" />
                            )}
                            <span className="font-semibold text-main truncate">
                              {hit.nom_fichier}
                            </span>
                            <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded surface-subtle text-accent shrink-0 tabular-nums">
                              L.{hit.line}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                isQuar ? 'badge-critical' : 'badge-success'
                              }`}
                            >
                              {isQuar ? 'Quarantaine' : 'DLP ✓'}
                            </span>
                            <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                          </div>
                        </div>
                        <div className="pl-5.5 text-[11px] text-sub leading-snug line-clamp-2 break-words">
                          {renderSnippetWithMatch(
                            hit.snippet,
                            hit.match || trimmedQuery
                          )}
                        </div>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              {/* GROUPE 1 : VUES & NAVIGATION (Alt+1..Alt+5) */}
              <Command.Group heading="Navigation (Alt+1 … Alt+5)">
                <Command.Item
                  value="vue mission dossier configuration pieces perimetre alt+1"
                  onSelect={() => runAndClose(() => onNavigate('mission'))}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Compass className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">Mission &amp; Dossier</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <kbd className="kbd-pill">Alt+1</kbd>
                    <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                  </div>
                </Command.Item>

                {hasSynthesis && (
                  <Command.Item
                    value="vue cockpit executif comex radar synthese risques alt+2"
                    onSelect={() => runAndClose(() => onNavigate('cockpit'))}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <LayoutDashboard className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">Cockpit Exécutif</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <kbd className="kbd-pill">Alt+2</kbd>
                      <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                    </div>
                  </Command.Item>
                )}

                {hasSynthesis && (
                  <Command.Item
                    value="vue investigation triad matrice dit ecrit reel tableau cartes findings alt+3"
                    onSelect={() => runAndClose(() => onNavigate('triad'))}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Triangle className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">Investigation TRIAD</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <kbd className="kbd-pill">Alt+3</kbd>
                      <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                    </div>
                  </Command.Item>
                )}

                <Command.Item
                  value="vue comparateur avant apres delta evolution contradictions alt+4"
                  onSelect={() => runAndClose(() => onNavigate('compare'))}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <GitCompareArrows className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">Comparateur AVANT / APRÈS</span>
                    {bothModesReady && (
                      <span className="badge-success text-[10px] font-bold px-2 py-0.5 rounded-full">
                        Delta prêt
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <kbd className="kbd-pill">Alt+4</kbd>
                    <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                  </div>
                </Command.Item>

                <Command.Item
                  value="vue securite livrables gouvernance rapport a4 mail dsi sha-256 chaine alt+5"
                  onSelect={() => runAndClose(() => onNavigate('deliverables'))}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <ShieldCheck className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">Livrables &amp; Gouvernance</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <kbd className="kbd-pill">Alt+5</kbd>
                    <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                  </div>
                </Command.Item>

                {onOpenDeliverablesSubTab && (
                  <Command.Item
                    value="plan action remediation feuille de route 30 60 90 jours effort impact nis2"
                    onSelect={() =>
                      runAndClose(() => onOpenDeliverablesSubTab('roadmap'))
                    }
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Target className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">
                        Plan d&apos;Action 30 / 60 / 90 Jours
                      </span>
                      <span className="text-dim truncate">
                        — Feuille de route &amp; Matrice Effort × Impact NIS2
                      </span>
                    </div>
                    <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                  </Command.Item>
                )}

                {onOpenDeliverablesSubTab && (
                  <Command.Item
                    value="registre sha-256 chaine cryptographique webcrypto recalculer empreintes navigateur"
                    onSelect={() =>
                      runAndClose(() => onOpenDeliverablesSubTab('chain'))
                    }
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Link2 className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">
                        Registre Cryptographique SHA-256
                      </span>
                      <span className="text-dim truncate">
                        — Vérificateur local WebCrypto des blocs scellés
                      </span>
                    </div>
                    <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                  </Command.Item>
                )}

                {onOpenDeliverablesSubTab && (
                  <Command.Item
                    value="verifier dossier de preuve zip archive forensique certificat authenticite manifest sha256"
                    onSelect={() =>
                      runAndClose(() => {
                        onOpenDeliverablesSubTab('chain');
                        window.setTimeout(() => {
                          document
                            .getElementById('forensic-bundle-verifier')
                            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }, 120);
                      })
                    }
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <FolderArchive className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">
                        Vérifier un Dossier de Preuve (.zip)
                      </span>
                      <span className="text-dim truncate">
                        — Certificat d&apos;Authenticité Forensique SHA-256
                      </span>
                    </div>
                    <CornerDownLeft className="w-3.5 h-3.5 text-dim shrink-0" />
                  </Command.Item>
                )}
              </Command.Group>

              {/* GROUPE 2 : CONSTATS & CONTRÔLES NIS2 */}
              {findings.length > 0 && (
                <Command.Group heading={`Constats & Contrôles NIS2 (${findings.length})`}>
                  {findings.map((f) => {
                    const aliases = buildFindingAliases(f.id).join(' ');
                    return (
                      <Command.Item
                        key={f.id}
                        value={`${aliases} ${f.theme} ${f.exigence_nis2} ${f.contradiction || ''} ${f.statut} ${f.gravite} ${f.reel?.ressource || ''}`}
                        onSelect={() =>
                          runAndClose(() => {
                            onNavigate('triad');
                            onSelectFinding(f);
                          })
                        }
                        className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="font-mono text-[11px] font-extrabold px-2 py-0.5 rounded bg-[#86BC25] text-black shrink-0">
                            {f.id}
                          </span>
                          <span className="font-semibold truncate">{f.theme}</span>
                          <span className="text-dim text-[11px] hidden sm:inline truncate">
                            {f.exigence_nis2}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {f.contradiction && (
                            <span className="badge-critical text-[10px] font-bold px-2 py-0.5 rounded-full">
                              {f.contradiction}
                            </span>
                          )}
                          <span
                            className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                              f.statut === 'conforme'
                                ? 'badge-success'
                                : f.statut === 'non_conforme'
                                ? 'badge-critical'
                                : 'badge-warning'
                            }`}
                          >
                            {f.statut === 'non_conforme'
                              ? 'Écart'
                              : f.statut === 'conforme'
                              ? 'Conforme'
                              : f.statut}
                          </span>
                        </div>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              {/* GROUPE 3 : PIÈCES DOCUMENTAIRES */}
              {docs.length > 0 && (
                <Command.Group heading={`Pièces du Dossier Client (${docs.length})`}>
                  {docs.map((doc) => {
                    const isQuar = doc.statut === 'quarantaine';
                    return (
                      <Command.Item
                        key={doc.nom_fichier}
                        value={`document piece fichier ${doc.nom_fichier} ${doc.statut}`}
                        onSelect={() =>
                          runAndClose(() => {
                            if (doc.contenu_masque) {
                              onSelectDoc(doc);
                            } else {
                              onNavigate('mission');
                            }
                          })
                        }
                        className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {isQuar ? (
                            <AlertOctagon className="w-4 h-4 tone-critical shrink-0" />
                          ) : (
                            <FileText className="w-4 h-4 text-accent shrink-0" />
                          )}
                          <span className="font-semibold truncate">{doc.nom_fichier}</span>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                            isQuar
                              ? 'badge-critical'
                              : doc.statut === 'nettoye'
                              ? 'badge-success'
                              : 'surface-subtle text-sub'
                          }`}
                        >
                          {isQuar
                            ? 'Quarantaine'
                            : doc.statut === 'nettoye'
                            ? 'Nettoyé ✓'
                            : 'Prêt'}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              {/* GROUPE 4 : ACTIONS D'AUDIT & CONFIGURATION */}
              <Command.Group heading="Actions Rapides">
                <Command.Item
                  value={`lancer demarrer executer audit analyse ${mode}`}
                  onSelect={() => runAndClose(onRunAudit)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <Play className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">
                      Lancer l&apos;audit ({mode === 'AVANT' ? 'Préparation AVANT' : 'Complet APRÈS'})
                    </span>
                  </div>
                  <span className="badge-success text-[10px] font-bold px-2 py-0.5 rounded-full">
                    Exécuter
                  </span>
                </Command.Item>

                <Command.Item
                  value="lancer sequence complete avant et apres alimenter comparateur deux modes"
                  onSelect={() => runAndClose(onRunBothModes)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <GitCompareArrows className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">
                      Exécuter la séquence complète AVANT → APRÈS (Comparateur)
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-dim">2 phases</span>
                </Command.Item>

                <Command.Item
                  value="basculer changer mode avant apres entretien phase"
                  onSelect={() =>
                    runAndClose(() => onSwitchMode(mode === 'AVANT' ? 'APRES' : 'AVANT'))
                  }
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <ArrowLeftRight className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">
                      Basculer vers le mode{' '}
                      {mode === 'AVANT' ? 'APRÈS entretien' : 'AVANT entretien'}
                    </span>
                  </div>
                </Command.Item>

                {hasSynthesis && !validated && (
                  <Command.Item
                    value="valider synthese consultant deloitte signer debloquer livrables rapport"
                    onSelect={() => runAndClose(onValidate)}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">
                        Valider la synthèse et débloquer les livrables ({mode})
                      </span>
                    </div>
                    <span className="badge-warning text-[10px] font-bold px-2 py-0.5 rounded-full">
                      Signature
                    </span>
                  </Command.Item>
                )}

                <Command.Item
                  value="basculer changer theme mode sombre cyber clair executif apparence"
                  onSelect={() => runAndClose(onToggleTheme)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    {theme === 'dark' ? (
                      <Sun className="w-4 h-4 tone-warning shrink-0" />
                    ) : (
                      <Moon className="w-4 h-4 text-accent shrink-0" />
                    )}
                    <span className="font-semibold">
                      Passer en {theme === 'dark' ? 'Mode Clair Exécutif' : 'Mode Sombre Cyber'}
                    </span>
                  </div>
                </Command.Item>

                <Command.Item
                  value="activer desactiver cache secours mode accelere demo"
                  onSelect={() => runAndClose(onToggleCache)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <Zap className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">
                      {useCache ? 'Désactiver le Cache secours' : 'Activer le Cache secours'}
                    </span>
                  </div>
                </Command.Item>

                <Command.Item
                  value="charger dossier demo ch de valmont hopital pieces"
                  onSelect={() => runAndClose(onLoadDemo)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <Sparkles className="w-4 h-4 text-accent shrink-0" />
                    <span className="font-semibold">
                      Charger le dossier client CH de Valmont
                    </span>
                  </div>
                </Command.Item>

                {onCreateNewSession && (
                  <Command.Item
                    value="nouvelle session audit isolee creer mission multi-sessions sans ecraser valmont"
                    onSelect={() => runAndClose(onCreateNewSession)}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <Plus className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">
                        Nouvelle session d&apos;audit isolée (?session_id=mission-…)
                      </span>
                    </div>
                  </Command.Item>
                )}

                {onSelectDefaultSession &&
                  activeSessionId &&
                  activeSessionId !== 'default' && (
                    <Command.Item
                      value="revenir session principale default demo ch de valmont"
                      onSelect={() => runAndClose(onSelectDefaultSession)}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                    >
                      <div className="flex items-center gap-2.5">
                        <Layers className="w-4 h-4 text-accent shrink-0" />
                        <span className="font-semibold">
                          Revenir à la session principale (CH de Valmont)
                        </span>
                      </div>
                    </Command.Item>
                  )}

                <Command.Item
                  value="tester simuler violation blocage garde du corps securite delete_bucket"
                  onSelect={() => runAndClose(onSimulateViolation)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <ShieldAlert className="w-4 h-4 tone-critical shrink-0" />
                    <span className="font-semibold">
                      Tester le blocage d&apos;action interdite (Garde du Corps)
                    </span>
                  </div>
                </Command.Item>

                {onOpenShortcuts && (
                  <Command.Item
                    value="aide raccourcis clavier touches navigation ? ctrl k"
                    onSelect={() => runAndClose(onOpenShortcuts)}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <Keyboard className="w-4 h-4 text-accent shrink-0" />
                      <span className="font-semibold">
                        Afficher l&apos;aide des raccourcis clavier
                      </span>
                    </div>
                    <kbd className="kbd-pill">?</kbd>
                  </Command.Item>
                )}

                <Command.Item
                  value="reinitialiser effacer session audit journal"
                  onSelect={() => runAndClose(onReset)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <RotateCcw className="w-4 h-4 tone-critical shrink-0" />
                    <span className="font-semibold">Réinitialiser toute la session</span>
                  </div>
                </Command.Item>
              </Command.Group>
            </Command.List>

            {/* Pied de palette clavier */}
            <div className="px-4 py-2.5 surface-subtle border-t border-hairline flex flex-wrap items-center justify-between gap-2 text-[11px] text-sub">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <kbd className="kbd-pill">↑↓</kbd> Naviguer
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="kbd-pill">↵</kbd> Ouvrir
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="kbd-pill">Alt+1…5</kbd> Vues
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="kbd-pill">Échap</kbd> Fermer
                </span>
              </div>
              <span className="font-mono text-[10px] text-dim">
                TRIAD • Navigation rapide
              </span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
