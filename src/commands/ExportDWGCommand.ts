// src/commands/ExportDWGCommand.ts
// Placeholder implementation – actual DWG/DXF export requires a library.
// This stub satisfies TypeScript compilation.
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';

export class ExportDWGCommand extends Command {
  name = 'Export DWG/DXF';
  constructor(private api: IfcAPI, private modelID: number, private fileName: string = 'model.dxf') { super(); }

  async execute() {
    // Placeholder: just log the intention.
    console.log(`ExportDWGCommand executed for model ${this.modelID}, output: ${this.fileName}`);
    // In a real implementation, iterate over geometry and write using a DWG/DXF writer.
  }
  async undo() {
    // No undo for file export
  }
}
