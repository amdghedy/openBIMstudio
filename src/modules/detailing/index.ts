/**
 * Detailing tools — detail components, repeating details, keynotes
 */
export interface DetailComponent {
  id: string;
  name: string;
  familyName: string;
  viewId?: string;
  position: { x: number; y: number };
  scale?: number;
  rotation?: number;
}

export interface Keynote {
  id: string;
  key: string;
  text: string;
  elementId?: string;
  viewId?: string;
}

export interface RepeatingDetail {
  id: string;
  componentName: string;
  path: Array<{ x: number; y: number }>;
  spacing: number;
}

export interface IDetailingService {
  placeDetail(name: string, familyName: string, pos: { x: number; y: number }, viewId?: string): DetailComponent;
  addKeynote(key: string, text: string, elementId?: string, viewId?: string): Keynote;
  placeRepeating(componentName: string, path: Array<{ x: number; y: number }>, spacing: number): RepeatingDetail;
  listDetails(): DetailComponent[];
  listKeynotes(): Keynote[];
}

let _instance: DetailingService | null = null;

export class DetailingService implements IDetailingService {
  private details = new Map<string, DetailComponent>();
  private keynotes = new Map<string, Keynote>();
  private repeating = new Map<string, RepeatingDetail>();

  placeDetail(
    name: string,
    familyName: string,
    pos: { x: number; y: number },
    viewId?: string
  ): DetailComponent {
    const id = `det_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const d: DetailComponent = { id, name, familyName, position: { ...pos }, viewId, scale: 1, rotation: 0 };
    this.details.set(id, d);
    return d;
  }

  addKeynote(key: string, text: string, elementId?: string, viewId?: string): Keynote {
    const id = `kn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const k: Keynote = { id, key, text, elementId, viewId };
    this.keynotes.set(id, k);
    return k;
  }

  placeRepeating(
    componentName: string,
    path: Array<{ x: number; y: number }>,
    spacing: number
  ): RepeatingDetail {
    const id = `rd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const r: RepeatingDetail = { id, componentName, path: [...path], spacing };
    this.repeating.set(id, r);
    return r;
  }

  listDetails(): DetailComponent[] {
    return [...this.details.values()];
  }

  listKeynotes(): Keynote[] {
    return [...this.keynotes.values()];
  }
}

export function getDetailingService(): DetailingService {
  if (!_instance) _instance = new DetailingService();
  return _instance;
}
