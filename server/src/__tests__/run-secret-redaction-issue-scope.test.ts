import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run secret redaction issue scope (heartbeat_runs hot path)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-run-secret-redaction-issue-scope-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("run-secret-redaction-issue-scope");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Run secret redaction issue scope",
      issuePrefix: `S${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Issue scope reader",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    contextSnapshot: Record<string, unknown>,
  ) {
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot,
    });
    return heartbeatRunId;
  }

  it("finds registered secrets under both the issueId and paperclipIssue.id snapshot shapes, and ignores runs without a registry entry or for a different issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const registry = createRunSecretRedactionRegistry(db);
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    const issueIdFormRun = await seedRun(companyId, agentId, { issueId });
    const paperclipIssueFormRun = await seedRun(companyId, agentId, { paperclipIssue: { id: issueId } });
    const unregisteredRun = await seedRun(companyId, agentId, { issueId });
    const otherIssueRun = await seedRun(companyId, agentId, { issueId: otherIssueId });

    await registry.register(companyId, issueIdFormRun, "secret-from-issueid-shape");
    await registry.register(companyId, paperclipIssueFormRun, "secret-from-paperclipissue-shape");
    await registry.register(companyId, otherIssueRun, "secret-from-other-issue");
    void unregisteredRun;

    const redacted = await registry.redactForIssue(companyId, issueId, {
      body: "contains secret-from-issueid-shape and secret-from-paperclipissue-shape but not secret-from-other-issue",
    });

    expect(redacted.body).not.toContain("secret-from-issueid-shape");
    expect(redacted.body).not.toContain("secret-from-paperclipissue-shape");
    expect(redacted.body).toContain("secret-from-other-issue");
  });
});
