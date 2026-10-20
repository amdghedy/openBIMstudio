/**
 * Generative Design — iterative optimisation engine for BIM models.
 *
 * BIM-equivalent of Revit's "Generative Design" tool. Defines a study with
 * design variables (parameters), objectives (fitness functions), and
 * constraints, then runs random sampling / genetic search to discover
 * optimal design configurations.
 *
 * Solver is a simple NSGA-II-style elitist genetic algorithm — fast enough
 * for early-stage parametric studies in the browser.
 */

export type VariableKind = "continuous" | "discrete" | "categorical";

export interface DesignVariable {
  name: string;
  kind: VariableKind;
  /** Continuous: min/max bounds. Discrete: list of values. Categorical: list. */
  min?: number;
  max?: number;
  step?: number;
  values?: Array<string | number>;
}

export type ObjectiveDirection = "minimize" | "maximize";

export interface Objective {
  name: string;
  direction: ObjectiveDirection;
  /** Fitness function — receives a sample {var: value} and returns a number. */
  evaluate: (sample: Record<string, number | string>) => number;
}

export interface Constraint {
  name: string;
  /** Returns true if constraint satisfied, false if violated. */
  check: (sample: Record<string, number | string>) => boolean;
}

export interface StudyConfig {
  name: string;
  variables: DesignVariable[];
  objectives: Objective[];
  constraints?: Constraint[];
  /** Population size (GA). */
  populationSize?: number;
  /** Number of generations. */
  generations?: number;
  /** Mutation probability (0-1). */
  mutationRate?: number;
  /** Number of parallel studies to retain on the Pareto front. */
  archiveSize?: number;
}

export interface StudyResult {
  /** Pareto front of non-dominated solutions. */
  paretoFront: Array<{
    sample: Record<string, number | string>;
    scores: Record<string, number>;
    feasible: boolean;
  }>;
  /** Best single-objective solution (if only 1 objective). */
  best?: {
    sample: Record<string, number | string>;
    score: number;
  };
  /** All evaluated samples count. */
  evaluated: number;
  /** Best scores by generation. */
  convergence: number[];
}

const DEFAULTS = {
  populationSize: 30,
  generations: 20,
  mutationRate: 0.1,
  archiveSize: 20,
};

function randomValue(v: DesignVariable): number | string {
  if (v.kind === "continuous") {
    const min = v.min ?? 0;
    const max = v.max ?? 1;
    return min + Math.random() * (max - min);
  }
  if (v.kind === "discrete") {
    const values = v.values as number[];
    return values[Math.floor(Math.random() * values.length)];
  }
  const values = v.values as string[];
  return values[Math.floor(Math.random() * values.length)];
}

function randomSample(variables: DesignVariable[]): Record<string, number | string> {
  const sample: Record<string, number | string> = {};
  for (const v of variables) sample[v.name] = randomValue(v);
  return sample;
}

function mutate(
  sample: Record<string, number | string>,
  variables: DesignVariable[],
  rate: number,
): Record<string, number | string> {
  const out = { ...sample };
  for (const v of variables) {
    if (Math.random() < rate) out[v.name] = randomValue(v);
  }
  return out;
}

function crossover(
  a: Record<string, number | string>,
  b: Record<string, number | string>,
  variables: DesignVariable[],
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const v of variables) {
    out[v.name] = Math.random() < 0.5 ? a[v.name] : b[v.name];
  }
  return out;
}

function dominates(
  a: Record<string, number>,
  b: Record<string, number>,
  objectives: Objective[],
): boolean {
  let better = false;
  for (const obj of objectives) {
    if (obj.direction === "minimize") {
      if (a[obj.name] > b[obj.name]) return false;
      if (a[obj.name] < b[obj.name]) better = true;
    } else {
      if (a[obj.name] < b[obj.name]) return false;
      if (a[obj.name] > b[obj.name]) better = true;
    }
  }
  return better;
}

/** Run a generative design study. */
export function runStudy(config: StudyConfig): StudyResult {
  const p: Required<StudyConfig> = { ...DEFAULTS, ...config, variables: config.variables, objectives: config.objectives, name: config.name, constraints: config.constraints ?? [] } as Required<StudyConfig>;
  if (p.variables.length === 0 || p.objectives.length === 0) {
    throw new Error("Generative study needs ≥1 variable and ≥1 objective");
  }

  let population: Array<{ sample: Record<string, number | string>; scores: Record<string, number>; feasible: boolean }> = [];
  // Initial population.
  for (let i = 0; i < p.populationSize; i++) {
    const sample = randomSample(p.variables);
    const scores: Record<string, number> = {};
    for (const obj of p.objectives) scores[obj.name] = obj.evaluate(sample);
    const feasible = (p.constraints ?? []).every((c) => c.check(sample));
    population.push({ sample, scores, feasible });
  }

  const convergence: number[] = [];

  for (let gen = 0; gen < p.generations; gen++) {
    // Tournament selection + crossover + mutation.
    const children: typeof population = [];
    while (children.length < p.populationSize) {
      const i = Math.floor(Math.random() * population.length);
      const j = Math.floor(Math.random() * population.length);
      const child = mutate(crossover(population[i].sample, population[j].sample, p.variables), p.variables, p.mutationRate);
      const scores: Record<string, number> = {};
      for (const obj of p.objectives) scores[obj.name] = obj.evaluate(child);
      const feasible = (p.constraints ?? []).every((c) => c.check(child));
      children.push({ sample: child, scores, feasible });
    }
    // Elitist merge — keep best N.
    const merged = [...population, ...children];
    // Non-dominated sort.
    const pareto: typeof population = [];
    for (let i = 0; i < merged.length; i++) {
      let dominated = false;
      for (let j = 0; j < merged.length; j++) {
        if (i === j) continue;
        if (dominates(merged[j].scores, merged[i].scores, p.objectives)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) pareto.push(merged[i]);
    }
    population = pareto.slice(0, p.populationSize);
    if (population.length < p.populationSize) {
      // Fill remaining with random samples to maintain diversity.
      while (population.length < p.populationSize) {
        const sample = randomSample(p.variables);
        const scores: Record<string, number> = {};
        for (const obj of p.objectives) scores[obj.name] = obj.evaluate(sample);
        const feasible = (p.constraints ?? []).every((c) => c.check(sample));
        population.push({ sample, scores, feasible });
      }
    }
    // Track best single-objective score.
    if (p.objectives.length === 1) {
      const obj = p.objectives[0];
      const best = population.reduce((best, ind) => {
        const score = ind.scores[obj.name];
        if (obj.direction === "minimize") return score < best ? score : best;
        return score > best ? score : best;
      }, obj.direction === "minimize" ? Infinity : -Infinity);
      convergence.push(best);
    } else {
      // Track average score of the first objective.
      const obj = p.objectives[0];
      const avg = population.reduce((s, ind) => s + ind.scores[obj.name], 0) / population.length;
      convergence.push(avg);
    }
  }

  // Final Pareto front.
  const finalPareto: typeof population = [];
  for (let i = 0; i < population.length; i++) {
    let dominated = false;
    for (let j = 0; j < population.length; j++) {
      if (i === j) continue;
      if (dominates(population[j].scores, population[i].scores, p.objectives)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) finalPareto.push(population[i]);
  }

  const evaluated = p.populationSize * (p.generations + 1);
  let best: StudyResult["best"] | undefined;
  if (p.objectives.length === 1) {
    const obj = p.objectives[0];
    const sorted = [...finalPareto].sort((a, b) => {
      return obj.direction === "minimize"
        ? a.scores[obj.name] - b.scores[obj.name]
        : b.scores[obj.name] - a.scores[obj.name];
    });
    if (sorted.length) {
      best = { sample: sorted[0].sample, score: sorted[0].scores[obj.name] };
    }
  }

  return {
    paretoFront: finalPareto.slice(0, p.archiveSize),
    best,
    evaluated,
    convergence,
  };
}
