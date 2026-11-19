import type { AuditLogEntry } from '../types';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Sérialisation JSON canonique strictement identique à :
 * `json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))` en Python.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`
  );
  return `{${pairs.join(',')}}`;
}

export interface BlockVerificationResult {
  blockNum: number;
  recordedHash: string;
  recomputedHash: string;
  prevHashValid: boolean;
  hashValid: boolean;
  valid: boolean;
}

export interface BrowserChainVerificationReport {
  supported: boolean;
  allValid: boolean;
  verifiedCount: number;
  totalCount: number;
  headHash: string;
  durationMs: number;
  byBlock: Record<number, BlockVerificationResult>;
  errorMessage: string | null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digestBuffer = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digestBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Recalcule localement dans le navigateur chaque empreinte SHA-256 de la chaîne d'audit
 * via l'API standard WebCrypto (`crypto.subtle.digest`).
 */
export async function verifyAuditChainInBrowser(
  entries: AuditLogEntry[]
): Promise<BrowserChainVerificationReport> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    return {
      supported: false,
      allValid: false,
      verifiedCount: 0,
      totalCount: entries.length,
      headHash: GENESIS_HASH,
      durationMs: 0,
      byBlock: {},
      errorMessage: 'API WebCrypto non disponible dans ce contexte navigateur.',
    };
  }

  const t0 = performance.now();
  let expectedPrev = GENESIS_HASH;
  let verifiedCount = 0;
  let firstError: string | null = null;
  const byBlock: Record<number, BlockVerificationResult> = {};

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const blockNum = i + 1;

    const core: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (k !== 'prev_hash' && k !== 'hash') {
        core[k] = v;
      }
    }

    const canonical = canonicalizeJson(core);
    const recomputedHash = await sha256Hex(`${canonical}${expectedPrev}`);
    const prevHashValid = entry.prev_hash === expectedPrev;
    const hashValid = recomputedHash === entry.hash;
    const valid = prevHashValid && hashValid;

    if (valid) {
      verifiedCount += 1;
    } else if (!firstError) {
      firstError = !prevHashValid
        ? `Rupture du chaînage prev_hash détectée au bloc #${blockNum}.`
        : `Empreinte SHA-256 discordante au bloc #${blockNum}.`;
    }

    byBlock[blockNum] = {
      blockNum,
      recordedHash: entry.hash,
      recomputedHash,
      prevHashValid,
      hashValid,
      valid,
    };

    expectedPrev = recomputedHash;
  }

  const durationMs = Math.max(0.1, Number((performance.now() - t0).toFixed(2)));

  return {
    supported: true,
    allValid: firstError === null,
    verifiedCount,
    totalCount: entries.length,
    headHash: entries.length > 0 ? expectedPrev : GENESIS_HASH,
    durationMs,
    byBlock,
    errorMessage: firstError,
  };
}
