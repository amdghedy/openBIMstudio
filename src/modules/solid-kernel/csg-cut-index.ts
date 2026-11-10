/**
 * Conservative static AABB BVH for finite geometric support patches.
 *
 * The index bounds the finite triangle/edge that generated a cutting
 * plane, never the infinite plane itself. Queries are inclusive so
 * touching bounds are retained. Invalid bounds are kept in an overflow
 * list and returned for every query; malformed input cannot create a
 * false-negative candidate.
 */

export interface Aabb3 {
  minX:number; minY:number; minZ:number;
  maxX:number; maxY:number; maxZ:number;
}
export interface AabbIndexEntry {
  itemIndex:number;
  bounds:Aabb3;
}
interface Node extends Aabb3 {
  left:Node|null;
  right:Node|null;
  entries:AabbIndexEntry[]|null;
}
export interface AabbIndex {
  readonly root:Node|null;
  readonly itemCount:number;
  readonly overflow:number[];
}

function valid(b:Aabb3):boolean {
  return [b.minX,b.minY,b.minZ,b.maxX,b.maxY,b.maxZ].every(Number.isFinite) &&
    b.minX<=b.maxX && b.minY<=b.maxY && b.minZ<=b.maxZ;
}
function unionBounds(items:AabbIndexEntry[]):Aabb3 {
  return items.reduce((b,e)=>({
    minX:Math.min(b.minX,e.bounds.minX),minY:Math.min(b.minY,e.bounds.minY),minZ:Math.min(b.minZ,e.bounds.minZ),
    maxX:Math.max(b.maxX,e.bounds.maxX),maxY:Math.max(b.maxY,e.bounds.maxY),maxZ:Math.max(b.maxZ,e.bounds.maxZ),
  }),{minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity});
}
function build(items:AabbIndexEntry[],leafSize:number):Node {
  const bounds=unionBounds(items);
  if(items.length<=leafSize)return {...bounds,left:null,right:null,entries:items};
  const spanX=bounds.maxX-bounds.minX,spanY=bounds.maxY-bounds.minY,spanZ=bounds.maxZ-bounds.minZ;
  const axis:"x"|"y"|"z"=spanX>=spanY&&spanX>=spanZ?"x":spanY>=spanZ?"y":"z";
  const center=(e:AabbIndexEntry)=>axis==="x"?(e.bounds.minX+e.bounds.maxX)/2:
    axis==="y"?(e.bounds.minY+e.bounds.maxY)/2:(e.bounds.minZ+e.bounds.maxZ)/2;
  items.sort((a,b)=>center(a)-center(b)||a.itemIndex-b.itemIndex);
  const mid=Math.floor(items.length/2);
  return {...bounds,left:build(items.slice(0,mid),leafSize),right:build(items.slice(mid),leafSize),entries:null};
}
function overlaps(a:Aabb3,b:Aabb3,eps:number):boolean {
  return a.minX<=b.maxX+eps&&a.maxX>=b.minX-eps&&
    a.minY<=b.maxY+eps&&a.maxY>=b.minY-eps&&
    a.minZ<=b.maxZ+eps&&a.maxZ>=b.minZ-eps;
}

/** Build a median-split BVH. Multiple entries may refer to one item. */
export function createAabbIndex(entries:AabbIndexEntry[],itemCount:number,leafSize=8):AabbIndex {
  const finite:AabbIndexEntry[]=[];
  const overflow=new Set<number>();
  for(const e of entries) {
    if(!Number.isInteger(e.itemIndex)||e.itemIndex<0||e.itemIndex>=itemCount)continue;
    if(valid(e.bounds))finite.push(e);
    else overflow.add(e.itemIndex);
  }
  return {
    root:finite.length?build(finite,Math.max(2,Math.floor(leafSize))):null,
    itemCount,
    overflow:[...overflow].sort((a,b)=>a-b),
  };
}

/** Return sorted unique item indices whose finite supports overlap query. */
export function queryAabbIndex(index:AabbIndex,query:Aabb3,epsilon=1e-9):number[] {
  if(!valid(query))return Array.from({length:index.itemCount},(_,i)=>i);
  const found=new Set<number>(index.overflow);
  const stack:Node[]=[];
  if(index.root)stack.push(index.root);
  while(stack.length) {
    const node=stack.pop()!;
    if(!overlaps(node,query,epsilon))continue;
    if(node.entries) {
      for(const e of node.entries)if(overlaps(e.bounds,query,epsilon))found.add(e.itemIndex);
    } else {
      if(node.left)stack.push(node.left);
      if(node.right)stack.push(node.right);
    }
  }
  return [...found].sort((a,b)=>a-b);
}
