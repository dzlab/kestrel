import { MessageSquarePlus } from "lucide-react";
import type { Conversation } from "../api/client";

type ConversationSidebarProps = {
  conversations: readonly Conversation[];
  selectedId: string | null;
  creating: boolean;
  onCreate(): void;
  onSelect(conversationId: string): void;
};

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

export function ConversationSidebar({
  conversations,
  selectedId,
  creating,
  onCreate,
  onSelect,
}: ConversationSidebarProps) {
  return (
    <div className="conversation-sidebar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">K</div>
        <div>
          <strong>Kestrel</strong>
          <span>Local agent</span>
        </div>
      </div>
      <button className="new-conversation" type="button" disabled={creating} onClick={onCreate}>
        <MessageSquarePlus size={17} aria-hidden="true" />
        {creating ? "Creating…" : "New conversation"}
      </button>
      <div className="sidebar-label">Recent</div>
      <nav className="conversation-list" aria-label="Conversations">
        {conversations.map((conversation) => (
          <button
            className="conversation-link"
            data-active={conversation.id === selectedId}
            key={conversation.id}
            type="button"
            onClick={() => onSelect(conversation.id)}
          >
            <span>{conversation.title}</span>
            <time dateTime={new Date(conversation.updatedAt).toISOString()}>{relativeTime(conversation.updatedAt)}</time>
          </button>
        ))}
      </nav>
      <div className="local-note">
        <span className="local-dot" aria-hidden="true" />
        Runs on this machine
      </div>
    </div>
  );
}
