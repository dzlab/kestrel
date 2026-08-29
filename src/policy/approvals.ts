import { ValidationError } from "../errors";
import { hashToolCall } from "./rules";
import type {
  ApprovalLookup,
  ApprovalManagerOptions,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalStatus,
  ApprovalStore,
  Risk,
} from "./types";

const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;
const risks: readonly Risk[] = ["low", "standard", "high"];

function isRisk(value: string): value is Risk {
  return risks.includes(value as Risk);
}

function isApprovalStatus(value: string): value is Exclude<ApprovalStatus, "expired" | "consumed"> {
  return value === "pending" || value === "approved" || value === "denied";
}

function sameHash(request: ApprovalRequest, lookup: ApprovalLookup): boolean {
  try {
    return request.tool === lookup.tool && request.argumentsHash === hashToolCall(lookup.tool, lookup.arguments);
  } catch {
    return false;
  }
}

export class ApprovalManager {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly consumed = new Set<string>();
  private readonly defaultExpiryMs: number;
  private readonly now: () => number;

  constructor(private readonly store?: ApprovalStore, options: ApprovalManagerOptions = {}) {
    this.defaultExpiryMs = options.defaultExpiryMs ?? DEFAULT_EXPIRY_MS;
    this.now = options.now ?? (() => Date.now());
    if (!Number.isInteger(this.defaultExpiryMs) || this.defaultExpiryMs <= 0) {
      throw new ValidationError("approval expiry must be a positive integer");
    }
  }

  request(input: ApprovalRequestInput): ApprovalRequest {
    const id = input.id ?? input.callId;
    if (typeof id !== "string" || id.length === 0) throw new ValidationError("approval ID must be non-empty");
    if (typeof input.runId !== "string" || input.runId.length === 0) throw new ValidationError("approval run ID must be non-empty");
    if (typeof input.tool !== "string" || input.tool.length === 0) throw new ValidationError("approval tool must be non-empty");
    if (typeof input.summary !== "string" || input.summary.length === 0) throw new ValidationError("approval summary must be non-empty");
    if (!isRisk(input.risk)) throw new ValidationError("approval risk is invalid");

    const createdAt = input.createdAt ?? this.now();
    const expiresAt = input.expiresAt ?? createdAt + this.defaultExpiryMs;
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
      throw new ValidationError("approval expiry must be after creation");
    }
    const argumentsHash = hashToolCall(input.tool, input.arguments);
    const existing = this.requests.get(id);
    if (existing !== undefined) {
      if (existing.argumentsHash !== argumentsHash || existing.tool !== input.tool) {
        throw new ValidationError(`approval ID ${id} cannot be reused for changed arguments`);
      }
      return this.current(existing);
    }

    const durable = this.store?.getApproval(id, argumentsHash);
    if (durable !== null && durable !== undefined) {
      const durableRisk = isRisk(durable.riskLevel) ? durable.riskLevel : input.risk;
      const restored: ApprovalRequest = {
        id,
        runId: durable.runId ?? input.runId,
        taskId: durable.taskId ?? input.taskId ?? null,
        tool: input.tool,
        capability: input.capability ?? durable.capability,
        risk: durableRisk,
        summary: input.summary,
        argumentsHash,
        createdAt: durable.requestedAt,
        expiresAt: durable.requestedAt + this.defaultExpiryMs,
        status: isApprovalStatus(durable.decision) ? durable.decision : "pending",
      };
      this.requests.set(id, restored);
      return this.current(restored);
    }

    const created: ApprovalRequest = {
      id,
      runId: input.runId,
      taskId: input.taskId ?? null,
      tool: input.tool,
      capability: input.capability ?? input.tool,
      risk: input.risk,
      summary: input.summary,
      argumentsHash,
      createdAt,
      expiresAt,
      status: "pending",
    };
    this.requests.set(id, created);
    this.persist(created);
    return { ...created };
  }

  approve(id: string | ApprovalRequest, now = this.now()): ApprovalRequest {
    const request = this.resolve(id);
    this.expireIfNeeded(request, now);
    if (request.status !== "pending") throw new ValidationError(`approval ${request.id} is not pending`);
    request.status = "approved";
    this.persist(request, now);
    return { ...request };
  }

  deny(id: string | ApprovalRequest, now = this.now()): ApprovalRequest {
    const request = this.resolve(id);
    this.expireIfNeeded(request, now);
    if (request.status !== "pending") throw new ValidationError(`approval ${request.id} is not pending`);
    request.status = "denied";
    this.persist(request, now);
    return { ...request };
  }

  isApproved(input: ApprovalLookup | string, argumentsHash?: string, now = this.now()): boolean {
    const request = this.lookup(input, argumentsHash);
    if (request === null) return false;
    if (request.status === "consumed" || this.consumed.has(request.id)) return false;
    if (this.expireIfNeeded(request, now)) return false;
    return request.status === "approved";
  }

  consume(input: ApprovalLookup | string, args?: Record<string, unknown>, now = this.now()): boolean {
    const lookup = typeof input === "string" && args !== undefined ? { id: input, tool: this.resolve(input).tool, arguments: args } : input;
    if (typeof lookup === "string") return false;
    const request = this.lookup(lookup);
    if (request === null || !this.isApproved(lookup, undefined, now)) return false;
    this.consumed.add(request.id);
    request.status = "consumed";
    return true;
  }

  get(id: string): ApprovalRequest | null {
    const request = this.requests.get(id);
    if (request === undefined) return null;
    this.expireIfNeeded(request, this.now());
    return { ...request };
  }

  private resolve(value: string | ApprovalRequest): ApprovalRequest {
    const id = typeof value === "string" ? value : value.id;
    const request = this.requests.get(id);
    if (request === undefined) throw new ValidationError(`unknown approval: ${id}`);
    if (typeof value !== "string" && value.argumentsHash !== request.argumentsHash) {
      throw new ValidationError(`approval ${id} does not match its original arguments`);
    }
    return request;
  }

  private lookup(input: ApprovalLookup | string, argumentsHash?: string): ApprovalRequest | null {
    if (typeof input === "string") {
      const request = this.requests.get(input);
      if (request === undefined || argumentsHash === undefined) return null;
      return request.argumentsHash === argumentsHash ? request : null;
    }
    const existing = this.requests.get(input.id);
    if (existing !== undefined) return sameHash(existing, input) ? existing : null;
    let computed: string;
    try {
      computed = hashToolCall(input.tool, input.arguments);
    } catch {
      return null;
    }
    const durable = this.store?.getApproval(input.id, computed);
    if (durable === null || durable === undefined) return null;
    const risk = isRisk(durable.riskLevel) ? durable.riskLevel : "high";
    const restored: ApprovalRequest = {
      id: input.id,
      runId: durable.runId ?? "unknown",
      taskId: durable.taskId ?? null,
      tool: input.tool,
      capability: durable.capability,
      risk,
      summary: `${input.tool} requires explicit approval`,
      argumentsHash: computed,
      createdAt: durable.requestedAt,
      expiresAt: durable.requestedAt + this.defaultExpiryMs,
      status: isApprovalStatus(durable.decision) ? durable.decision : "pending",
    };
    this.requests.set(input.id, restored);
    return restored;
  }

  private expireIfNeeded(request: ApprovalRequest, now: number): boolean {
    if ((request.status === "pending" || request.status === "approved") && now >= request.expiresAt) {
      request.status = "expired";
      return true;
    }
    return request.status === "expired";
  }

  private current(request: ApprovalRequest): ApprovalRequest {
    this.expireIfNeeded(request, this.now());
    return { ...request };
  }

  private persist(request: ApprovalRequest, resolvedAt = request.status === "pending" ? null : this.now()): void {
    if (this.store === undefined) return;
    const decision = request.status === "approved" || request.status === "denied" ? request.status : "pending";
    this.store.saveApproval({
      callId: request.id,
      argumentsHash: request.argumentsHash,
      taskId: request.taskId,
      runId: request.runId,
      capability: request.capability,
      riskLevel: request.risk,
      decision,
      requestedAt: request.createdAt,
      resolvedAt,
    });
  }
}

export { ApprovalManager as Approvals };
