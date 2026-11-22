"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = escapeHtml;
/** Escape text for safe use inside HTML (element content and quoted attribute values). */
function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>"'`]/g, (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : c === "'" ? "&#39;" : "&#96;");
}
