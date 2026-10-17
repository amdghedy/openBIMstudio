/**
 * Shared HTTP helpers for CDE providers.
 * Handles JSON parsing, error normalisation, and AbortSignal plumbing.
 */
import { diagnostics } from "../../core/diagnostics";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** If true, body is sent as-is (Blob/FormData). */
  raw?: boolean;
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await requestRaw(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

export async function requestRaw(url: string, opts: RequestOptions = {}): Promise<Response> {
  const headers = { ...opts.headers };
  let body: BodyInit | undefined;

  if (opts.raw) {
    body = opts.body as BodyInit;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: opts.signal,
    });
  } catch (err) {
    diagnostics.warn("cde.http", `network error: ${url}`, err);
    throw new Error(`Network error reaching ${hostOf(url)} — check your connection.`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = classify(res.status, res.statusText, text);
    diagnostics.warn("cde.http", `${res.status} ${url}`, text.slice(0, 300));
    throw new Error(msg);
  }
  return res;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function classify(status: number, text: string, body: string): string {
  const snippet = body.length > 220 ? body.slice(0, 220) + "…" : body;
  switch (status) {
    case 401: return `401 Unauthorized … sign in again. ${snippet}`;
    case 403: return `403 Forbidden … your account lacks access. ${snippet}`;
    case 404: return `404 Not Found — check the URL. ${snippet}`;
    case 429: return `429 Rate limited … wait a moment. ${snippet}`;
    case 500: case 502: case 503: case 504:
      return `${status} … the provider is having issues. ${snippet}`;
    default:  return `${status} ${text} ${snippet}`;
  }
}