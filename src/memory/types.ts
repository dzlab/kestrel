export type MemoryScope = "user" | "task";

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  userId: string;
  taskId: string | null;
  content: string;
  tags: string[];
  source: string;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
};

export type MemorySaveInput = {
  id?: string;
  scope: MemoryScope;
  userId: string;
  taskId: string | null;
  content: string;
  tags: string[];
  source: string;
  runId: string | null;
  expiresAt?: number | null;
  now?: number;
};

export type MemorySearchInput = {
  query: string;
  userId: string;
  taskId: string | null;
  scope?: MemoryScope;
  maxResults?: number;
  maxBytes?: number;
  now?: number;
};
