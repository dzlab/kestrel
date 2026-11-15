import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Menu, PanelRight, X } from "lucide-react";
import { ConversationSidebar } from "./chat/ConversationSidebar";
import { ConversationThread } from "./chat/ConversationThread";
import { useKestrelRuntime } from "./chat/KestrelRuntime";
import { RunDetails } from "./chat/RunDetails";

export default function App() {
  const runtime = useKestrelRuntime();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const sidebar = (
    <ConversationSidebar
      conversations={runtime.conversations}
      selectedId={runtime.selectedConversationId}
      creating={runtime.actionPending}
      onCreate={() => { setSidebarOpen(false); void runtime.createConversation(); }}
      onSelect={(conversationId) => { setSidebarOpen(false); void runtime.selectConversation(conversationId); }}
    />
  );

  return (
    <div className="app-shell">
      <aside className="sidebar-pane">{sidebar}</aside>
      <main className="main-pane">
        <header className="mobile-header">
          <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <Dialog.Trigger asChild>
              <button className="sidebar-trigger" type="button" aria-label="Open conversations"><Menu size={20} /></button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="drawer-overlay" />
              <Dialog.Content className="drawer-content sidebar-drawer" aria-describedby={undefined}>
                <Dialog.Title className="sr-only">Conversations</Dialog.Title>
                <Dialog.Close asChild>
                  <button className="drawer-close" type="button" aria-label="Close conversations"><X size={18} /></button>
                </Dialog.Close>
                {sidebar}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <div><strong>Kestrel</strong><span className={`connection-dot ${runtime.connection}`} /></div>
          <Dialog.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
            <Dialog.Trigger asChild>
              <button className="details-trigger" type="button" aria-label="Open run details"><PanelRight size={20} /></button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="drawer-overlay" />
              <Dialog.Content className="drawer-content details-drawer" aria-describedby={undefined}>
                <Dialog.Title className="sr-only">Run details</Dialog.Title>
                <Dialog.Close asChild>
                  <button className="drawer-close" type="button" aria-label="Close details"><X size={18} /></button>
                </Dialog.Close>
                <RunDetails />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </header>
        <ConversationThread />
      </main>
      <aside className="details-pane"><RunDetails /></aside>
    </div>
  );
}
