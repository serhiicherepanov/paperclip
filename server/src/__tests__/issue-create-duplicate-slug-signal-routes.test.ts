import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres duplicate-slug-signal tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Exercises issueService(db).create() directly (no HTTP layer) — this is the
// same pattern the existing "does not apply the route soft guard to internal
// service creates" test in issue-create-deduplication-routes.test.ts uses, and
// it is what routes/issues.ts POST /api/companies/{companyId}/issues calls
// into after request validation. Covers DIG-4566 acceptance criterion 7 (a-d).
describeEmbeddedPostgres("issue create duplicate-slug signal (DIG-4556 variant c)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-duplicate-slug-signal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedRoot(companyId: string) {
    const [root] = await db.insert(issues).values({
      companyId,
      title: "Plan: some-project — root of the decomposition",
      status: "todo",
      priority: "medium",
    }).returning();
    return root;
  }

  it("(a) flags a non-terminal sibling with the same type-prefix and slug", async () => {
    const companyId = await seedCompany();
    const root = await seedRoot(companyId);
    const svc = issueService(db);

    const first = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: widget-export-pipeline — first pass",
      status: "todo",
      priority: "medium",
    });
    expect((first as any).possibleDuplicates).toEqual([]);

    const second = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: widget-export-pipeline — second pass, different text",
      status: "todo",
      priority: "medium",
    });

    expect(second.id).not.toBe(first.id);
    expect((second as any).possibleDuplicates).toHaveLength(1);
    expect((second as any).possibleDuplicates[0]).toMatchObject({
      id: first.id,
      identifier: first.identifier,
      title: first.title,
      status: "todo",
    });
  });

  it("(b) returns an empty signal when the slug differs", async () => {
    const companyId = await seedCompany();
    const root = await seedRoot(companyId);
    const svc = issueService(db);

    await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: widget-export-pipeline — first pass",
      status: "todo",
      priority: "medium",
    });
    const other = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: unrelated-feature-x — unrelated work",
      status: "todo",
      priority: "medium",
    });

    expect((other as any).possibleDuplicates).toEqual([]);
  });

  it("(c) excludes terminal (done/cancelled) siblings from the signal", async () => {
    const companyId = await seedCompany();
    const root = await seedRoot(companyId);
    const svc = issueService(db);

    const done = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: widget-export-pipeline — done already",
      status: "todo",
      priority: "medium",
    });
    await svc.update(done.id, { status: "done" });

    const cancelled = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: widget-export-pipeline — cancelled attempt",
      status: "todo",
      priority: "medium",
    });
    await svc.update(cancelled.id, { status: "cancelled" });

    const fresh = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: widget-export-pipeline — third attempt",
      status: "todo",
      priority: "medium",
    });

    expect((fresh as any).possibleDuplicates).toEqual([]);
  });

  it("(d) never blocks a legitimate S1-S4 multi-slice decomposition that reuses one slug", async () => {
    const companyId = await seedCompany();
    const root = await seedRoot(companyId);
    const svc = issueService(db);

    const created: string[] = [];
    const slices = ["S1 — config parity", "S2 — deploy manifests", "S3 — release scripts", "S4 — runbook"];
    for (const [index, slice] of slices.entries()) {
      const response = await svc.create(companyId, {
        parentId: root.id,
        title: `Implement: sample-toolkit — ${slice}`,
        status: "todo",
        priority: "medium",
      });
      created.push(response.id);
      if (index === 0) {
        expect((response as any).possibleDuplicates).toEqual([]);
      } else {
        // Non-empty is the expected, normal shape here — it is a signal, not a rejection.
        expect((response as any).possibleDuplicates).toHaveLength(index);
      }
    }

    expect(new Set(created).size).toBe(4);
    const rows = await db.select().from(issues).where(eq(issues.parentId, root.id));
    expect(rows).toHaveLength(4);
  });

  it("matches a same-root cousin created under a different direct parent", async () => {
    const companyId = await seedCompany();
    const root = await seedRoot(companyId);
    const svc = issueService(db);

    const branchA = await svc.create(companyId, {
      parentId: root.id,
      title: "Review: widget-export-pipeline — branch A",
      status: "todo",
      priority: "medium",
    });
    const branchB = await svc.create(companyId, {
      parentId: root.id,
      title: "Plan: widget-export-pipeline — branch B",
      status: "todo",
      priority: "medium",
    });

    // Grandchild under branch B, same root as the sibling created under branch A.
    const cousin = await svc.create(companyId, {
      parentId: branchB.id,
      title: "Review: widget-export-pipeline — cousin under branch B",
      status: "todo",
      priority: "medium",
    });

    expect((cousin as any).possibleDuplicates).toHaveLength(1);
    expect((cousin as any).possibleDuplicates[0].id).toBe(branchA.id);
  });

  it("(e) does not disturb the idempotency-key dedup branch", async () => {
    const companyId = await seedCompany();
    const root = await seedRoot(companyId);
    const svc = issueService(db);
    let dedupReason: string | null = null;

    const first = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: prepare-release — first attempt",
      status: "todo",
      priority: "medium",
      idempotencyKey: "run-1:prepare-release",
    } as any);
    const replay = await svc.create(companyId, {
      parentId: root.id,
      title: "Implement: prepare-release — different retry payload",
      status: "todo",
      priority: "medium",
      idempotencyKey: "run-1:prepare-release",
      onDeduplicated: (reason: string) => { dedupReason = reason; },
    } as any);

    // Same underlying issue is returned instead of a second insert — the
    // idempotency-key branch (untouched by this change) still owns the reply.
    expect(replay.id).toBe(first.id);
    expect(dedupReason).toBe("idempotency_key");
  });
});
