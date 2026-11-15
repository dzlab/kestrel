import {
  ThreadPrimitive,
} from "@assistant-ui/react";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { formatState, useKestrelRuntime } from "./KestrelRuntime";
import { MessageContent } from "./MessageContent";
import { RunActivityFeed } from "./ToolActivityCard";

function ThreadMessage({ role, content, truncated }: { role: "user" | "assistant"; content: string; truncated: boolean }) {
  return (
    <article className={`message-row ${role}`} data-role={role}>
      {role === "assistant" && <div className="assistant-avatar" aria-hidden="true">K</div>}
      <div className="message-bubble">
        <MessageContent content={content} />
        {truncated && <p className="message-truncated">Message truncated by the bounded conversation response.</p>}
      </div>
    </article>
  );
}

export function ConversationThread() {
  const runtime = useKestrelRuntime();
  const messages = runtime.detail?.messages ?? [];

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
          {messages.length === 0 && (
            <div className="empty-thread">
              <div className="empty-orbit" aria-hidden="true"><span>K</span></div>
              <p className="eyebrow">A quiet workspace</p>
              <h2>What should we make today?</h2>
              <p>Kestrel can reason through a task, work in your configured workspace, and pause before sensitive actions.</p>
            </div>
          )}
          {messages.map((message) => (
            <ThreadMessage
              key={`${message.conversationId}:${message.sequenceNumber}`}
              role={message.role}
              content={message.content}
              truncated={message.contentTruncated}
            />
          ))}

          <RunActivityFeed events={runtime.events} truncated={runtime.eventsTruncated} />

          {runtime.state === "running" && (
            <div className="run-notice running" role="status">
              <LoaderCircle size={17} className="spin" aria-hidden="true" />
              <div><strong>Kestrel is working</strong><span>Durable tool activity appears above as it arrives.</span></div>
            </div>
          )}

          <ApprovalCard idPrefix="thread-approval" />

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
