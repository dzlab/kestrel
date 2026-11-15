import { ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUp, Square } from "lucide-react";
import type { KestrelUiState } from "./KestrelRuntime";

type ComposerProps = {
  state: KestrelUiState;
  actionPending: boolean;
};

export function Composer({ state, actionPending }: ComposerProps) {
  const blocked = state === "blocked_on_approval";
  const running = state === "running";
  const placeholder = blocked
    ? "Resolve the pending approval to continue"
    : state === "disconnected"
      ? "Reconnect to Kestrel to send a message"
      : "Ask Kestrel anything…";

  return (
    <ComposerPrimitive.Root className="composer-shell">
      <ComposerPrimitive.Input
        className="composer-input"
        aria-label="Message Kestrel"
        placeholder={placeholder}
        rows={1}
        submitMode="enter"
      />
      <div className="composer-footer">
        <span>Enter to send · Shift + Enter for a new line</span>
        {running ? (
          <ComposerPrimitive.Cancel className="composer-button stop-button" disabled={actionPending} aria-label="Stop run">
            <Square size={14} fill="currentColor" aria-hidden="true" />
            Stop
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="composer-button send-button" aria-label="Send message">
            <ArrowUp size={18} strokeWidth={2.4} aria-hidden="true" />
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}
