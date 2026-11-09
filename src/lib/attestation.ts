import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { AttestationCheck, PlanStatus } from './types.ts';

function normalizeHash(value: string): string | undefined {
  const hash = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

function readExpectedHash(path: string): string | undefined {
  try {
    return normalizeHash(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function checkPlanAttestation(status: PlanStatus): AttestationCheck {
  if (!status.exists || !status.planPath) {
    return { enabled: false, tampered: false };
  }

  const attestationPath = status.attestationPath;
  if (!attestationPath) {
    return { enabled: false, tampered: false };
  }

  const expected = readExpectedHash(attestationPath);
  if (!expected) {
    return { enabled: true, tampered: true, attestationPath };
  }

  const actual = status.planSha256;
  if (!actual) {
    return { enabled: true, tampered: true, expected, attestationPath };
  }

  return {
    enabled: true,
    tampered: actual !== expected,
    expected,
    actual,
    attestationPath,
  };
}

export function writePlanAttestation(status: PlanStatus, hash: string): string {
  const attestationPath = status.attestationCandidates[0];
  if (!attestationPath) {
    throw new Error('no attestation path for this plan');
  }

  mkdirSync(path.dirname(attestationPath), { recursive: true });
  const temporary = `${attestationPath}.tmp.${process.pid}`;
  writeFileSync(temporary, `${hash}\n`, 'utf8');
  renameSync(temporary, attestationPath);
  return attestationPath;
}

export function clearPlanAttestation(status: PlanStatus): string[] {
  const removed: string[] = [];
  for (const candidate of status.attestationCandidates) {
    if (!existsSync(candidate)) continue;
    unlinkSync(candidate);
    removed.push(candidate);
  }
  return removed;
}
