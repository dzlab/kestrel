import { useId } from "react";
import { AlertTriangle, LoaderCircle, ShieldCheck } from "lucide-react";
import { useKestrelRuntime } from "./KestrelRuntime";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function ApprovalCard({ idPrefix = "approval", compact = false }: Readonly<{ idPrefix?: string; compact?: boolean }>) {
  const runtime = useKestrelRuntime();
  const pending = runtime.detail?.pendingApproval;
  const instanceId = useId().replaceAll(":", "");
  const headingId = `${idPrefix}-${instanceId}-title`;
  if (pending === undefined) return null;
  const exactArguments = runtime.approvalArguments?.approvalHandle === pending.approvalHandle &&
    runtime.approvalArguments.argumentsHash === pending.argumentsHash
    ? runtime.approvalArguments.value
    : null;
  const expired = pending.status === "expired";

  const workdir = typeof exactArguments?.cwd === "string"
    ? exactArguments.cwd
    : pending.tool === "shell.exec" || pending.tool === "bun.run"
      ? ". (workspace root default)"
      : "Not applicable";

  return (
    <section className={`approval-notice${compact ? " compact" : ""}`} aria-labelledby={headingId}>
      <div className="approval-heading">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <p className="eyebrow">Action required</p>
          <h3 id={headingId}>Review {pending.tool}</h3>
        </div>
        <span className={`risk-pill ${pending.risk}`}>{pending.risk} risk</span>
      </div>
      <p>{pending.reason}</p>
      <dl className="approval-meta">
        <dt>Tool</dt><dd>{pending.tool}</dd>
        <dt>Capability</dt><dd>{pending.capability}</dd>
        <dt>Working directory</dt><dd>{workdir}</dd>
        <dt>Run ID</dt><dd><code>{pending.runId}</code></dd>
        <dt>Approval handle</dt><dd><code>{pending.approvalHandle}</code></dd>
        <dt>Argument hash</dt><dd><code>{pending.argumentsHash}</code></dd>
      </dl>
      <div className="arguments-block">
        <div className="arguments-heading"><span>Exact canonical stored arguments</span><span>{pending.argumentsBytes.toLocaleString()} bytes</span></div>
        {runtime.approvalArgumentsLoading ? (
          <p className="arguments-loading"><LoaderCircle className="spin" size={15} /> Loading exact arguments…</p>
        ) : exactArguments === null ? (
          <div className="arguments-retry">
            <p className="arguments-loading"><AlertTriangle size={15} /> Arguments unavailable; approval is disabled.</p>
            <button type="button" disabled={runtime.actionPending} onClick={runtime.retryApprovalArguments}>
              Retry loading arguments
            </button>
          </div>
        ) : (
          <pre>{canonicalJson(exactArguments)}</pre>
        )}
      </div>
      <div className="approval-actions">
        <button type="button" className="deny-action" disabled={runtime.actionPending} onClick={() => void runtime.resolveApproval("deny")}>
          {runtime.actionPending ? "Resolving…" : expired ? "Finalize expired action" : "Deny"}
        </button>
        <button
          type="button"
          className="approve-action"
          disabled={runtime.actionPending || exactArguments === null || expired}
          onClick={() => void runtime.resolveApproval("approve")}
        >
          {runtime.actionPending ? "Resolving…" : "Approve exact action"}
        </button>
      </div>
    </section>
  );
}
