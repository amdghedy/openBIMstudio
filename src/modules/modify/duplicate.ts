/**
 * Duplicating Modify commands: Copy, Array (linear/radial), Mirror
 * (MASTER PROMPT MODULE 2C.8).
 *
 * Identifier policy (spec 2C.8): every copy receives a fresh id via the
 * context allocator; instance parameters are cloned; hosts are remapped
 * when the host itself is part of the copy set; MEP connector connections
 * are NOT cloned (a copy is a disconnected instance until reconnected).
 *
 * Array placement (spec CalculateArrayPlacements): linear arrays place
 * `count` instances at `step` increments (the ORIGINAL stays put; copies
 * start at step 1); radial arrays rotate about `center` by
 * totalAngle/(count−1) — matching the observable behaviour that a radial
 * array with count N spans the total angle in N−1 increments.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import {
  ModifyCommandBase,
  type CommandInput, type ModifyContext, type PendingChange, type ModifyElement,
} from "./command";

/** Deep-clone an element with a fresh id (CloneElementDefinition). */
export function cloneElement(src: ModifyElement, newId: string, overrides?: Partial<ModifyElement>): ModifyElement {
  return {
    ...src,
    id: newId,
    position: [...src.position] as [number, number],
    rotationZ: src.rotationZ,
    curve: src.curve
      ? { start: [...src.curve.start] as [number, number], end: [...src.curve.end] as [number, number] }
      : undefined,
    params: src.params ? { ...src.params } : undefined,
    pinned: false,
    ...overrides,
  };
}

export class CopyCommand extends ModifyCommandBase {
  readonly name = "copy";

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "copy") throw new Error("CopyCommand: input must be 'copy'");
    const out: PendingChange[] = [];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id)!;
      const newId = this.ctx.allocateId?.() ?? `${id}-copy`;
      const copy = cloneElement(el, newId, {
        position: [el.position[0] + input.translation[0], el.position[1] + input.translation[1]],
      });
      out.push({ elementId: id, patch: {}, newElement: copy });
    }
    this.pending = out;
    return out;
  }

  GetRequiredReferences(): string[] {
    return ["copy-base-point", "copy-target-point"];
  }
}

export class ArrayLinearCommand extends ModifyCommandBase {
  readonly name = "array-linear";

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "array-linear") throw new Error("ArrayLinearCommand: input must be 'array-linear'");
    if (input.count < 2) {
      this.err("array-count", `array count must be >= 2, got ${input.count}`);
      return [];
    }
    const out: PendingChange[] = [];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id)!;
      for (let i = 1; i < input.count; i++) {
        const newId = this.ctx.allocateId?.() ?? `${id}-a${i}`;
        out.push({
          elementId: id,
          patch: {},
          newElement: cloneElement(el, newId, {
            position: [el.position[0] + input.step[0] * i, el.position[1] + input.step[1] * i],
          }),
        });
      }
    }
    this.pending = out;
    return out;
  }

  GetRequiredReferences(): string[] {
    return ["array-count", "array-step-or-endpoint"];
  }
}

export class ArrayRadialCommand extends ModifyCommandBase {
  readonly name = "array-radial";

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "array-radial") throw new Error("ArrayRadialCommand: input must be 'array-radial'");
    if (input.count < 2) {
      this.err("array-count", `array count must be >= 2, got ${input.count}`);
      return [];
    }
    const step = input.totalAngle / (input.count - 1);
    const out: PendingChange[] = [];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id)!;
      for (let i = 1; i < input.count; i++) {
        const a = step * i;
        const c = Math.cos(a), s = Math.sin(a);
        const dx = el.position[0] - input.center[0];
        const dy = el.position[1] - input.center[1];
        const np: [number, number] = [
          input.center[0] + dx * c - dy * s,
          input.center[1] + dx * s + dy * c,
        ];
        const newId = this.ctx.allocateId?.() ?? `${id}-r${i}`;
        out.push({
          elementId: id,
          patch: {},
          newElement: cloneElement(el, newId, {
            position: np,
            rotationZ: input.rotateInstances ? el.rotationZ + a : el.rotationZ,
          }),
        });
      }
    }
    this.pending = out;
    return out;
  }

  GetRequiredReferences(): string[] {
    return ["array-center", "array-count", "array-angle"];
  }
}

/** Mirror about a line (point + direction) with optional copy semantics. */
export function mirrorTransform(
  p: [number, number],
  linePoint: [number, number],
  lineDir: [number, number],
): [number, number] {
  const l = Math.hypot(lineDir[0], lineDir[1]) || 1;
  const ux = lineDir[0] / l, uy = lineDir[1] / l;
  const rx = p[0] - linePoint[0];
  const ry = p[1] - linePoint[1];
  // Reflect: r' = 2·(r·u)·u − r
  const along = rx * ux + ry * uy;
  return [
    linePoint[0] + 2 * along * ux - rx,
    linePoint[1] + 2 * along * uy - ry,
  ];
}

export class MirrorCommand extends ModifyCommandBase {
  readonly name = "mirror";
  private copy = true;
  private linePoint: [number, number] = [0, 0];
  private lineDir: [number, number] = [1, 0];

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "mirror-axis") throw new Error("MirrorCommand: input must be 'mirror-axis'");
    this.copy = input.copy;
    this.linePoint = input.point;
    this.lineDir = input.dir;
    const out: PendingChange[] = [];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id)!;
      const mp = mirrorTransform(el.position, this.linePoint, this.lineDir);
      // Mirrored rotation: reflect the direction vector of the element's
      // local x-axis and take atan2 (handedness flips sign of angle).
      const cosA = Math.cos(el.rotationZ), sinA = Math.sin(el.rotationZ);
      const dirW: [number, number] = [cosA, sinA];
      const dirM = mirrorTransform(
        [el.position[0] + dirW[0], el.position[1] + dirW[1]],
        this.linePoint, this.lineDir,
      );
      const rot = Math.atan2(dirM[1] - mp[1], dirM[0] - mp[0]);
      if (this.copy) {
        const newId = this.ctx.allocateId?.() ?? `${id}-m`;
        // World-space mirrored curve re-expressed in the NEW local frame
        // (mirrored position + mirrored rotation), so rotated elements
        // mirror correctly.
        const cos0 = Math.cos(el.rotationZ), sin0 = Math.sin(el.rotationZ);
        const toWorld = (p: [number, number]): [number, number] => [
          el.position[0] + p[0] * cos0 - p[1] * sin0,
          el.position[1] + p[0] * sin0 + p[1] * cos0,
        ];
        const toNewLocal = (p: [number, number]): [number, number] => {
          const wx = p[0] - mp[0], wy = p[1] - mp[1];
          const c = Math.cos(-rot), s = Math.sin(-rot);
          return [wx * c - wy * s, wx * s + wy * c];
        };
        out.push({
          elementId: id,
          patch: {},
          newElement: cloneElement(el, newId, {
            position: mp,
            rotationZ: rot,
            curve: el.curve
              ? {
                  start: toNewLocal(mirrorTransform(toWorld(el.curve.start), this.linePoint, this.lineDir)),
                  end: toNewLocal(mirrorTransform(toWorld(el.curve.end), this.linePoint, this.lineDir)),
                }
              : undefined,
          }),
        });
      } else {
        // Mirror in place: the element moves to its mirrored transform.
        out.push({
          elementId: id,
          patch: { position: mp, rotationZ: rot, reason: "mirror" },
        });
      }
    }
    this.pending = out;
    return out;
  }

  GetRequiredReferences(): string[] {
    return ["mirror-axis-point", "mirror-axis-direction", "mirror-copy-or-move"];
  }
}
