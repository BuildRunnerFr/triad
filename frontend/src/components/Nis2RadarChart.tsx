import React, { useMemo } from 'react';
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import type { Finding, ThemeMode } from '../types';

interface Nis2RadarChartProps {
  findings: Finding[];
  theme: ThemeMode;
}

interface RadarDomainPoint {
  domain: string;
  declare: number;
  reel: number;
  ecart: number;
}

export const Nis2RadarChart: React.FC<Nis2RadarChartProps> = ({ findings, theme }) => {
  const data = useMemo<RadarDomainPoint[]>(() => {
    const scoreFinding = (f: Finding | undefined, fallbackReal: number): number => {
      if (!f) return fallbackReal;
      if (f.statut === 'conforme') return 92;
      if (f.statut === 'partiel') return 55;
      if (f.statut === 'a_confirmer') return 45;
      return f.gravite === 'critique' ? 14 : 28;
    };

    const findMatch = (keywords: string[]) =>
      findings.find((f) => {
        const hay = `${f.theme} ${f.exigence_nis2} ${f.lot_nis2 || ''}`.toLowerCase();
        return keywords.some((k) => hay.includes(k));
      });

    const fBackup = findings.filter((f) =>
      `${f.theme} ${f.exigence_nis2}`.toLowerCase().match(/sauvegarde|restauration|pca|backup/)
    );
    const backupReal =
      fBackup.length > 0
        ? Math.round(
            fBackup.reduce((acc, item) => acc + scoreFinding(item, 40), 0) / fBackup.length
          )
        : 35;

    const fNet = findMatch(['ssh', 'pare-feu', 'réseau', 'firewall', 'exposition réseau']);
    const fData = findMatch(['radiologie', 'bucket', 'public', 'stockage', 'exposition des données']);
    const fCrypto = findMatch(['chiffrement', 'cryptographie', 'kms', 'iam', 'mfa', 'privil']);
    const fNotif = findMatch(['notification', 'anssi', 'incident', '23']);

    const rows = [
      { domain: 'Sauvegardes & PCA', declare: 92, reel: backupReal },
      { domain: 'Sécurité Réseau', declare: 90, reel: scoreFinding(fNet, 20) },
      { domain: 'Protection Données', declare: 95, reel: scoreFinding(fData, 16) },
      { domain: 'Crypto & Accès IAM', declare: 84, reel: scoreFinding(fCrypto, 58) },
      { domain: 'Notification ANSSI', declare: 86, reel: scoreFinding(fNotif, 18) },
    ];

    return rows.map((r) => ({
      ...r,
      ecart: r.declare - r.reel,
    }));
  }, [findings]);

  const avgGap = useMemo(() => {
    if (!data.length) return 0;
    return Math.round(data.reduce((s, d) => s + d.ecart, 0) / data.length);
  }, [data]);

  // Écran étroit : rayon réduit pour que les libellés d'axes ne soient pas rognés
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const gridStroke = theme === 'dark' ? 'rgba(238,242,238,0.12)' : 'rgba(20,26,22,0.14)';
  const labelFill = theme === 'dark' ? '#A9B5AD' : '#46504A';
  // Déclaré = couleur du Dit ; Réel vérifié = couleur du Réel (teintes des piliers)
  const declareStroke = theme === 'dark' ? '#7EA4FF' : '#2350B8';
  const reelStroke = theme === 'dark' ? '#9BD03A' : '#2D7A0C';

  return (
    <section className="pt-5 border-t border-hairline flex flex-col justify-between h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-base font-semibold text-main">Déclaré face au réel</h3>

        <p className="text-xs text-sub">
          Écart moyen{' '}
          <span className="text-[var(--rupture)] font-bold tabular-nums text-sm">−{avgGap} pts</span>
        </p>
      </div>

      <div className="w-full h-[270px]">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart cx="50%" cy="52%" outerRadius={narrow ? '52%' : '72%'} data={data}>
            <PolarGrid stroke={gridStroke} />
            <PolarAngleAxis
              dataKey="domain"
              tick={{ fill: labelFill, fontSize: narrow ? 10 : 11, fontWeight: 600 }}
            />
            <PolarRadiusAxis
              angle={90}
              domain={[0, 100]}
              tick={false}
              axisLine={false}
            />
            <Radar
              isAnimationActive={false}
              name="Déclaré (Dit & Écrit)"
              dataKey="declare"
              stroke={declareStroke}
              strokeWidth={2}
              strokeDasharray="4 3"
              fill={declareStroke}
              fillOpacity={0.14}
            />
            <Radar
              isAnimationActive={false}
              name="Vérifié (Réel Cloud & Preuves)"
              dataKey="reel"
              stroke={reelStroke}
              strokeWidth={2.5}
              fill={reelStroke}
              fillOpacity={0.32}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: theme === 'dark' ? '#1A231E' : '#FFFFFF',
                borderColor: theme === 'dark' ? 'rgba(238,242,238,0.2)' : 'rgba(20,26,22,0.24)',
                borderRadius: '8px',
                fontSize: '12px',
                color: theme === 'dark' ? '#EEF2EE' : '#141A16',
              }}
              formatter={(value, name) => [`${value ?? 0}/100`, String(name ?? '')]}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Légende compacte */}
      <div className="pt-3 border-t border-hairline flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5 text-sub font-medium">
            <span className="w-3 h-0.5 border-t-2 border-dashed border-[var(--dit)] inline-block" />
            Déclaré
          </span>
          <span className="inline-flex items-center gap-1.5 text-main font-semibold">
            <span className="w-3 h-2 rounded-xs bg-[var(--reel)]/40 border border-[var(--reel)] inline-block" />
            Réel vérifié
          </span>
        </div>
        <span className="text-sub">Art. 21 et 23</span>
      </div>
    </section>
  );
};
