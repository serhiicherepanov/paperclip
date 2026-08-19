import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";

const execFileAsync = promisify(execFile);

describe("execution workspace retention reconciler", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof executionWorkspaceService>;
  const tempDirs = new Set<string>();
  const pullRequestDetailsByKey = new Map<string, {
    state: "merged" | "open" | "unknown";
    headRef: string | null;
    headSha: string | null;
  }>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-retention-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db, {
      workspaceReaperCooldownDays: 0,
      resolvePullRequestDetails: vi.fn(async (companyId, reference) =>
        pullRequestDetailsByKey.get(`${companyId}:${reference.number}`)
        ?? { state: "unknown", headRef: null, headSha: null }
      ),
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    pullRequestDetailsByKey.clear();

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function runGit(cwd: string, args: string[]) {
    await execFileAsync("git", args, { cwd });
  }

  async function createTempRepo() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retention-"));
    tempDirs.add(dir);
    await runGit(dir, ["init"]);
    await runGit(dir, ["config", "user.email", "retention@test.local"]);
    await runGit(dir, ["config", "user.name", "Retention Test"]);
    await fs.writeFile(path.join(dir, "README.md"), "seed\n", "utf8");
    await runGit(dir, ["add", "README.md"]);
    await runGit(dir, ["commit", "-m", "seed"]);
    return dir;
  }

  async function seedTerminalWorkspace(options: {
    cleanupPolicy?: Record<string, unknown> | null;
    mode?: "isolated_workspace" | "shared_workspace";
    mergedPr?: boolean;
    dirty?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issuePrefix = `R${companyId.slice(0, 8).toUpperCase()}`;
    const identifier = `${issuePrefix}-1`;
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-retention-${randomUUID()}`);
    tempDirs.add(worktreePath);
    await runGit(repoRoot, ["branch", "feature/retention"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/retention"]);
    await fs.writeFile(path.join(worktreePath, "delivered.txt"), "delivered\n", "utf8");
    await runGit(worktreePath, ["add", "delivered.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Delivered change"]);
    if (options.dirty) {
      await fs.writeFile(path.join(worktreePath, "dirty.txt"), "dirty\n", "utf8");
    }
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();

    await db.insert(companies).values({
      id: companyId,
      name: "Retention Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Retention project",
      status: "in_progress",
      executionWorkspacePolicy: options.cleanupPolicy
        ? {
            enabled: true,
            cleanupPolicy: options.cleanupPolicy,
          }
        : null,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: options.mode ?? "isolated_workspace",
      strategyType: "git_worktree",
      name: identifier,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      baseRef: "main",
      branchName: "feature/retention",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      identifier,
      title: "Delivered source issue",
      status: "done",
      priority: "medium",
      executionWorkspaceId,
      completedAt: new Date(Date.now() - 8 * 86_400_000),
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));

    if (options.mergedPr !== false) {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId: sourceIssueId,
        executionWorkspaceId,
        type: "pull_request",
        provider: "github",
        title: "Delivered PR",
        url: "https://github.com/paperclipai/paperclip/pull/99001",
        status: "merged",
      });
      pullRequestDetailsByKey.set(`${companyId}:99001`, {
        state: "merged",
        headRef: "feature/retention",
        headSha,
      });
    }

    return {
      companyId,
      projectId,
      executionWorkspaceId,
      sourceIssueId,
      worktreePath,
      terminalAnchor: new Date("2026-08-12T12:00:00.000Z"),
    };
  }

  it("archives immediately when no retention policy is configured", async () => {
    const seeded = await seedTerminalWorkspace({ cleanupPolicy: null });

    const schedule = await svc.scheduleCleanupEligibility();
    expect(schedule.skippedNoPolicy).toBeGreaterThan(0);

    const sweep = await svc.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({ archived: 1, retentionCandidates: 0, skippedRetentionPending: 0 });

    const [row] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(row?.status).toBe("archived");
  });

  it("schedules cleanupEligibleAt and logs retention_candidate without archiving in report_only mode", async () => {
    const terminalAnchor = new Date(Date.now() - 8 * 86_400_000);
    const seeded = await seedTerminalWorkspace({
      cleanupPolicy: {
        enabled: true,
        retentionDays: 7,
        mode: "report_only",
        scope: "isolated_workspace",
        excludeProjectPrimary: true,
        requireCloseReadiness: true,
      },
    });
    await db
      .update(issues)
      .set({ completedAt: terminalAnchor, updatedAt: terminalAnchor })
      .where(eq(issues.id, seeded.sourceIssueId));

    const schedule = await svc.scheduleCleanupEligibility();
    expect(schedule).toMatchObject({ scheduled: 1 });

    const [scheduledRow] = await db
      .select({ cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt, status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(scheduledRow?.status).toBe("active");
    expect(scheduledRow?.cleanupEligibleAt).not.toBeNull();
    expect(scheduledRow!.cleanupEligibleAt!.getTime()).toBeLessThanOrEqual(Date.now());

    const sweep = await svc.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({ archived: 0, retentionCandidates: 1, skippedRetentionPending: 0 });

    const [afterSweep] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(afterSweep?.status).toBe("active");
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();

    const candidateLogs = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, seeded.executionWorkspaceId));
    expect(candidateLogs.some((row) => row.action === "execution_workspace.retention_candidate")).toBe(true);
  });

  it("skips retention scheduling before eligibility and keeps the workspace active", async () => {
    const terminalAnchor = new Date(Date.now() - 2 * 86_400_000);
    const seeded = await seedTerminalWorkspace({
      cleanupPolicy: {
        enabled: true,
        retentionDays: 7,
        mode: "report_only",
      },
    });
    await db
      .update(issues)
      .set({ completedAt: terminalAnchor, updatedAt: terminalAnchor })
      .where(eq(issues.id, seeded.sourceIssueId));

    await svc.scheduleCleanupEligibility();
    const sweep = await svc.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({ archived: 0, retentionCandidates: 0, skippedRetentionPending: 1 });

    const [row] = await db
      .select({ status: executionWorkspaces.status, cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(row?.status).toBe("active");
    expect(row?.cleanupEligibleAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not schedule dirty undelivered workspaces under an enabled policy", async () => {
    const seeded = await seedTerminalWorkspace({
      dirty: true,
      cleanupPolicy: {
        enabled: true,
        retentionDays: 7,
        mode: "report_only",
      },
    });

    const schedule = await svc.scheduleCleanupEligibility();
    expect(schedule).toMatchObject({ skippedNotReady: 1, scheduled: 0 });

    const sweep = await svc.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });

    const [row] = await db
      .select({ cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt, status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(row?.status).toBe("active");
    expect(row?.cleanupEligibleAt).toBeNull();
  });

  it("treats malformed cleanupPolicy as absent and preserves today's archive behavior", async () => {
    const seeded = await seedTerminalWorkspace({
      cleanupPolicy: { enabled: true, retentionDays: "soon" },
    });

    const schedule = await svc.scheduleCleanupEligibility();
    expect(schedule.skippedNoPolicy).toBeGreaterThan(0);

    const sweep = await svc.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({ archived: 1, retentionCandidates: 0 });

    const [row] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(row?.status).toBe("archived");
  });

  it("clears and re-anchors cleanupEligibleAt after reopen then re-terminal", async () => {
    const firstTerminal = new Date(Date.now() - 10 * 86_400_000);
    const secondTerminal = new Date(Date.now() - 1 * 86_400_000);
    const seeded = await seedTerminalWorkspace({
      cleanupPolicy: {
        enabled: true,
        retentionDays: 7,
        mode: "report_only",
      },
    });
    await db
      .update(issues)
      .set({ completedAt: firstTerminal, updatedAt: firstTerminal })
      .where(eq(issues.id, seeded.sourceIssueId));

    await svc.scheduleCleanupEligibility();
    await db
      .update(issues)
      .set({ status: "in_progress", completedAt: null })
      .where(eq(issues.id, seeded.sourceIssueId));

    const clearedSchedule = await svc.scheduleCleanupEligibility();
    expect(clearedSchedule.clearedIneligible).toBe(1);

    const [clearedRow] = await db
      .select({ cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(clearedRow?.cleanupEligibleAt).toBeNull();

    await db
      .update(issues)
      .set({ status: "done", completedAt: secondTerminal, updatedAt: secondTerminal })
      .where(eq(issues.id, seeded.sourceIssueId));

    const reschedule = await svc.scheduleCleanupEligibility();
    expect(reschedule.scheduled).toBe(1);

    const [reanchoredRow] = await db
      .select({ cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(reanchoredRow?.cleanupEligibleAt?.getTime()).toBe(
      secondTerminal.getTime() + 7 * 86_400_000,
    );
  });
});
