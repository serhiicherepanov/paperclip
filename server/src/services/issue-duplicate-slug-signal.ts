import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * Soft duplicate-slug signal for issue create (DIG-4556, variant c).
 *
 * Convention (DIG-2879): a scoped issue title looks like
 * "Implement: some-scope-slug — free text". This extracts the type prefix +
 * slug from a create's title and looks for other non-terminal issues in the
 * same root subtree carrying the exact same pair, so the caller can tell a
 * repeated decomposition pass from a legitimate multi-slice one apart. It
 * never blocks or replaces the create — see the DIG-4555 investigation
 * document for the false-positive analysis behind that choice (hard
 * uniqueness on today's slug convention rejects legitimate S1-S4 style
 * multi-slice decompositions that intentionally reuse one slug).
 */

export type PossibleDuplicateIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assignee: { agentId: string | null; userId: string | null } | null;
};

const MAX_POSSIBLE_DUPLICATES = 10;

// "Implement: issue-create-duplicate-slug-signal — ..." -> { typePrefix: "Implement", slug: "issue-create-duplicate-slug-signal" }.
// Requires a latin kebab slug (2+ segments) immediately after the prefix;
// anything else (no colon, cyrillic pseudo-slug, single bare word) yields no
// match and the signal is skipped for that create.
const TITLE_TYPE_SLUG_PATTERN = /^\s*([A-Za-z][A-Za-z ]{0,24}):\s*([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s—-]|$)/;

export function parseIssueTypeSlug(rawTitle: string | null | undefined): { typePrefix: string; slug: string } | null {
  const match = TITLE_TYPE_SLUG_PATTERN.exec(rawTitle ?? "");
  if (!match) return null;
  return { typePrefix: match[1].trim(), slug: match[2] };
}

function escapeForPosixRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type PossibleDuplicateRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

/**
 * Looks for other non-terminal issues in the same root subtree as `parentId`
 * whose title carries the same type-prefix + slug as `title`. Bounded to
 * MAX_POSSIBLE_DUPLICATES rows; both the upward root walk and the downward
 * subtree walk hit the existing `issues_company_parent_idx`, so this adds no
 * schema migration. Throws on failure — the caller (issueService.create)
 * decides how to degrade so a signal failure never blocks the create.
 */
export async function findPossibleDuplicateIssuesForCreate(
  tx: Db,
  params: { companyId: string; parentId: string | null; title: string; excludeIssueId: string },
): Promise<PossibleDuplicateIssue[]> {
  if (!params.parentId) return [];
  const parsed = parseIssueTypeSlug(params.title);
  if (!parsed) return [];
  const pattern = `^\\s*${escapeForPosixRegex(parsed.typePrefix)}\\s*:\\s*${escapeForPosixRegex(parsed.slug)}(?=[\\s\\u2014-]|$)`;

  const rows = Array.from(await tx.execute(sql`
    WITH RECURSIVE root_chain(id, parent_id) AS (
      SELECT id, parent_id FROM issues WHERE id = ${params.parentId}
      UNION
      SELECT p.id, p.parent_id FROM issues p JOIN root_chain rc ON p.id = rc.parent_id
    ),
    root_issue(id) AS (
      SELECT id FROM root_chain WHERE parent_id IS NULL LIMIT 1
    ),
    subtree(id) AS (
      SELECT id FROM root_issue
      UNION
      SELECT i.id FROM issues i JOIN subtree s ON i.parent_id = s.id
    )
    SELECT
      i.id,
      i.identifier,
      i.title,
      i.status,
      i.assignee_agent_id AS "assigneeAgentId",
      i.assignee_user_id AS "assigneeUserId"
    FROM issues i
    JOIN subtree st ON st.id = i.id
    WHERE i.company_id = ${params.companyId}
      AND i.id <> ${params.excludeIssueId}
      AND i.hidden_at IS NULL
      AND i.status NOT IN ('done', 'cancelled')
      AND i.title ~ ${pattern}
    ORDER BY i.created_at DESC
    LIMIT ${MAX_POSSIBLE_DUPLICATES}
  `)) as PossibleDuplicateRow[];

  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    assignee: row.assigneeAgentId || row.assigneeUserId
      ? { agentId: row.assigneeAgentId, userId: row.assigneeUserId }
      : null,
  }));
}
