import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DurableStoreError, requireIntegrity } from './integrity';

export interface PlanningReadResource { resourceId: string; digest: string; revision: string; sizeBytes: number; rootId: string }
export interface PlanningReadRegistry {
  readonly contract: 'LOCAL_PINNED_READ:1';
  describe(resourceId: string): PlanningReadResource | undefined;
  assertCurrent(resourceId:string,digest:string,revision:string):void;
  read(resourceId: string, digest: string): { text: string; digest: string; sizeBytes: number };
}
const validated = new WeakSet<object>();
export const isValidatedPlanningReadRegistry=(value:unknown):value is PlanningReadRegistry=>!!value&&typeof value==='object'&&validated.has(value);
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Linux descriptor-relative traversal, no shell/network and no follow of symbolic links.
 * Unsupported platforms fail closed; this is not an arbitrary-code sandbox. */
export function createLocalPlanningReadRegistry(options: {
  root: string; rootId: string; files: Record<string,string>; maxBytes?: number;
}): PlanningReadRegistry {
  requireIntegrity(process.platform==='linux' && isAbsolute(options.root));
  const limit=options.maxBytes ?? 64*1024;
  requireIntegrity(Number.isSafeInteger(limit) && limit>0 && limit<=1024*1024);
  const root=resolve(options.root), rootParts=root.slice(parse(root).root.length).split('/').filter(Boolean);
  let path='/';
  for(const part of rootParts) {path=join(path,part); const s=lstatSync(path);requireIntegrity(s.isDirectory()&&!s.isSymbolicLink());}
  const rootStat=lstatSync(root), files=new Map<string,{parts:string[]; metadata:PlanningReadResource}>();
  const load=(parts:string[],metadataOnly=false)=>{
    const current=lstatSync(root);
    requireIntegrity(current.isDirectory()&&!current.isSymbolicLink() && current.dev===rootStat.dev && current.ino===rootStat.ino);
    const fds:number[]=[];
    try {
      let fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fds.push(fd);
      requireIntegrity(fstatSync(fd).ino===rootStat.ino && fstatSync(fd).dev===rootStat.dev);
      for(let i=0;i<parts.length;i++) {
        fd=openSync(`/proc/self/fd/${fd}/${parts[i]}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(i<parts.length-1?constants.O_DIRECTORY:0));fds.push(fd);
      }
      const before=fstatSync(fd,{bigint:true});requireIntegrity(before.isFile() && before.size<=BigInt(limit) && before.nlink===1n);
      if(metadataOnly)return {text:'',digest:'',sizeBytes:Number(before.size),revision:[before.dev,before.ino,before.mtimeNs,before.ctimeNs,before.size].join(':')};
      const buffer=Buffer.alloc(Number(before.size)+1);let size=0,n:number;
      while(size<buffer.length && (n=readSync(fd,buffer,size,buffer.length-size,null))>0) size+=n;
      const after=fstatSync(fd,{bigint:true});
      requireIntegrity(BigInt(size)===before.size && before.size===after.size && before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs);
      const bytes=buffer.subarray(0,size),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      requireIntegrity(!text.includes('\u0000'));
      return {text,digest:hash(bytes),sizeBytes:size,revision:[before.dev,before.ino,before.mtimeNs,before.ctimeNs,before.size].join(':')};
    } catch {throw new DurableStoreError('PLANNING_READ_DENIED');}
    finally {for(const fd of fds.reverse()) closeSync(fd);}
  };
  for(const [id,file] of Object.entries(options.files)) {
    requireIntegrity(/^[A-Za-z0-9_.-]{1,100}$/.test(id) && typeof file==='string' && file.length>0
      && !isAbsolute(file) && !/[\\:\u0000]/.test(file));
    const parts=file.split('/');requireIntegrity(parts.every(p=>p!==''&&p!=='.'&&p!=='..'));
    const rel=relative(root,resolve(root,file));requireIntegrity(rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel));
    const read=load(parts);files.set(id,{parts,metadata:{resourceId:id,digest:read.digest,revision:read.revision,sizeBytes:read.sizeBytes,rootId:options.rootId}});
  }
  const registry=Object.freeze({contract:'LOCAL_PINNED_READ:1' as const,
    describe(id:string){const r=files.get(id);return r&&structuredClone(r.metadata);},
    assertCurrent(id:string,expected:string,revision:string){const r=files.get(id);if(!r||r.metadata.digest!==expected||r.metadata.revision!==revision||load(r.parts,true).revision!==revision)throw new DurableStoreError('PLANNING_READ_DENIED');},
    read(id:string,expected:string){const r=files.get(id);if(!r||r.metadata.digest!==expected)throw new DurableStoreError('PLANNING_READ_DENIED');
      const x=load(r.parts);if(x.digest!==expected||x.revision!==r.metadata.revision)throw new DurableStoreError('PLANNING_READ_DENIED');
      return {text:x.text,digest:x.digest,sizeBytes:x.sizeBytes};},
  });
  validated.add(registry);return registry;
}
