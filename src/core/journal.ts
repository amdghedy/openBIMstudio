export type Op = { seq: number; ts: number; kind: string; payload: unknown };

export class Journal {
  private constructor(private store: JournalStore, private nextSeq: number) {}

  static async open(store: JournalStore): Promise<Journal> {
    const snap = await store.loadNewestSnapshot();
    const j = new Journal(store, snap ? snap.seq + 1 : 1);
    await j.replayAfter(snap);   // deterministic: same ops, same state
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
    await this.store.writeSnapshot(seq, serializeState());
    await this.store.compactJournalBefore(seq);
  }
}
