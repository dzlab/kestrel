import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/database";
import { StoreRepository } from "../src/store/repository";
import type { Message, ToolCall } from "../src/protocol/types";

function withDatabase<T>(callback: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-store-"));
  const path = join(directory, "kestrel.sqlite");

  try {
    return callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createRun(repository: StoreRepository) {
  const task = repository.createTask({
    title: "Store test",
    prompt: "Persist this task",
    workspace: "/tmp/workspace",
    maxSteps: 5,
  });

  return repository.startRun(task.id, `run-${task.id}`);
}

test("createTask persists the task and its initial created event", () => {
  withDatabase((path) => {
    const database = openDatabase(path);
    const repository = new StoreRepository(database);

    const task = repository.createTask({
      title: "Write a report",
      prompt: "Create a report",
      workspace: "/tmp/workspace",
      maxSteps: 10,
    });

    expect(database.query("SELECT title, prompt, workspace, max_steps FROM tasks WHERE id = ?").get(task.id)).toEqual({
      title: "Write a report",
      prompt: "Create a report",
      workspace: "/tmp/workspace",
      max_steps: 10,
    });
    const createdEvent = database
      .query("SELECT type, payload FROM events WHERE run_id IS NULL AND task_id = ?")
      .get(task.id) as { type: string; payload: string };
    expect(createdEvent.type).toBe("created");
    expect(JSON.parse(createdEvent.payload)).toMatchObject({
      title: "Write a report",
      prompt: "Create a report",
      workspace: "/tmp/workspace",
      maxSteps: 10,
    });

    database.close();
  });
});

test("appendMessage preserves insertion order for a run", () => {
  withDatabase((path) => {
    const database = openDatabase(path);
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const messages: Message[] = [
      { role: "user", content: "First" },
      { role: "assistant", content: "Second" },
      { role: "tool", content: "Third", toolCallId: "call-1" },
    ];

    for (const message of messages) {
      repository.appendMessage(run.id, message);
    }

    const rows = database
      .query("SELECT payload FROM messages WHERE run_id = ? ORDER BY sequence_number")
      .all(run.id) as Array<{ payload: string }>;
    expect(rows.map((row) => JSON.parse(row.payload))).toEqual(messages);

    database.close();
  });
});

test("recordToolCall is idempotent by call ID", () => {
  withDatabase((path) => {
    const database = openDatabase(path);
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const call: ToolCall = { id: "call-1", name: "fs.read", arguments: { path: "README.md" } };

    expect(repository.recordToolCall(run.id, call, "pending")).toBe(true);
    expect(repository.recordToolCall(run.id, call, "running")).toBe(false);
    expect(database.query("SELECT COUNT(*) AS count FROM tool_calls WHERE call_id = ?").get("call-1")).toEqual({
      count: 1,
    });

    database.close();
  });
});

test("pending approvals survive reopening the database", () => {
  withDatabase((path) => {
    const firstDatabase = openDatabase(path);
    const firstRepository = new StoreRepository(firstDatabase);
    const run = createRun(firstRepository);
    const approval = {
      callId: "call-approval",
      argumentsHash: "hash-1",
      capability: "shell.exec",
      riskLevel: "high",
      taskId: run.taskId,
      runId: run.id,
      decision: "pending",
      requestedAt: 1_700_000_000_000,
    } as const;

    firstRepository.saveApproval(approval);
    firstDatabase.close();

    const secondDatabase = openDatabase(path);
    const secondRepository = new StoreRepository(secondDatabase);
    expect(secondRepository.getApproval("call-approval", "hash-1")).toMatchObject(approval);
    secondDatabase.close();
  });
});

test("claimDueSchedule returns a due job only once", () => {
  withDatabase((path) => {
    const database = openDatabase(path);
    const repository = new StoreRepository(database);
    repository.createSchedule({
      id: "schedule-1",
      taskId: null,
      prompt: "Run the scheduled task",
      cron: null,
      nextRunAt: 1_000,
      enabled: true,
    });

    expect(repository.claimDueSchedule(1_000, "worker-a")).toMatchObject({ id: "schedule-1" });
    expect(repository.claimDueSchedule(1_000, "worker-b")).toBeNull();

    database.close();
  });
});
