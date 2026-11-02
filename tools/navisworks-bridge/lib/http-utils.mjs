/**
 * Pure HTTP helpers for the openBIM NWC bridge.
 *
 * Security model: the bridge binds to the loopback interface only and treats
 * every request as potentially hostile:
 *  - the Host header must resolve to a loopback address (DNS-rebinding guard),
 *  - cross-origin browser reads are gated by an explicit origin allow-list,
 *  - user-supplied file names are sanitized to a safe basename.
 * Everything here is pure so the unit tests can exercise it without sockets.
 */

/** Parse an HTTP Host header ("127.0.0.1:8424", "localhost:8424", "[::1]:8424"). */
export function hostWithoutPort(hostHeader) {
  const h = String(hostHeader || "").trim();
  if (!h) return "";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(1, end);
  }
  return h.split(":")[0];
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** True when the Host header points at the loopback interface. */
export function isLoopbackHost(hostHeader) {
  return LOOPBACK_NAMES.has(hostWithoutPort(hostHeader).toLowerCase());
}

/**
 * Origin allow-list matching. An entry is either an exact origin
 * ("http://localhost:5173") or ends with ":*" to allow any port
 * ("http://localhost:*"). Scheme and host are compared case-insensitively.
 */
export function originAllowed(origin, allowlist) {
  if (!origin) return false;
  const o = String(origin).toLowerCase();
  for (const entry of allowlist) {
    const e = String(entry).toLowerCase();
    if (!e) continue;
    if (e.endsWith(":*")) {
      const prefix = e.slice(0, -1); // keep the colon, drop the star
      if (o.startsWith(prefix)) return true;
    } else if (o === e) {
      return true;
    }
  }
  return false;
}

/** CORS headers for an allowed origin (empty object when not allowed). */
export function corsHeaders(origin, allowlist) {
  if (!originAllowed(origin, allowlist)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
  };
}

/**
 * CORS preflight headers. Private/Local Network Access preflights (public
 * HTTPS page -> 127.0.0.1) are answered affirmatively so the deployed site
 * can reach the bridge running on the user's own machine.
 */
export function preflightHeaders(origin, allowlist, requestedHeaders) {
  const base = corsHeaders(origin, allowlist);
  if (!base["Access-Control-Allow-Origin"]) return {};
  return {
    ...base,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": String(requestedHeaders || "*"),
    "Access-Control-Max-Age": "600",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Local-Network": "true",
  };
}

/**
 * Sanitize a client-supplied file name down to a safe basename and require a
 * Navisworks source extension. Returns {ok:true, name} or {ok:false, error}.
 */
export function sanitizeSourceFileName(name) {
  const raw = String(name || "");
  let base = raw.split(/[\\/]/).pop() || "";
  base = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base) return { ok: false, error: "empty file name" };
  if (base.length > 180) base = base.slice(-180);
  base = base.replace(/[^A-Za-z0-9._ ()\-\u00a0-\u024f\u4e00-\u9fff]+/g, "_");
  if (!/\.(nwc|nwd|nwf)$/i.test(base)) {
    return { ok: false, error: "only .nwc, .nwd and .nwf source files are accepted" };
  }
  return { ok: true, name: base };
}

/** Sanitize an IFC output file name for use in URLs and File objects. */
export function sanitizeIfcFileName(name) {
  let base = String(name || "").split(/[\\/]/).pop() || "";
  base = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base) return "model.ifc";
  if (base.length > 180) base = base.slice(-180);
  return base.replace(/[^A-Za-z0-9._ ()\-\u00a0-\u024f\u4e00-\u9fff]+/g, "_");
}

/** Canonical job states, shared by bridge, client and tests. */
export const JOB_STATES = ["converting", "waiting-for-export", "done", "error", "expired"];

export function describeJobState(state, message) {
  switch (state) {
    case "converting":
      return message || "Converting with Navisworks (headless)…";
    case "waiting-for-export":
      return message || "Waiting for the IFC export in Navisworks…";
    case "done":
      return message || "Conversion finished.";
    case "error":
      return message || "Conversion failed.";
    case "expired":
      return message || "Job expired before an IFC was produced.";
    default:
      return message || "Unknown state.";
  }
}

/** Write a JSON response. Returns false when the socket was already closed. */
export function sendJson(res, code, obj, extraHeaders) {
  if (res.writableEnded || res.destroyed) return false;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(body);
  return true;
}

/** Read a request body into a Buffer with a hard byte cap. */
export function readBodyWithCap(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (err, buf) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(buf);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        finish(Object.assign(new Error(`body exceeds ${maxBytes} bytes`), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", (err) => finish(err));
  });
}
