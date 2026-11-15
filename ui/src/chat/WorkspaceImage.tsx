import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { useKestrelRuntime } from "./KestrelRuntime";

const PASSIVE_RASTER = /\.(?:png|jpe?g|gif|webp)$/iu;

function safeRelativeImagePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.startsWith("\\") || path.includes("\0")) return false;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(path)) return false;
  const withoutSuffix = path.split(/[?#]/u, 1)[0] ?? "";
  if (!PASSIVE_RASTER.test(withoutSuffix)) return false;
  return !withoutSuffix.split(/[\\/]/u).some((segment) => segment === "..");
}

export function WorkspaceImage({ path, alt, title }: Readonly<{ path: string; alt?: string; title?: string }>) {
  const runtime = useKestrelRuntime();
  const [failed, setFailed] = useState(false);
  const conversationId = runtime.selectedConversationId;
  const supported = safeRelativeImagePath(path);

  useEffect(() => setFailed(false), [conversationId, path]);

  if (!supported || conversationId === null || failed) {
    return (
      <span className="workspace-image-placeholder" role="img" aria-label={alt || "Workspace image unavailable"}>
        <ImageOff size={20} aria-hidden="true" />
        <span>{supported ? "Workspace preview unavailable" : "Unsupported workspace image"}</span>
        <code>{path || "No path provided"}</code>
      </span>
    );
  }

  return (
    <span className="workspace-image-frame">
      <img
        src={runtime.workspaceImageUrl(path) ?? undefined}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      <code>{path}</code>
    </span>
  );
}
