import { Activity, Clock3, FileCheck2, ShieldAlert } from "lucide-react";
import { formatState, useKestrelRuntime } from "./KestrelRuntime";
import { collectObservedChangedFiles } from "./ToolActivityCard";

function eventLabel(type: string): string {
  return type.replaceAll(".", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function RunDetails() {
  const runtime = useKestrelRuntime();
  const activeRun = runtime.detail?.activeRun ?? runtime.detail?.runs.at(-1);
  const recentEvents = runtime.events.slice(-12).reverse();
  const changedFiles = collectObservedChangedFiles(runtime.events);

  return (
    <div className="details-panel">
      <div className="details-section status-section">
        <p className="eyebrow">Current state</p>
        <div className="status-card">
          <span className={`status-glyph ${runtime.state}`} aria-hidden="true"><Activity size={17} /></span>
          <div><strong>{formatState(runtime.state)}</strong><span>{runtime.connection === "connected" ? "Durable state connected" : "Connection interrupted"}</span></div>
        </div>
      </div>
      {activeRun !== undefined && (
        <div className="details-section">
          <div className="details-heading"><span>Run</span><code>{activeRun.id}</code></div>
          <dl className="run-facts">
            <div><dt>Status</dt><dd>{formatState(activeRun.status)}</dd></div>
            <div><dt>Started</dt><dd>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(activeRun.startedAt)}</dd></div>
            {activeRun.finishedAt !== null && <div><dt>Finished</dt><dd>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(activeRun.finishedAt)}</dd></div>}
          </dl>
        </div>
      )}
      {runtime.detail?.pendingApproval !== undefined && (
        <div className="details-section pending-summary">
          <ShieldAlert size={17} aria-hidden="true" />
          <div><strong>Approval pending</strong><span>{runtime.detail.pendingApproval.tool} · {runtime.detail.pendingApproval.risk} risk</span></div>
        </div>
      )}
      <div className="details-section changed-files-section">
        <div className="details-heading"><span>Observed file changes</span><small>{changedFiles.length}</small></div>
        {changedFiles.length === 0 ? (
          <p className="details-note">No successful workspace file writes have been observed in this event stream.</p>
        ) : (
          <>
            <ul className="changed-file-list">
              {changedFiles.map((path) => <li key={path}><FileCheck2 size={13} aria-hidden="true" /><code>{path}</code></li>)}
            </ul>
            <p className="details-note">Paths come only from successful <code>fs.write</code> and <code>fs.patch</code> results. A diff is not shown because the event contract does not safely capture one.</p>
          </>
        )}
      </div>
      <div className="details-section activity-section">
        <div className="details-heading"><span>Recent durable events</span><small>{runtime.events.length}</small></div>
        {recentEvents.length === 0 ? (
          <div className="quiet-activity"><Clock3 size={17} aria-hidden="true" /><span>Run activity will appear here.</span></div>
        ) : (
          <ol className="event-list">
            {recentEvents.map((event) => (
              <li key={event.id}>
                <span className={`event-dot ${event.type.split(".")[0]}`} aria-hidden="true" />
                <div><strong>{eventLabel(event.type)}</strong><time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(event.createdAt)}</time></div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="details-footer">Details are bounded to durable Kestrel events; arbitrary shell side effects are not implied to be captured.</div>
    </div>
  );
}
