/**
 * Electrical protection coordination — breaker selectivity and breaking
 * capacity checks for a distribution chain.
 *
 * Fills the gap validateElectricalDistribution() explicitly disclaims
 * ("Does not replace local electrical code calculations,
 * fault-current/interrupting-rating checks or coordination"):
 *   - Selectivity between an upstream and a downstream breaker.
 *   - Breaking capacity (Icu / Ics) against the prospective fault current.
 *   - A whole-chain audit (source → load) plus a panel-link audit that
 *     walks PanelLink feeders against downstream main/branch breakers.
 *
 * What this is NOT:
 *   - It is not a code-compliance proof for any jurisdiction. Selectivity
 *     between real devices is decided by the manufacturer's time-current
 *     curves (IEC 60947-2 selectivity tables); this module can only say
 *     "likely" or "not demonstrated". The 1.6× ratio below is the common
 *     rule of thumb for thermal-magnetic MCCBs of the same family — a
 *     screening threshold, not a guarantee, and it does not apply across
 *     device families, fuse/MCCB mixes, or electronic-trip units.
 *   - Fault currents are INPUTS (from a fault study or the utility), never
 *     computed here: no source impedance model exists in this codebase.
 *   - No arc-flash, discrimination-by-zone, or earth-fault selectivity.
 *
 * Every result carries its assumptions in `basis` so a report can quote
 * them. Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 */

import type { ElectricalPanel } from "./electrical";
import type { PanelLink } from "./distribution";

/**
 * Minimum upstream/downstream rating ratio at which selectivity is
 * considered LIKELY for same-family thermal-magnetic MCCBs (screening
 * rule of thumb; manufacturer curves govern — see module header).
 */
export const SELECTIVITY_RATIO_MIN = 1.6;

export interface ProtectionDevice {
  /** Human label, e.g. "DP main" or "Panel A / circuit 3". */
  label: string;
  /** Rated current In (A). */
  ratingA: number;
  /** Ultimate breaking capacity Icu (kA), if known. */
  breakingCapacityKA?: number;
  /** Service breaking capacity Ics (kA), if known. */
  serviceBreakingCapacityKA?: number;
  /** Prospective short-circuit current at this device (kA), if known. */
  faultCurrentKA?: number;
}

export type SelectivityStatus = "likely" | "not-demonstrated" | "invalid";

export interface SelectivityResult {
  upstreamLabel: string;
  downstreamLabel: string;
  ratio: number;
  status: SelectivityStatus;
  findings: string[];
  basis: string;
}

const SELECTIVITY_BASIS =
  "Screening rule only: upstream/downstream ≥ 1.6× is the common thermal-magnetic MCCB same-family rule of thumb. " +
  "Selectivity is proven only by the manufacturer's time-current curves (IEC 60947-2 selectivity tables); " +
  "this check never claims guaranteed discrimination.";

export function checkBreakerSelectivity(
  upstream: ProtectionDevice,
  downstream: ProtectionDevice,
): SelectivityResult {
  const findings: string[] = [];
  const up = upstream.ratingA;
  const down = downstream.ratingA;
  let status: SelectivityStatus;
  let ratio = Number.NaN;
  if (!(up > 0) || !(down > 0) || !Number.isFinite(up) || !Number.isFinite(down)) {
    status = "invalid";
    findings.push(
      `Cannot assess selectivity between '${upstream.label}' and '${downstream.label}' — breaker ratings must be finite and positive.`,
    );
  } else {
    ratio = up / down;
    if (up <= down) {
      status = "invalid";
      findings.push(
        `Upstream breaker '${upstream.label}' (${up} A) does not exceed downstream '${downstream.label}' (${down} A) — ` +
        `the upstream device trips first or together; selectivity is impossible.`,
      );
    } else if (ratio >= SELECTIVITY_RATIO_MIN) {
      status = "likely";
    } else {
      status = "not-demonstrated";
      findings.push(
        `Selectivity between '${upstream.label}' (${up} A) and '${downstream.label}' (${down} A) is not demonstrated ` +
        `(ratio ${ratio.toFixed(2)}× < ${SELECTIVITY_RATIO_MIN}×) — check the manufacturer's time-current curves, ` +
        `or increase the ratio / use a selective device.`,
      );
    }
  }
  return { upstreamLabel: upstream.label, downstreamLabel: downstream.label, ratio, status, findings, basis: SELECTIVITY_BASIS };
}

export interface BreakingCapacityResult {
  label: string;
  ok: boolean;
  findings: string[];
  basis: string;
}

const BREAKING_BASIS =
  "Icu must cover the prospective fault current at the device; Ics (when given) must also cover it for the breaker " +
  "to remain serviceable after the fault. Fault currents are caller-supplied inputs (fault study / utility data).";

export function checkBreakingCapacity(device: ProtectionDevice): BreakingCapacityResult {
  const findings: string[] = [];
  const ik = device.faultCurrentKA;
  if (ik == null) {
    findings.push(
      `No prospective fault current given for '${device.label}' — breaking capacity cannot be checked; supply faultCurrentKA from a fault study.`,
    );
    return { label: device.label, ok: false, findings, basis: BREAKING_BASIS };
  }
  if (!(ik >= 0) || !Number.isFinite(ik)) {
    findings.push(`Fault current for '${device.label}' must be finite and non-negative.`);
    return { label: device.label, ok: false, findings, basis: BREAKING_BASIS };
  }
  if (device.breakingCapacityKA == null) {
    findings.push(
      `No breaking capacity (Icu) given for '${device.label}' — cannot verify ${ik} kA prospective fault current.`,
    );
    return { label: device.label, ok: false, findings, basis: BREAKING_BASIS };
  }
  if (device.breakingCapacityKA < ik) {
    findings.push(
      `Breaker '${device.label}' Icu ${device.breakingCapacityKA} kA is below the ${ik} kA prospective fault current — breaking capacity exceeded.`,
    );
  } else if (
    device.serviceBreakingCapacityKA != null &&
    device.serviceBreakingCapacityKA < ik
  ) {
    findings.push(
      `Breaker '${device.label}' Ics ${device.serviceBreakingCapacityKA} kA is below the ${ik} kA prospective fault current — ` +
      `the breaker clears the fault (Icu ${device.breakingCapacityKA} kA) but may not remain serviceable afterwards.`,
    );
  }
  return { label: device.label, ok: findings.length === 0, findings, basis: BREAKING_BASIS };
}

export interface ProtectionChainResult {
  /** True when no error or warning findings were produced. */
  ok: boolean;
  findings: string[];
  selectivity: SelectivityResult[];
  breakingCapacity: BreakingCapacityResult[];
  basis: string;
}

/**
 * Audit one protection chain, ordered source → load.
 *
 * Checks, in order: every adjacent pair for selectivity; every device's
 * breaking capacity against its own fault current; and the load-end
 * device's rating against the design current (Ib ≤ In, the first leg of
 * the Ib ≤ In ≤ Iz coordination already checked per-circuit by
 * conductorCheck in electrical-calc.ts).
 */
export function auditProtectionChain(
  devices: ProtectionDevice[],
  designCurrentA: number,
): ProtectionChainResult {
  const findings: string[] = [];
  const selectivity: SelectivityResult[] = [];
  const breakingCapacity: BreakingCapacityResult[] = [];
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error("auditProtectionChain: at least one protective device is required");
  }
  if (!Number.isFinite(designCurrentA) || designCurrentA < 0) {
    throw new Error("auditProtectionChain: designCurrentA must be finite and non-negative");
  }
  for (let i = 0; i + 1 < devices.length; i++) {
    const r = checkBreakerSelectivity(devices[i], devices[i + 1]);
    selectivity.push(r);
    findings.push(...r.findings);
  }
  for (const d of devices) {
    const r = checkBreakingCapacity(d);
    breakingCapacity.push(r);
    findings.push(...r.findings);
  }
  const last = devices[devices.length - 1];
  if (Number.isFinite(last.ratingA) && last.ratingA > 0 && designCurrentA > last.ratingA) {
    findings.push(
      `Design current ${designCurrentA} A exceeds the load-end breaker '${last.label}' (${last.ratingA} A) — Ib ≤ In violated.`,
    );
  }
  return {
    ok: findings.length === 0,
    findings,
    selectivity,
    breakingCapacity,
    basis: SELECTIVITY_BASIS + " " + BREAKING_BASIS,
  };
}

export interface PanelCoordinationResult {
  ok: boolean;
  findings: string[];
  selectivity: SelectivityResult[];
  basis: string;
}

/**
 * Breaker coordination across a distribution cascade: for every feeder
 * link, the upstream feed breaker is checked against the downstream
 * panel's main breaker — or, when the panel has no main, its largest
 * branch breaker. Links whose downstream panel has no breaker at all
 * produce a finding (coordination cannot be assessed) rather than a
 * silent pass. Feeder-breaker adequacy against demand current is the
 * distribution module's job (buildDistributionSummary); this is the
 * selectivity leg only.
 */
export function auditPanelBreakerCoordination(
  panels: readonly ElectricalPanel[],
  links: readonly PanelLink[],
): PanelCoordinationResult {
  const findings: string[] = [];
  const selectivity: SelectivityResult[] = [];
  const panelById = new Map(panels.map((p) => [p.id, p]));
  links.forEach((link, i) => {
    const downstream = panelById.get(link.downstreamPanelId);
    const upstream = panelById.get(link.upstreamPanelId);
    if (!downstream || !upstream) return; // unknown panels are the distribution module's diagnostic
    if (link.feedBreakerA == null || !(link.feedBreakerA > 0)) {
      findings.push(`Feeder link ${i} ('${upstream.id}' → '${downstream.id}') has no usable feed breaker rating — coordination cannot be assessed.`);
      return;
    }
    const downRating = downstream.mainBreakerRatingA ??
      downstream.circuits.reduce((m, c) => Math.max(m, c.breakerRatingA), 0);
    if (!(downRating > 0)) {
      findings.push(
        `Downstream panel '${downstream.id}' has no main breaker and no branch breakers — coordination against feeder ${link.feedBreakerA} A cannot be assessed.`,
      );
      return;
    }
    const downLabel = downstream.mainBreakerRatingA != null
      ? `panel '${downstream.id}' main`
      : `panel '${downstream.id}' largest branch`;
    const r = checkBreakerSelectivity(
      { label: `feeder '${upstream.id}' → '${downstream.id}'`, ratingA: link.feedBreakerA },
      { label: downLabel, ratingA: downRating },
    );
    selectivity.push(r);
    findings.push(...r.findings);
  });
  return { ok: findings.length === 0, findings, selectivity, basis: SELECTIVITY_BASIS };
}
