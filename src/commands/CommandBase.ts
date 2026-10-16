export abstract class Command {
  /** Human readable name */
  abstract name: string;
  /** Execute the command */
  abstract execute(): Promise<any>;
  /** Undo the command */
  abstract undo(): Promise<any>;
  /** Optional JSON serialization for versioning */
  toJSON?(): any {
    return { type: this.constructor.name };
  }
}
