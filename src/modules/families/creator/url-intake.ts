/**
 * Client side of "fetch a cut sheet from a link". It only talks to this
 * site's own /api/fetch-sheet. That route is off unless the site's owner
 * switches it on, and it answers 404 until then.
 */

export interface UrlFetchOk { ok: true; file: File; host: string }
export interface UrlFetchFail { ok: false; key: string }

/** Server error text -> an i18n key under familyCreator.url.err. */
export function errorKey(status: number, serverError: string): string {
  const e = serverError.replace(/^redirect:\s*/, "");
  if (status === 404) return "notEnabled";
  if (status === 403 && e === "host_not_allowed") return "notAllowed";
  if (status === 401) return "signin";
  if (status === 429) return "limit";
  if (status === 413) return "big";
  if (status === 415) return "type";
  if (status === 504) return "timeout";
  if (status === 502) return "upstream";
  if (["bad_url", "not_https", "credentials_in_url", "bad_port", "bad_host", "ip_literal", "internal_host"].includes(e)) return "refused";
  return "generic";
}

function nameFromUrl(u: URL, type: string): string {
  const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const ext = type === "application/pdf" ? ".pdf" : type === "image/png" ? ".png" : type === "image/jpeg" ? ".jpg" : ".txt";
  return last && /\.[A-Za-z0-9]{2,4}$/.test(last) ? last : (last || "sheet") + ext;
}

/** `consent` must be the user's tick for THIS fetch; the caller clears it after. */
export async function fetchSheetFromUrl(raw: string, consent: boolean, doFetch: typeof fetch = fetch): Promise<UrlFetchOk | UrlFetchFail> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, key: "refused" }; }
  if (!consent) return { ok: false, key: "consent" };
  let res: Response;
  try {
    res = await doFetch("/api/fetch-sheet", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: u.toString(), consent: true }),
    });
  } catch { return { ok: false, key: "upstream" }; }
  if (!res.ok) {
    let msg = "";
    try { msg = String(((await res.json()) as { error?: string }).error || ""); } catch { /* */ }
    return { ok: false, key: errorKey(res.status, msg) };
  }
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  const blob = await res.blob();
  return { ok: true, file: new File([blob], nameFromUrl(u, type), { type }), host: res.headers.get("x-fetched-host") || u.hostname };
}
