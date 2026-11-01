export type Op = { seq: number; ts: number; kind: string; payload: unknown };

/** Storage contract; implement per backend (OPFS, SQLite, ...). */
export interface JournalStore {
  loadNewestSnapshot(): Promise<{ seq: number; state: string } | null>;
  /** Ops newer than the snapshot, in seq order. */
  opsAfter(seq: number): Promise<Op[]>;
  appendLine(line: string): Promise<void>;
  writeSnapshot(seq: number, state: string): Promise<void>;
  compactJournalBefore(seq: number): Promise<void>;
}

export class Journal {
  private constructor(
    private store: JournalStore,
    private nextSeq: number,
    private serialize: () => string,
    private apply: (op: Op) => void,
  ) {}

  static async open(
    store: JournalStore,
    apply: (op: Op) => void,
    serialize: () => string,
  ): Promise<Journal> {
    const snap = await store.loadNewestSnapshot();
    const j = new Journal(store, snap ? snap.seq + 1 : 1, serialize, apply);
    for (const op of await store.opsAfter(snap ? snap.seq : 0)) apply(op); // deterministic: same ops, same state
    return j;
  }

  async append(kind: string, payload: unknown): Promise<Op> {
    const op: Op = { seq: this.nextSeq++, ts: Date.now(), kind, payload };
    await this.store.appendLine(JSON.stringify(op));  // durable before this returns
    if (op.seq % 500 === 0) await this.snapshot();
    return op;
  }

  private async snapshot(): Promise<void> {
    const seq = this.nextSeq - 1;
    await this.store.writeSnapshot(seq, this.serialize());
    await this.store.compactJournalBefore(seq);
  }
}
