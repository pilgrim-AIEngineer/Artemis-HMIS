/**
 * Repository scan for `pnpm check:forbidden` (docs/30-compliance.md §1).
 * Node-only (filesystem); not exported from the package root.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import {
  findForbiddenTerms,
  isAllowedKeyPath,
  type ForbiddenHit,
  type ForbiddenTier,
} from './forbidden-terms';

/** Top-level directories that hold code, schema, templates, seed data and i18n files. */
export const SCAN_ROOTS = ['apps', 'packages', 'infra', '.github'] as const;

/**
 * USG / Form F / AI-prompt scope (docs/30 §1): every term applies.
 * Paths are as written in docs/30, plus the `src/` variant and directory forms
 * (anything inside a `usg*` directory is in scope too).
 */
export const STRICT_SCOPE_GLOBS = [
  'packages/print/**/usg*',
  'packages/print/**/usg*/**',
  'packages/shared/**/usg*',
  'packages/shared/**/usg*/**',
  'packages/db/schema/usg*',
  'packages/db/schema/**/usg*',
  'packages/db/schema/**/usg*/**',
  'packages/db/seed/**/usg*',
  'packages/db/seed/**/usg*/**',
  'packages/shared/forms/form-f*',
  'packages/shared/src/forms/form-f*',
  // AI prompt files: by convention live in a `prompts/` directory or are named `*.prompt.*`.
  '**/prompts/**',
  '**/*.prompt.*',
] as const;

/** i18n message files (scanned key by key; see `I18N_STRICT_NAMESPACE`). */
export const I18N_GLOBS = ['**/messages/*.json', '**/locales/**/*.json', '**/i18n/**/*.json'];

/** i18n keys with a segment matching this are USG / Form F scope and get every term. */
export const I18N_STRICT_NAMESPACE = /^(usg|form_?f|pcpndt|ai)/i;

/**
 * Files that must spell out the terms: the compliance doc and the checker's own term list.
 * Exact paths only.
 */
export const ALLOWLISTED_FILES = [
  'docs/30-compliance.md',
  'packages/shared/src/compliance/forbidden-terms.ts',
] as const;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
]);

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface ScanFinding extends ForbiddenHit {
  file: string;
  /** 1-based line number, or the JSON key path for structured i18n files. */
  location: string;
  scope: ForbiddenTier;
}

/**
 * D-5(b): directories that are strict in full, whatever the file is called.
 * `*.sql` anywhere is strict too.
 */
export const STRICT_DIR_GLOBS = [
  'packages/db/schema/**',
  'packages/db/migrations/**',
  'packages/db/seed/**',
  'packages/print/**',
  '**/*.sql',
] as const;

/** D-5(b): any path segment starting with one of these is strict. */
export const STRICT_SEGMENT =
  /^(anc|antenatal|pregnan|obstet|usg|ultrasound|sonograph|scan|form[-_]?f|mtp|labour)/i;

/** D-5(c): born-baby paths stay on the `always` tier (never overrides prompts). */
export const BORN_BABY_SEGMENT = /^(newborn|birth|death|vaccin|paed|pediatric)/i;

const strictMatcher = picomatch([...STRICT_SCOPE_GLOBS], { dot: true, nocase: true });
const strictDirMatcher = picomatch([...STRICT_DIR_GLOBS], { dot: true, nocase: true });
const i18nMatcher = picomatch(I18N_GLOBS, { dot: true });

export function scopeFor(relPath: string): ForbiddenTier {
  if (strictMatcher(relPath)) return 'strict';
  const segments = relPath.split('/');
  if (segments.some((s) => BORN_BABY_SEGMENT.test(s))) return 'always';
  return strictDirMatcher(relPath) || segments.some((s) => STRICT_SEGMENT.test(s))
    ? 'strict'
    : 'always';
}

export function listFiles(root: string, roots: readonly string[] = SCAN_ROOTS): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function scanLines(file: string, text: string, scope: ForbiddenTier): ScanFinding[] {
  const findings: ScanFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const hit of findForbiddenTerms(line, { tier: scope })) {
      findings.push({ ...hit, file, location: String(i + 1), scope });
    }
  });
  return findings;
}

/** Flattens JSON to `[keyPath, keyName, stringValue?]` entries; array elements become `[]`. */
function* walkJson(value: unknown, keyPath = ''): Generator<[string, string | undefined]> {
  if (Array.isArray(value)) {
    for (const v of value) yield* walkJson(v, `${keyPath}[]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = keyPath ? `${keyPath}.${k}` : k;
      yield [p, undefined];
      yield* walkJson(v, p);
    }
  } else if (typeof value === 'string') {
    yield [keyPath, value];
  }
}

function scanI18n(file: string, text: string, fileScope: ForbiddenTier): ScanFinding[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const findings: ScanFinding[] = [];
  for (const [keyPath, value] of walkJson(json)) {
    const segments = keyPath.replaceAll('[]', '').split('.');
    const scope: ForbiddenTier =
      fileScope === 'strict' || segments.some((s) => I18N_STRICT_NAMESPACE.test(s))
        ? 'strict'
        : 'always';
    const subject = value ?? segments[segments.length - 1] ?? '';
    for (const hit of findForbiddenTerms(subject, { tier: scope })) {
      if (hit.tier === 'strict' && isAllowedKeyPath(keyPath)) continue;
      findings.push({ ...hit, file, location: keyPath, scope });
    }
  }
  return findings;
}

export function scanFile(root: string, relPath: string): ScanFinding[] {
  if ((ALLOWLISTED_FILES as readonly string[]).includes(relPath)) return [];
  const scope = scopeFor(relPath);
  const findings: ScanFinding[] = findForbiddenTerms(relPath, { tier: scope }).map((hit) => ({
    ...hit,
    file: relPath,
    location: 'path',
    scope,
  }));

  const abs = path.join(root, relPath);
  if (statSync(abs).size > MAX_FILE_BYTES) {
    throw new Error(`check:forbidden: ${relPath} is larger than ${MAX_FILE_BYTES} bytes`);
  }
  const buf = readFileSync(abs);
  if (isProbablyBinary(buf)) return findings;
  const text = buf.toString('utf8');

  if (i18nMatcher(relPath)) {
    const structured = scanI18n(relPath, text, scope);
    if (structured) return [...findings, ...structured];
  }
  return [...findings, ...scanLines(relPath, text, scope)];
}

export function scanRepo(root: string, roots: readonly string[] = SCAN_ROOTS): ScanFinding[] {
  return listFiles(root, roots).flatMap((f) => scanFile(root, f));
}

export function formatFinding(f: ScanFinding): string {
  return `${f.file}:${f.location}  [${f.termId}] matched "${f.match}" (${f.scope} scope)`;
}
