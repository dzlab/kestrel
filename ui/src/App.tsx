import { useState } from "react";
import { Activity, Clock3, Menu, PanelRight, ShieldAlert, X } from "lucide-react";
import { ConversationSidebar } from "./chat/ConversationSidebar";
import { ConversationThread } from "./chat/ConversationThread";
import { formatState, useKestrelRuntime } from "./chat/KestrelRuntime";

function eventLabel(type: string): string {
  return type.replaceAll(".", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function DetailsPanel() {
  const runtime = useKestrelRuntime();
  const activeRun = runtime.detail?.activeRun ?? runtime.detail?.runs.at(-1);
  const recentEvents = runtime.events.slice(-12).reverse();

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
          <div className="details-heading"><span>Run</span><code>{activeRun.id.slice(0, 8)}</code></div>
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
          <div><strong>Approval pending</strong><span>{runtime.detail.pendingApproval.tool}</span></div>
        </div>
      )}
      <div className="details-section activity-section">
        <div className="details-heading"><span>Activity</span><small>{runtime.events.length}</small></div>
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
      <div className="details-footer">Run details are bounded to durable Kestrel events.</div>
    </div>
  );
}

export default function App() {
  const runtime = useKestrelRuntime();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const closeDrawers = (): void => {
    setSidebarOpen(false);
    setDetailsOpen(false);
  };

  return (
    <div className="app-shell">
      {(sidebarOpen || detailsOpen) && <button className="drawer-backdrop" aria-label="Close panel" type="button" onClick={closeDrawers} />}
      <aside className="sidebar-pane" data-open={sidebarOpen}>
        <button className="drawer-close" type="button" aria-label="Close conversations" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        <ConversationSidebar
          conversations={runtime.conversations}
          selectedId={runtime.selectedConversationId}
          creating={runtime.actionPending}
          onCreate={() => { setSidebarOpen(false); void runtime.createConversation(); }}
          onSelect={(conversationId) => { setSidebarOpen(false); void runtime.selectConversation(conversationId); }}
        />
      </aside>
      <main className="main-pane">
        <header className="mobile-header">
          <button type="button" aria-label="Open conversations" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <div><strong>Kestrel</strong><span className={`connection-dot ${runtime.connection}`} /></div>
          <button type="button" aria-label="Open run details" onClick={() => setDetailsOpen(true)}><PanelRight size={20} /></button>
        </header>
        <ConversationThread />
      </main>
      <aside className="details-pane" data-open={detailsOpen}>
        <button className="drawer-close" type="button" aria-label="Close details" onClick={() => setDetailsOpen(false)}><X size={18} /></button>
        <DetailsPanel />
      </aside>
    </div>
  );
}
