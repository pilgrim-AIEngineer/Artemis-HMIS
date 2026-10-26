import { readFile } from 'node:fs/promises';
import { readRxScan } from '@hmis/db';
import { absolutePath, filesDirFromEnv } from '@hmis/db/files';
import { uuidSchema, type Permission } from '@hmis/shared';
import { resolveSession, sessionTokenFromHeaders } from '@/server/auth/session';
import { getDb } from '@/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Who may look at a paper Rx photo: the assistant, the verifying doctor, pharmacy (docs/03). */
const VIEWERS: Permission[] = ['rx.transcribe', 'rx.verify', 'rx.view'];

const plain = (status: number) =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * The stored photo of a paper prescription (`document.kind = rx_scan`, docs/11 §2.2). The URL
 * carries the document id only (AGENTS.md rule 15); the session and permission are checked here
 * as in every procedure, and restricted (MTP) visits are never served.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return plain(404);
  const db = getDb();
  const auth = await resolveSession(db, sessionTokenFromHeaders(req.headers), new Date());
  if (!auth) return plain(401);
  if (auth.state !== 'active' || !VIEWERS.some((p) => auth.permissions.has(p))) return plain(403);
  const doc = await readRxScan(db, auth.facilityId, id);
  if (!doc) return plain(404);
  try {
    const bytes = await readFile(absolutePath(filesDirFromEnv(), doc.filePath));
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': doc.mime,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    });
  } catch {
    return plain(404);
  }
}
