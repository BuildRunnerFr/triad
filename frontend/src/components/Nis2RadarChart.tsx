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
import { Activity, TrendingDown } from 'lucide-react';
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

  const gridStroke = theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.13)';
  const labelFill = theme === 'dark' ? '#CBD5E1' : '#1E293B';
  const declareStroke = theme === 'dark' ? '#38BDF8' : '#0284C7';
  const reelStroke = theme === 'dark' ? '#86BC25' : '#659416';

  return (
    <div className="surface-panel rounded-2xl p-5 flex flex-col justify-between h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-extrabold tracking-tight text-main">
            Radar Déclaré vs Réel
          </h3>
        </div>

        <div className="badge-critical inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold">
          <TrendingDown className="w-3.5 h-3.5" />
          <span className="tabular-nums">-{avgGap} pts</span>
        </div>
      </div>

      <div className="w-full h-[270px]">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart cx="50%" cy="52%" outerRadius="72%" data={data}>
            <PolarGrid stroke={gridStroke} />
            <PolarAngleAxis
              dataKey="domain"
              tick={{ fill: labelFill, fontSize: 11, fontWeight: 600 }}
            />
            <PolarRadiusAxis
              angle={90}
              domain={[0, 100]}
              tick={false}
              axisLine={false}
            />
            <Radar
              name="Déclaré (Dit & Écrit)"
              dataKey="declare"
              stroke={declareStroke}
              strokeWidth={2}
              strokeDasharray="4 3"
              fill={declareStroke}
              fillOpacity={0.14}
            />
            <Radar
              name="Vérifié (Réel Cloud & Preuves)"
              dataKey="reel"
              stroke={reelStroke}
              strokeWidth={2.5}
              fill="#86BC25"
              fillOpacity={0.32}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: theme === 'dark' ? '#0C101B' : '#FFFFFF',
                borderColor: theme === 'dark' ? 'rgba(255,255,255,0.14)' : '#CBD5E1',
                borderRadius: '12px',
                fontSize: '12px',
                color: theme === 'dark' ? '#F8FAFC' : '#0F172A',
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
            <span className="w-3 h-0.5 border-t-2 border-dashed border-sky-500 inline-block" />
            Déclaré
          </span>
          <span className="inline-flex items-center gap-1.5 text-main font-semibold">
            <span className="w-3 h-2 rounded-xs bg-[var(--deloitte)]/60 border border-[var(--deloitte)] inline-block" />
            Réel vérifié
          </span>
        </div>
        <span className="font-mono text-dim">Art. 21 &amp; 23</span>
      </div>
    </div>
  );
};
