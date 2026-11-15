import {
  AuiIf,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { AlertTriangle, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { Composer } from "./Composer";
import { approvalSummary, formatState, useKestrelRuntime } from "./KestrelRuntime";

function MessageText() {
  return <MessagePartPrimitive.Text />;
}

function ThreadMessage({ role }: { role: "user" | "assistant" }) {
  return (
    <MessagePrimitive.Root className={`message-row ${role}`} data-role={role}>
      {role === "assistant" && <div className="assistant-avatar" aria-hidden="true">K</div>}
      <div className="message-bubble">
        <MessagePrimitive.Parts components={{ Text: MessageText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

export function ConversationThread() {
  const runtime = useKestrelRuntime();
  const pending = runtime.detail?.pendingApproval;

  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <div className="thread-inner">
          {runtime.detail?.messagePage.hasMore && (
            <button
              className="load-earlier"
              type="button"
              disabled={runtime.actionPending}
              onClick={() => void runtime.loadEarlierMessages()}
            >
              Load earlier messages
            </button>
          )}
          <AuiIf condition={(value) => value.thread.isEmpty}>
            <div className="empty-thread">
              <div className="empty-orbit" aria-hidden="true"><span>K</span></div>
              <p className="eyebrow">A quiet workspace</p>
              <h2>What should we make today?</h2>
              <p>Kestrel can reason through a task, work in your configured workspace, and pause before sensitive actions.</p>
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages>
            {({ message }) => message.role === "user"
              ? <ThreadMessage role="user" />
              : <ThreadMessage role="assistant" />}
          </ThreadPrimitive.Messages>

          {runtime.state === "running" && (
            <div className="run-notice running" role="status">
              <LoaderCircle size={17} className="spin" aria-hidden="true" />
              <div><strong>Kestrel is working</strong><span>Tool and run activity will appear in details.</span></div>
            </div>
          )}

          {runtime.state === "blocked_on_approval" && pending !== undefined && (
            <section className="approval-notice" aria-labelledby="approval-title">
              <div className="approval-heading">
                <ShieldCheck size={20} aria-hidden="true" />
                <div>
                  <p className="eyebrow">Action required</p>
                  <h3 id="approval-title">Review {pending.tool}</h3>
                </div>
                <span className={`risk-pill ${pending.risk}`}>{pending.risk}</span>
              </div>
              <p>{pending.reason}</p>
              <div className="approval-meta">
                <span>Capability</span><strong>{pending.capability}</strong>
                <span>Request</span><strong>{approvalSummary(pending)}</strong>
              </div>
              <div className="arguments-block">
                <div><span>Exact stored arguments</span><span>{pending.argumentsBytes.toLocaleString()} bytes</span></div>
                {runtime.approvalArgumentsLoading ? (
                  <p className="arguments-loading"><LoaderCircle className="spin" size={15} /> Loading exact arguments…</p>
                ) : runtime.approvalArguments === null ? (
                  <p className="arguments-loading"><AlertTriangle size={15} /> Arguments unavailable; approval is disabled.</p>
                ) : (
                  <pre>{JSON.stringify(runtime.approvalArguments, null, 2)}</pre>
                )}
              </div>
              <div className="approval-actions">
                <button type="button" className="deny-action" disabled={runtime.actionPending} onClick={() => void runtime.resolveApproval("deny")}>Deny</button>
                <button
                  type="button"
                  className="approve-action"
                  disabled={runtime.actionPending || runtime.approvalArguments === null}
                  onClick={() => void runtime.resolveApproval("approve")}
                >
                  Approve exact action
                </button>
              </div>
            </section>
          )}

          {runtime.state !== "ready" && runtime.state !== "running" && runtime.state !== "blocked_on_approval" && runtime.state !== "connecting" && (
            <div className={`run-notice terminal ${runtime.state}`} role="status">
              <span className="state-dot" aria-hidden="true" />
              <div><strong>{formatState(runtime.state)}</strong><span>The durable conversation state is up to date.</span></div>
            </div>
          )}

          {runtime.error !== null && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={17} aria-hidden="true" />
              <div><strong>{runtime.error.code}</strong><span>{runtime.error.message}</span></div>
              <button type="button" onClick={runtime.clearError} aria-label="Dismiss error">×</button>
            </div>
          )}
        </div>
        <ThreadPrimitive.ViewportFooter className="thread-footer">
          <div className="thread-footer-inner">
            {runtime.state === "disconnected" && (
              <button className="reconnect-button" type="button" onClick={() => void runtime.refreshConversation()}>
                <RefreshCw size={15} aria-hidden="true" /> Reconnect
              </button>
            )}
            <Composer state={runtime.state} actionPending={runtime.actionPending} />
            <p className="composer-disclaimer">Kestrel can make mistakes. Review tool actions and workspace changes.</p>
          </div>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
