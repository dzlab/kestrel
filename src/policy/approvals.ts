import { ValidationError } from "../errors";
import { hashToolCall } from "./rules";
import type {
  ApprovalLookup,
  ApprovalManagerOptions,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalStatus,
  ApprovalStore,
  ApprovalStoreRecord,
  Risk,
} from "./types";

const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;
const risks: readonly Risk[] = ["low", "standard", "high"];

function isRisk(value: string): value is Risk {
  return risks.includes(value as Risk);
}

function statusOf(record: ApprovalStoreRecord): ApprovalStatus {
  if (record.consumedAt !== null && record.consumedAt !== undefined) return "consumed";
  if (record.expiredAt !== null && record.expiredAt !== undefined) return "expired";
  return record.decision;
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
  private readonly defaultExpiryMs: number;
  private readonly now: () => number;
  private readonly store?: ApprovalStore;

  constructor(storeOrOptions?: ApprovalStore | ApprovalManagerOptions, options: ApprovalManagerOptions = {}) {
    const looksLikeStore = storeOrOptions !== undefined && typeof (storeOrOptions as ApprovalStore).getApproval === "function";
    this.store = looksLikeStore ? storeOrOptions as ApprovalStore : undefined;
    if (!looksLikeStore && storeOrOptions !== undefined) options = storeOrOptions as ApprovalManagerOptions;
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

    const durableById = this.store?.getApprovalByCallId(id);
    if (durableById !== null && durableById !== undefined && durableById.argumentsHash !== argumentsHash) {
      throw new ValidationError(`approval ID ${id} cannot be reused for changed arguments`);
    }

    const durable = this.store?.getApproval(id, argumentsHash);
    if (durable !== null && durable !== undefined) {
      const restored = this.restore(durable, input);
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
    if (this.expireIfNeeded(request, now)) return false;
    return request.status === "approved";
  }

  consume(input: ApprovalLookup | string, args?: Record<string, unknown>, now = this.now()): boolean {
    const lookup: ApprovalLookup | null = typeof input === "string"
      ? args === undefined
        ? null
        : (() => {
            const request = this.resolve(input);
            return { id: input, tool: request.tool, arguments: args };
          })()
      : input;
    if (lookup === null) return false;
    const request = this.lookup(lookup);
    if (request === null || this.expireIfNeeded(request, now) || request.status !== "approved") return false;

    if (this.store !== undefined) {
      const consumed = this.store.consumeApproval(request.id, request.argumentsHash, now);
      if (consumed === null) {
        const current = this.store.getApproval(request.id, request.argumentsHash);
        if (current !== null) {
          request.status = statusOf(current);
          request.expiresAt = current.expiresAt ?? request.expiresAt;
          request.consumedAt = current.consumedAt;
          request.expiredAt = current.expiredAt;
        }
        return false;
      }
      request.status = "consumed";
      request.consumedAt = consumed.consumedAt;
      return true;
    }

    request.status = "consumed";
    return true;
  }

  get(id: string): ApprovalRequest | null {
    let request = this.requests.get(id);
    if (request === undefined) {
      const durable = this.store?.getApprovalByCallId(id);
      if (durable === null || durable === undefined) return null;
      request = this.restore(durable);
      this.requests.set(id, request);
    }
    this.expireIfNeeded(request, this.now());
    return { ...request };
  }

  private restore(record: ApprovalStoreRecord, input?: ApprovalRequestInput): ApprovalRequest {
    const tool = record.tool || input?.tool;
    if (tool === undefined || tool.length === 0) {
      throw new ValidationError(`persisted approval ${record.callId} has no tool`);
    }
    return {
      id: record.callId,
      runId: record.runId ?? input?.runId ?? "unknown",
      taskId: record.taskId ?? input?.taskId ?? null,
      tool,
      capability: input?.capability ?? record.capability,
      risk: isRisk(record.riskLevel) ? record.riskLevel : input?.risk ?? "high",
      summary: input?.summary ?? `${tool} requires explicit approval`,
      argumentsHash: record.argumentsHash,
      createdAt: record.requestedAt,
      expiresAt: record.expiresAt ?? record.requestedAt + this.defaultExpiryMs,
      status: statusOf(record),
      ...(record.consumedAt === null || record.consumedAt === undefined ? {} : { consumedAt: record.consumedAt }),
      ...(record.expiredAt === null || record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt }),
    };
  }

  private resolve(value: string | ApprovalRequest): ApprovalRequest {
    const id = typeof value === "string" ? value : value.id;
    if (!this.requests.has(id) && this.get(id) === null) throw new ValidationError(`unknown approval: ${id}`);
    const request = this.requests.get(id);
    if (request === undefined) throw new ValidationError(`unknown approval: ${id}`);
    this.expireIfNeeded(request, this.now());
    if (typeof value !== "string" && value.argumentsHash !== request.argumentsHash) {
      throw new ValidationError(`approval ${id} does not match its original arguments`);
    }
    return request;
  }

  private lookup(input: ApprovalLookup | string, argumentsHash?: string): ApprovalRequest | null {
    if (typeof input === "string") {
      if (!this.requests.has(input)) this.get(input);
      const request = this.requests.get(input);
      if (request === undefined || argumentsHash === undefined || request.argumentsHash !== argumentsHash) return null;
      return request;
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
    const restored = this.restore(durable, {
      id: input.id,
      runId: durable.runId ?? "unknown",
      taskId: durable.taskId,
      tool: input.tool,
      capability: durable.capability,
      risk: isRisk(durable.riskLevel) ? durable.riskLevel : "high",
      summary: `${input.tool} requires explicit approval`,
      arguments: input.arguments,
    });
    this.requests.set(input.id, restored);
    return restored;
  }

  private expireIfNeeded(request: ApprovalRequest, now: number): boolean {
    if (request.status === "consumed" || request.status === "expired") return true;
    if (now < request.expiresAt) return false;
    if (this.store !== undefined) {
      const expired = this.store.expireApproval(request.id, request.argumentsHash, now);
      if (expired !== null) {
        request.status = statusOf(expired);
        request.expiresAt = expired.expiresAt ?? request.expiresAt;
        request.consumedAt = expired.consumedAt;
        request.expiredAt = expired.expiredAt;
      } else {
        request.status = "expired";
      }
    } else {
      request.status = "expired";
    }
    return true;
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
      tool: request.tool,
      taskId: request.taskId,
      runId: request.runId,
      capability: request.capability,
      riskLevel: request.risk,
      decision,
      requestedAt: request.createdAt,
      expiresAt: request.expiresAt,
      resolvedAt,
      consumedAt: request.consumedAt,
      expiredAt: request.status === "expired" ? request.expiredAt : null,
    });
  }
}

export { ApprovalManager as Approvals };
