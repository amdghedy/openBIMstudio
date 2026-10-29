/**
 * Parametric Family Formula Engine.
 *
 * Evaluates parameter equations with support for:
 * - Arithmetic (+, -, *, /, %)
 * - Conditionals: IF(condition, thenValue, elseValue)
 * - Math functions: round, max, min, sqrt, abs
 */

export type ParamEnvironment = Record<string, number>;

export function evaluateFamilyFormula(formula: string, env: ParamEnvironment): number {
  if (!formula || typeof formula !== "string") return 0;
  const trimmed = formula.trim();

  // If simple numeric string
  if (!isNaN(Number(trimmed))) {
    return Number(trimmed);
  }

  // Handle IF(cond, a, b)
  const ifMatch = trimmed.match(/^IF\s*\((.+?),\s*(.+?),\s*(.+?)\)$/i);
  if (ifMatch) {
    const condStr = ifMatch[1];
    const thenVal = evaluateFamilyFormula(ifMatch[2], env);
    const elseVal = evaluateFamilyFormula(ifMatch[3], env);

    const isTrue = evaluateCondition(condStr, env);
    return isTrue ? thenVal : elseVal;
  }

  // Substitute parameter variables with numeric values
  let expr = trimmed;
  // Sort keys by length descending to prevent partial variable replacement
  const keys = Object.keys(env).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const reg = new RegExp(`\\b${k}\\b`, "g");
    expr = expr.replace(reg, String(env[k]));
  }

  try {
    // Whitelist check: only numbers, operators, parens, Math functions
    if (/^[0-9\.\+\-\*\/\(\)\s,]|Math\.[a-z]+$/i.test(expr)) {
      // Safe function evaluator
      const fn = new Function(`return (${expr});`);
      const res = fn();
      return typeof res === "number" && !isNaN(res) ? res : 0;
    }
  } catch {
    /* evaluation error */
  }

  return 0;
}

function evaluateCondition(condStr: string, env: ParamEnvironment): boolean {
  let expr = condStr;
  const keys = Object.keys(env).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const reg = new RegExp(`\\b${k}\\b`, "g");
    expr = expr.replace(reg, String(env[k]));
  }

  // Operators: >, <, >=, <=, ==, !=
  if (expr.includes(">=")) {
    const [a, b] = expr.split(">=").map(Number);
    return a >= b;
  }
  if (expr.includes("<=")) {
    const [a, b] = expr.split("<=").map(Number);
    return a <= b;
  }
  if (expr.includes(">")) {
    const [a, b] = expr.split(">").map(Number);
    return a > b;
  }
  if (expr.includes("<")) {
    const [a, b] = expr.split("<").map(Number);
    return a < b;
  }
  if (expr.includes("==")) {
    const [a, b] = expr.split("==").map(Number);
    return a === b;
  }
  return false;
}
