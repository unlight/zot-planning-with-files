/** Write the release version into the manifest and package metadata. */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const JSON_FILES = ['extension.json', 'package.json'];
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJsonVersion(fileName: string, version: string): void {
  const filePath = path.join(ROOT, fileName);
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isObject(parsed)) throw new Error(`${fileName} is not a JSON object`);
  const updated = { ...parsed, version };
  writeFileSync(filePath, `${JSON.stringify(updated, undefined, 2)}\n`, 'utf8');
}

/** Writes the root version into package-lock.json, including its packages entry. */
function writePackageLockVersion(version: string): void {
  const fileName = 'package-lock.json';
  const filePath = path.join(ROOT, fileName);
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isObject(parsed) || !isObject(parsed.packages)) {
    throw new Error(`${fileName} has no packages map`);
  }
  const root = parsed.packages[''];
  if (!isObject(root)) throw new Error(`${fileName} has no root package`);
  const packages = { ...parsed.packages, '': { ...root, version } };
  const updated = { ...parsed, version, packages };
  writeFileSync(filePath, `${JSON.stringify(updated, undefined, 2)}\n`, 'utf8');
}

function syncVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid semantic version: ${JSON.stringify(version)}`);
  }
  for (const fileName of JSON_FILES) writeJsonVersion(fileName, version);
  writePackageLockVersion(version);
}

const version = process.argv[2];
if (version === undefined) {
  throw new Error('usage: sync-version.ts <version>');
}
syncVersion(version);
