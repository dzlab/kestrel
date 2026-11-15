import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";

export const SESSION_COOKIE_NAME = "kestrel_session";

export type HttpAuth = {
  setSessionCookie(response: ServerResponse): void;
  validateHost(headers: IncomingHttpHeaders): boolean;
  validateSession(headers: IncomingHttpHeaders): boolean;
  validateStateChangingRequest(headers: IncomingHttpHeaders): boolean;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseHost(value: string | undefined): { hostname: string; origin: string } | null {
  if (value === undefined || value.length === 0 || /[\s\\/]/u.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== "/") return null;
    return { hostname: parsed.hostname.toLowerCase(), origin: parsed.origin };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function cookieValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const cookie = firstHeader(headers.cookie);
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function equalToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createHttpAuth(): HttpAuth {
  const token = randomBytes(32).toString("base64url");

  const validateHost = (headers: IncomingHttpHeaders): boolean => {
    const host = parseHost(firstHeader(headers.host));
    return host !== null && isLoopbackHostname(host.hostname);
  };

  return {
    setSessionCookie(response) {
      response.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      );
    },
    validateHost,
    validateSession(headers) {
      return validateHost(headers) && equalToken(cookieValue(headers, SESSION_COOKIE_NAME), token);
    },
    validateStateChangingRequest(headers) {
      if (!validateHost(headers)) return false;
      const host = parseHost(firstHeader(headers.host));
      const origin = firstHeader(headers.origin);
      if (host === null || origin === undefined) return false;
      try {
        return new URL(origin).origin === host.origin;
      } catch {
        return false;
      }
    },
  };
}
