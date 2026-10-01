import { invoke } from "@tauri-apps/api/core";
import { logInternalDebug, logInternalError, logInternalInfo } from "../../internal/logging";

type ProxyHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body_base64: string;
};

type TauriFetchInit = RequestInit & {
  timeoutMs?: number;
};

// A fixed, nonsecret marker keeps YouTube.js in its signed-in request mode.
// Rust replaces the marker with the real credential only for approved hosts.
export const BACKEND_AUTH_MARKER = "SAPISID=backend-managed";
let backendSessionActive = false;

export function getBackendSessionActive(): boolean {
  return backendSessionActive;
}

export function setBackendSessionActive(active: boolean): void {
  backendSessionActive = active;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function safeLogUrl(value: string): string {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}`;
}

function getSafeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey === "authorization"
        || normalizedKey === "cookie"
        || normalizedKey === "set-cookie"
        || normalizedKey === "location"
        || normalizedKey === "referer"
        || /token|visitor|identity|session|secret|api-key/.test(normalizedKey)
      ) {
        return [key, "[redacted]"];
      }
      return [key, value];
    }),
  );
}

function summarizeRequestBody(bodyBase64: string | undefined): Record<string, unknown> | null {
  if (!bodyBase64) return null;
  try {
    const text = new TextDecoder().decode(fromBase64(bodyBase64));
    const json = JSON.parse(text) as Record<string, unknown>;
    const context = json.context as {
      client?: { clientName?: string; clientVersion?: string };
    } | undefined;
    return {
      byteLength: text.length,
      topLevelKeys: Object.keys(json),
      browseId: json.browseId,
      hasContinuation: typeof json.continuation === "string",
      clientName: context?.client?.clientName,
      clientVersion: context?.client?.clientVersion,
    };
  } catch {
    return {
      byteLength: fromBase64(bodyBase64).byteLength,
      format: "non-json",
    };
  }
}

function getRequestUrl(inputUrl: string, headers: Record<string, string>): string {
  const url = new URL(inputUrl);
  const clientName = headers["x-youtube-client-name"];

  if (
    clientName === "67"
    && url.hostname === "www.youtube.com"
    && url.pathname.startsWith("/youtubei/")
  ) {
    url.hostname = "music.youtube.com";
  }

  return url.toString();
}

async function buildBodyBase64(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  const body = init?.body;
  if (!body) return undefined;

  if (typeof body === "string") {
    return toBase64(new TextEncoder().encode(body));
  }

  if (body instanceof URLSearchParams) {
    return toBase64(new TextEncoder().encode(body.toString()));
  }

  if (body instanceof Uint8Array) {
    return toBase64(body);
  }

  if (body instanceof ArrayBuffer) {
    return toBase64(new Uint8Array(body));
  }

  if (body instanceof Blob) {
    return toBase64(new Uint8Array(await body.arrayBuffer()));
  }

  if (typeof input !== "string" && !(input instanceof URL) && input.body) {
    const fallbackBuffer = await input.clone().arrayBuffer();
    return toBase64(new Uint8Array(fallbackBuffer));
  }

  return undefined;
}

export async function tauriFetch(input: RequestInfo | URL, init?: TauriFetchInit): Promise<Response> {
  const startedAt = performance.now();
  let sourceHeaders: HeadersInit | undefined;
  
  if (init?.headers) {
    sourceHeaders = init.headers;
  } else if (typeof input !== "string" && !(input instanceof URL) && input.headers) {
    sourceHeaders = input.headers;
  }
  
  const requestHeaders = new Headers(sourceHeaders);

  const headers: Record<string, string> = {};
  requestHeaders.forEach((value, key) => {
    headers[key] = value;
  });
  // Frontend code is never permitted to hand the proxy a credential value.
  // Only an active, marker-bearing request asks Rust to add account auth.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization" || key.toLowerCase() === "proxy-authorization") {
      delete headers[key];
    } else if (key.toLowerCase() === "cookie") {
      if (backendSessionActive && headers[key] === BACKEND_AUTH_MARKER) {
        headers[key] = BACKEND_AUTH_MARKER;
      } else {
        delete headers[key];
      }
    }
  }
  const method =
    init?.method ??
    (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");
  const body_base64 = await buildBodyBase64(input, init);
  const url = getRequestUrl(normalizeUrl(input), headers);
  const logUrl = safeLogUrl(url);

  logInternalInfo("tauriFetch.request", {
    method,
    url: logUrl,
    headerCount: Object.keys(headers).length,
    hasBody: Boolean(body_base64),
    headers: getSafeHeaders(headers),
    bodySummary: summarizeRequestBody(body_base64),
    urlDomain: new URL(url).hostname,
    urlPath: new URL(url).pathname,
  });

  try {
    const proxyResponse = await invoke<ProxyHttpResponse>("proxy_http_request", {
      input: {
        url,
        method,
        headers,
        body_base64,
        timeout_ms: init?.timeoutMs,
      },
    });

    if (!proxyResponse) {
      throw new Error("Tauri proxy_http_request returned undefined response");
    }

    const bodyBytes = fromBase64(proxyResponse.body_base64);
    if (proxyResponse.status >= 400) {
      logInternalError("tauriFetch.http error", new Error(`HTTP ${proxyResponse.status}`), {
        method,
        url: logUrl,
        responseBytes: bodyBytes.byteLength,
      });
    }
    logInternalDebug("tauriFetch.response", {
      method,
      url: logUrl,
      status: proxyResponse.status,
      responseHeaderCount: Object.keys(proxyResponse.headers).length,
      responseHeaders: getSafeHeaders(proxyResponse.headers),
      responseBytes: bodyBytes.byteLength,
      durationMs: Math.round(performance.now() - startedAt),
      success: proxyResponse.status >= 200 && proxyResponse.status < 300,
    });
    const responseBody = proxyResponse.status === 204
      || proxyResponse.status === 205
      || proxyResponse.status === 304
      ? null
      : bodyBytes;
    return new Response(responseBody, {
      status: proxyResponse.status,
      headers: proxyResponse.headers,
    });
  } catch (error) {
    logInternalError("tauriFetch.invoke failed", error, {
      method,
      url: logUrl,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}
