import { TransactionService } from '../../src/modules/transaction';

type Wall = { id: string; length: number; x: number };
export type Model = { walls: Wall[]; cursor: number; readonly tx: TransactionService };
export type Operation =
  | { kind: 'move'; dx: number }
  | { kind: 'split' }
  | { kind: 'join' };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stateOf(model: Model) {
  return { walls: clone(model.walls), cursor: model.cursor };
}

export function seedModel(): Model {
  const model = { walls: [{ id: 'w1', length: 10, x: 0 }], cursor: 0, tx: null as unknown as TransactionService };
  const tx = new TransactionService();
  tx.setApplyHandler((change, reverse) => {
    const next = clone((reverse ? change.oldValue : change.newValue) as ReturnType<typeof stateOf>);
    model.walls = next.walls;
    model.cursor = next.cursor;
  });
  model.tx = tx;
  return model;
}

export function applyOp(model: Model, operation: Operation): void {
  const before = stateOf(model);
  const next = stateOf(model);
  if (operation.kind === 'move') {
    next.cursor += operation.dx;
    next.walls = next.walls.map((wall) => ({ ...wall, x: wall.x + operation.dx }));
  } else if (operation.kind === 'split' && next.walls.length > 0) {
    const wall = next.walls[0];
    const half = wall.length / 2;
    next.walls = [{ ...wall, id: `${wall.id}-a`, length: half }, { ...wall, id: `${wall.id}-b`, length: half }, ...next.walls.slice(1)];
  } else if (operation.kind === 'join' && next.walls.length >= 2) {
    const [a, b, ...rest] = next.walls;
    next.walls = [{ ...a, length: a.length + b.length }, ...rest];
  }
  model.tx.start({ name: operation.kind, source: 'property-test' });
  model.tx.recordChange({ elementId: 'model', propertyPath: 'state', oldValue: before, newValue: next, source: 'property-test' });
  model.tx.commit();
}

export function undo(model: Model): void {
  model.tx.undo();
}

export function hashState(model: Model): string {
  return JSON.stringify(stateOf(model));
}
