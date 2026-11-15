import { afterEach, expect, test } from "bun:test";
import { KestrelApi } from "../ui/src/api/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("calls the browser fetch function with the global receiver", async () => {
  let receivedThis: unknown;
  globalThis.fetch = function (this: unknown): Promise<Response> {
    receivedThis = this;
    return Promise.resolve(new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  } as unknown as typeof fetch;

  const api = new KestrelApi();
  await api.bootstrapSession();

  expect(receivedThis).toBe(globalThis);
});
