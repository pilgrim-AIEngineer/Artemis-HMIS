/**
 * `pnpm check:forbidden` — fails (exit 1) if any forbidden PCPNDT term is found.
 * See docs/30-compliance.md §1 and ./scan.ts for scope rules.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFinding, listFiles, scanRepo } from './scan';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const files = listFiles(repoRoot).length;
const findings = scanRepo(repoRoot);

if (findings.length > 0) {
  console.error(`check:forbidden: ${findings.length} forbidden term(s) found:\n`);
  for (const f of findings) console.error(`  ${formatFinding(f)}`);
  console.error('\nSee AGENTS.md rule 7 and docs/30-compliance.md §1 (PCPNDT).');
  process.exit(1);
}

console.log(`check:forbidden: OK (${files} files scanned)`);
