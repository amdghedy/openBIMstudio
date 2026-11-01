/**
 * Hybrid retrieval helpers for BIM semantic search.
 * Semantic similarity finds conceptual matches; lexical overlap preserves
 * exact identifiers, classifications and property-value matches.
 */

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "is", "it", "of", "on", "or", "the", "to", "with",
]);

export function buildElementSearchText(
  name: string,
  category: string,
  fields: Record<string, string>,
  maxLength = 1400,
): string {
  const parts = [
    name ? `Name: ${name}` : "",
    category ? `IFC category: ${category.replace(/^IFC/i, "")}` : "",
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (!value || value === name || parts.length >= 52) continue;
    parts.push(`${key}: ${value}`);
  }
  return parts.filter(Boolean).join(" · ").slice(0, maxLength);
}

export function tokenizeBimQuery(value: string): string[] {
  const tokens = value.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
}

export interface HybridCandidate<T = unknown> {
  semanticScore: number;
  text: string;
  value: T;
}

export function rankHybridResults<T>(
  query: string,
  candidates: HybridCandidate<T>[],
): Array<{
  value: T;
  semanticScore: number;
  lexicalScore: number;
  score: number;
}> {
  const queryTokens = tokenizeBimQuery(query);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ranked = candidates.map((candidate) => {
    const docTokens = new Set(tokenizeBimQuery(candidate.text));
    const matched = queryTokens.reduce((count, token) => count + (docTokens.has(token) ? 1 : 0), 0);
    let lexicalScore = queryTokens.length ? matched / queryTokens.length : 0;
    if (normalizedQuery.length > 2 && candidate.text.toLocaleLowerCase().includes(normalizedQuery)) {
      lexicalScore = Math.min(1, lexicalScore + 0.15);
    }
    const semanticScore = Math.max(0, Math.min(1, (candidate.semanticScore + 1) / 2));
    return {
      value: candidate.value,
      semanticScore: candidate.semanticScore,
      lexicalScore,
      score: semanticScore * 0.78 + lexicalScore * 0.22,
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
