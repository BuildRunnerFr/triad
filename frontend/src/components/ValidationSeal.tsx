import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { AuditMode, AuditSynthesis as Synthesis } from '../types';
import { DURATION, EASE_OUT, gsap, prefersReducedMotion, useGSAP } from '../motion/gsap';
import DecryptedText from './reactbits/DecryptedText';

const LOCKED_EXPORTS = 12;

const modeLabel = (mode: AuditMode) => (mode === 'APRES' ? 'APRÈS' : mode);

const SEVERITY_ORDER = [
  { key: 'critique', label: 'critiques', tone: 'tone-critical' },
  { key: 'haute', label: 'hautes', tone: 'tone-high' },
  { key: 'moyenne', label: 'moyennes', tone: 'tone-warning' },
  { key: 'faible', label: 'faibles', tone: 'text-sub' },
] as const;

/**
 * Cadenas dessiné : l'anse se lève et pivote à l'ouverture (animée par GSAP).
 */
/**
 * Pose « anse ouverte » telle que GSAP l'écrit en fin de timeline (rotate -24°, y -3, origine coin bas-droit,
 * origine intégrée à la matrice). Rendue telle quelle quand il n'y a pas de cérémonie : aucune image intermédiaire.
 */
const OPEN_SHACKLE_MATRIX = 'matrix(0.91355,-0.40674,0.40674,0.91355,-3.04771,4.66216)';

const Padlock: React.FC<{ className?: string; open?: boolean }> = ({ className, open = false }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
    <path
      data-shackle
      d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      transform={open ? OPEN_SHACKLE_MATRIX : undefined}
      style={{ transformBox: 'fill-box', transformOrigin: open ? '0px 0px' : '100% 100%' }}
    />
    <rect x="4.5" y="11" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
    <circle cx="12" cy="16" r="1.4" fill="currentColor" />
  </svg>
);

/* -------------------------------------------------------------------------- */
/* Attestation avant signature                                                */
/* -------------------------------------------------------------------------- */

interface ValidationAttestationProps {
  synthesis: Synthesis;
  mode: AuditMode;
  onValidate: () => Promise<boolean>;
}

export const ValidationAttestation: React.FC<ValidationAttestationProps> = ({
  synthesis,
  mode,
  onValidate,
}) => {
  const [attested, setAttested] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const summary = useMemo(() => {
    const findings = synthesis.findings || [];
    const gaps = findings.filter((f) => f.statut !== 'conforme');
    const bySeverity = SEVERITY_ORDER.map((s) => ({
      ...s,
      count: gaps.filter((f) => f.gravite === s.key).length,
    })).filter((s) => s.count > 0);
    return {
      total: findings.length,
      gaps: gaps.length,
      toConfirm: findings.filter((f) => f.statut === 'a_confirmer').length,
      arbitrated: findings.filter((f) => Boolean(f.decision_grc)).length,
      bySeverity,
    };
  }, [synthesis.findings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attested || submitting) return;
    setSubmitting(true);
    try {
      await onValidate();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl badge-warning flex items-center justify-center shrink-0">
          <Padlock className="w-5 h-5" />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-extrabold text-main">
            Attester et sceller la synthèse {modeLabel(mode)}
          </h3>
          <p className="text-sm text-sub max-w-prose">
            Les {LOCKED_EXPORTS} livrables (rapport, dossier de preuve, notifications ANSSI et CNIL,
            brief COMEX…) restent verrouillés tant qu&apos;un consultant n&apos;a pas signé cette
            synthèse. La signature est inscrite dans le registre SHA-256.
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl overflow-hidden border border-hairline bg-[var(--border-subtle)]">
        <div className="surface-card px-4 py-3">
          <dt className="text-[11px] text-sub">Constats revus</dt>
          <dd className="text-xl font-extrabold text-main tabular-nums">{summary.total}</dd>
        </div>
        <div className="surface-card px-4 py-3">
          <dt className="text-[11px] text-sub">Écarts</dt>
          <dd className="text-xl font-extrabold text-main tabular-nums">{summary.gaps}</dd>
        </div>
        <div className="surface-card px-4 py-3">
          <dt className="text-[11px] text-sub">À confirmer</dt>
          <dd
            className={`text-xl font-extrabold tabular-nums ${
              summary.toConfirm > 0 ? 'tone-warning' : 'text-main'
            }`}
          >
            {summary.toConfirm}
          </dd>
        </div>
        <div className="surface-card px-4 py-3">
          <dt className="text-[11px] text-sub">Arbitrages GRC</dt>
          <dd className="text-xl font-extrabold text-main tabular-nums">{summary.arbitrated}</dd>
        </div>
      </dl>

      {summary.bySeverity.length > 0 && (
        <p className="text-xs text-sub">
          Dont{' '}
          {summary.bySeverity.map((s, i) => (
            <React.Fragment key={s.key}>
              {i > 0 && (i === summary.bySeverity.length - 1 ? ' et ' : ', ')}
              <span className={`font-bold tabular-nums ${s.tone}`}>
                {s.count} {s.label}
              </span>
            </React.Fragment>
          ))}
          .
        </p>
      )}

      {summary.toConfirm > 0 && (
        <p
          role="note"
          className="badge-warning rounded-xl px-3.5 py-2.5 text-xs flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>
            {summary.toConfirm} constat{summary.toConfirm > 1 ? 's restent' : ' reste'} à confirmer
            avec le client. Vous pouvez signer, mais ils figureront comme tels dans les livrables.
          </span>
        </p>
      )}

      <label className="flex items-start gap-3 rounded-xl border border-hairline surface-card px-4 py-3 cursor-pointer hover:border-strong transition">
        <input
          type="checkbox"
          checked={attested}
          onChange={(e) => setAttested(e.target.checked)}
          className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--deloitte)] cursor-pointer"
        />
        <span className="text-sm text-main">
          J&apos;atteste avoir revu les {summary.total} constats de la phase {modeLabel(mode)} et
          j&apos;en assume la signature au nom de la mission.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!attested || submitting}
          aria-disabled={!attested || submitting}
          className="inline-flex items-center gap-2 bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-black font-extrabold text-sm px-5 py-2.5 rounded-xl transition cursor-pointer"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4" />
          )}
          <span>{submitting ? 'Scellement…' : 'Signer et débloquer les livrables'}</span>
        </button>
        {!attested && (
          <span className="text-xs text-sub">Cochez l&apos;attestation pour activer la signature.</span>
        )}
      </div>
    </form>
  );
};

/* -------------------------------------------------------------------------- */
/* Sceau post-validation (moment signature)                                   */
/* -------------------------------------------------------------------------- */

interface SealBannerProps {
  mode: AuditMode;
  hash: string;
  /** Joue la cérémonie une fois, juste après la signature dans cette session. */
  play: boolean;
  sealedAt: Date | null;
}

/** Signatures dont la cérémonie a déjà été jouée : un remontage affiche l'état final statique. */
const playedSeals = new Set<string>();

export const SealBanner: React.FC<SealBannerProps> = ({ mode, hash, play, sealedAt }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);
  const shortHash = hash ? hash.slice(0, 24) : '';
  // Clé = instant de signature (stable), et non l'empreinte : celle-ci change juste après le montage
  // quand le registre reçoit l'entrée de validation, ce qui relançait l'effet.
  const sealKey = `${mode}:${sealedAt ? sealedAt.getTime() : 'static'}`;
  // Décidé une seule fois au montage : la cérémonie ne se rejoue jamais pour la même signature.
  const [animate] = useState(() => play && sealedAt !== null && !playedSeals.has(sealKey));
  // Le déchiffrement de l'empreinte démarre quand les détails deviennent visibles (piloté par la timeline).
  const [decrypting, setDecrypting] = useState(false);
  // Sans cérémonie (déjà jouée ou mouvement réduit), le cadenas est rendu ouvert dès la première image.
  const [staticOpen] = useState(() => !animate || prefersReducedMotion());

  useGSAP(
    () => {
      const root = rootRef.current;
      const counter = counterRef.current;
      if (!root || !counter) return;
      const shackle = root.querySelector('[data-shackle]');
      // Sans cérémonie, l'anse est déjà rendue ouverte (prop open) : seul le compteur est renseigné.
      const OPEN_POSE = { y: -3, rotate: -24, transformOrigin: '100% 100%' };
      const settle = () => {
        counter.textContent = '0';
      };

      if (!animate) {
        settle();
        return;
      }
      playedSeals.add(sealKey);

      if (prefersReducedMotion()) {
        // Mouvement réduit : état final immédiat, la confirmation passe par le texte et la couleur.
        settle();
        return;
      }

      // Compteur piloté uniquement par GSAP (nœud sans enfant React, masqué aux lecteurs d'écran).
      counter.textContent = String(LOCKED_EXPORTS);
      const tally = { n: LOCKED_EXPORTS };
      gsap
        .timeline({ defaults: { ease: EASE_OUT } })
        .fromTo(
          root,
          { clipPath: 'inset(0 100% 0 0 round 16px)' },
          { clipPath: 'inset(0 0% 0 0 round 16px)', duration: DURATION.focal, clearProps: 'clipPath' }
        )
        .fromTo(
          shackle,
          { y: 0, rotate: 0, transformOrigin: '100% 100%' },
          // Même pose finale que le rendu statique (translateY(-3px) rotate(-24deg), origine coin bas-droit).
          { ...OPEN_POSE, duration: 0.45, ease: EASE_OUT },
          '-=0.35'
        )
        .to(
          tally,
          {
            n: 0,
            duration: 0.6,
            ease: 'power2.out',
            onUpdate: () => {
              counter.textContent = String(Math.round(tally.n));
            },
          },
          '<'
        )
        .call(() => setDecrypting(true), undefined, '<')
        .fromTo(
          root.querySelectorAll('[data-seal-detail]'),
          { opacity: 0, y: 6 },
          // Les détails arrivent pendant le décompte : le déchiffrement de l'empreinte reste visible.
          { opacity: 1, y: 0, duration: DURATION.view, stagger: 0.06 },
          '<0.1'
        );
    },
    // Joué une seule fois au montage (état figé ensuite, même si l'empreinte se met à jour).
    { scope: rootRef, dependencies: [animate] }
  );

  return (
    <div
      ref={rootRef}
      role="status"
      className="rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-soft)] px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-3"
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[var(--deloitte)] text-black flex items-center justify-center">
          <Padlock className="w-5 h-5" open={staticOpen} />
        </div>
        <div>
          <p className="text-sm font-extrabold text-main">
            Synthèse {modeLabel(mode)} scellée
          </p>
          <p className="text-xs text-sub">
            <span aria-hidden="true">
              Verrous restants :{' '}
              <span ref={counterRef} className="font-bold text-main tabular-nums" /> / {LOCKED_EXPORTS}
            </span>
            <span className="sr-only">Les {LOCKED_EXPORTS} livrables sont déverrouillés.</span>
          </p>
        </div>
      </div>

      {shortHash && (
        <div data-seal-detail className="min-w-0">
          <p className="text-[11px] text-sub">Empreinte de tête du registre</p>
          <p className="font-mono text-xs text-main inline-block w-[26ch] whitespace-nowrap overflow-hidden">
            <span aria-hidden="true">
              {animate && !decrypting && !staticOpen ? (
                <span className="text-dim">{'·'.repeat(shortHash.length)}</span>
              ) : animate && decrypting ? (
                <DecryptedText
                  text={shortHash}
                  animateOn="view"
                  sequential
                  speed={18}
                  characters="0123456789abcdef"
                  encryptedClassName="text-dim"
                />
              ) : (
                shortHash
              )}
              …
            </span>
            <span className="sr-only">{hash}</span>
          </p>
        </div>
      )}

      {sealedAt && (
        <div data-seal-detail>
          <p className="text-[11px] text-sub">Signée le</p>
          <p className="text-xs font-bold text-main tabular-nums">
            {sealedAt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}
          </p>
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Ce que la signature débloque (12 livrables verrouillés)                    */
/* -------------------------------------------------------------------------- */

const DELIVERABLE_GROUPS: { title: string; items: { name: string; detail: string }[] }[] = [
  {
    title: 'Réglementaire',
    items: [
      { name: 'Pré-notification ANSSI', detail: 'NIS2 Art. 23' },
      { name: 'Évaluation CNIL', detail: 'RGPD Art. 33 et 34' },
      { name: 'Brief COMEX', detail: 'NIS2 Art. 20' },
    ],
  },
  {
    title: 'Mission',
    items: [
      { name: 'Rapport d’audit NIS2', detail: 'Format A4' },
      { name: 'Courriel au DSI', detail: 'Texte prêt à envoyer' },
      { name: 'Guide d’entretien contradictoire', detail: 'Questions AVANT / APRÈS' },
      { name: 'Registre des arbitrages GRC', detail: 'Décisions et porteurs' },
    ],
  },
  {
    title: 'Données et preuves',
    items: [
      { name: 'Synthèse scellée', detail: 'JSON signé HMAC' },
      { name: 'Matrice GRC', detail: 'CSV' },
      { name: 'Dossier de preuve', detail: 'Archive .zip, 12 pièces et manifeste SHA-256' },
    ],
  },
  {
    title: 'Remédiation',
    items: [
      { name: 'Manifeste Terraform', detail: 'À revoir en pull request, jamais appliqué' },
      { name: 'Playbook gcloud', detail: 'Exécution à blanc (dry-run)' },
    ],
  },
];

export const LockedDeliverablesList: React.FC = () => (
  <section aria-labelledby="locked-list-title" className="surface-panel rounded-2xl p-5 sm:p-6">
    <h3 id="locked-list-title" className="text-base font-semibold text-main">
      Ce que la signature débloque
    </h3>
    <p className="mt-1 text-xs text-sub">
      Chaque export répond 403 tant que la synthèse n&apos;est pas signée, et se reverrouille si un arbitrage change.
    </p>
    <div className="mt-4 space-y-4">
      {DELIVERABLE_GROUPS.map((group) => (
        <div key={group.title}>
          <h4 className="text-xs font-semibold text-sub">{group.title}</h4>
          <ul className="mt-1.5 divide-y divide-[var(--border-subtle)] border-y border-hairline">
            {group.items.map((item) => (
              <li key={item.name} className="py-2 flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm text-main">{item.name}</span>
                  <span className="block text-xs text-sub">{item.detail}</span>
                </span>
                <Padlock className="w-4 h-4 text-[var(--warning-text)] shrink-0" />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  </section>
);
