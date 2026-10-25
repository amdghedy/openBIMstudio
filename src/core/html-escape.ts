/** Escape text for safe use inside HTML (element content and quoted attribute values). */
export function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"'`]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : c === "'" ? "&#39;" : "&#96;");
}
