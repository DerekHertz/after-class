import {expect,test} from 'bun:test';
const root=process.cwd();
const {createEvidence}=await import(`${root}/src/backend/evidence/index.ts`);
const {createPreparation}=await import(`${root}/src/backend/preparation/index.ts`);
const {createMemo}=await import(`${root}/src/backend/providers/memo.ts`);
const {productFrameChangeTask}=await import(`${root}/src/backend/providers/jev-tasks.ts`);
const {canonicalInterpretation}=await import(`${root}/src/backend/preparation/tasks.ts`);
const {Material,interval}=await import(`${root}/src/shared/time.ts`);
const {stableId}=await import(`${root}/src/shared/ids.ts`);
const {stream}=await import(`${root}/test/evidence-fixtures.ts`);
const {fakeTask,ok,testUserDb}=await import(`${root}/test/fakes.ts`);
const {tmpDir}=await import(`${root}/test/tmp.ts`);
function world(o:any={}) {
 const db=o.db??testUserDb(),dir=o.dir??tmpDir('frame3-life-'),s=o.s??stream(),clock={wall:1_000_000,mono:0};
 const memo=createMemo(db,'live',{retryDelayMs:()=>0});
 const script={answer:o.answer??(()=>ok({verdict:'yes',p:.9})),interpret:o.interpret??(()=>ok({concepts:[],links:[],supersedes:[]}))};
 const frameTask=Object.assign(fakeTask({purpose:'frame_change',answer:(i:any)=>script.answer(i)}),{canonicalInput:productFrameChangeTask({}).canonicalInput});
 const interpret=Object.assign(fakeTask({purpose:'interpretation',provider:'claude',answer:(i:any)=>script.interpret(i)}),{canonicalInput:canonicalInterpretation});
 const unused=fakeTask({answer:()=>ok({verdict:'yes',p:.9})});
 const evidence=createEvidence(db,dir,{now:()=>clock.wall,monotonic:()=>clock.mono,lookupFrameChange:(i:any)=>memo.lookup(frameTask,i),frameChangeKey:(i:any)=>memo.key(frameTask,i),runFrameChange:(i:any,signal:any)=>memo.run(frameTask,i,{signal}),onChange:()=>{}});
 const revs=new Map(),current=new Map();
 const prep=()=>createPreparation(db,{chunk:(id:any)=>revs.get(id)??null,currentChunks:()=>[...current.values()],bundle:evidence.bundle,pin:evidence.pin,lookup:memo.lookup,lookupKey:memo.lookupKey,run:(t:any,i:any,signal:any)=>memo.run(t,i,{signal}),clearFailures:memo.clearFailures,tasks:{interpret,revise:unused,checkClaim:unused,searchResources:unused},frameBytes:evidence.frameBytes});
 const preparation=prep();
 const ingest=()=>evidence.ingest({captureId:s.captureId,facts:s.facts.splice(0)});
 const seed=()=>{s.control('start');s.source();s.transcript(Array.from({length:24},(_,i)=>[i*5,(i+1)*5,`caption ${i}`]));s.span(0,60);s.frame('a',1);s.frame('b',55);ingest();};
 const close=(ordinal:number,start:number,end:number)=>{const chunkId=stableId('chk',s.captureId,ordinal),material=Material.of([[stableId('src','youtube','aaaaaaaaaaa'),[interval(start,end)]]]);const prev=current.get(ordinal);const r={id:stableId('crv',chunkId,Material.canonical(material)),chunkId,captureId:s.captureId,ordinal,revisionNo:(prev?.revisionNo??0)+1,material,windows:[],provenance:'boundary',closedAtSeq:db.nextSeq(),supersedes:prev?.id??null};revs.set(r.id,r);current.set(ordinal,r);return r;};
 const run=async(items:any[])=>{for(const item of items)await item.run(new AbortController().signal);};
 const drain=async(p=preparation)=>{for(let i=0;i<12;i++){const work=p.demand(s.captureId);if(work.length===0)return;await run(work);}throw Error('did not drain');};
 return {db,dir,s,clock,memo,script,frameTask,interpret,evidence,revs,current,prep,preparation,ingest,seed,close,run,drain};
}

test('a deleted or expired frame leaves no wait deadline behind',()=>{
 const OriginalMap=globalThis.Map,captured:any[]=[];
 globalThis.Map=class extends OriginalMap {constructor(){super();if(new Error().stack?.includes('/src/backend/evidence/index.ts:'))captured.push(this);}} as any;
 let w:any;try{w=world();}finally{globalThis.Map=OriginalMap;}
 const ids:any[]=[];
 for(let k=0;k<20;k++){const s=stream();s.control('start');s.source();s.span(0,10);s.frame('a',1);s.frame('b',8);w.evidence.ingest({captureId:s.captureId,facts:s.facts});w.evidence.frameDemand(s.captureId);ids.push({captureId:s.captureId,id:stableId('ev',s.captureId,'b')});}
 const holds=captured.find((m:any)=>m.get(ids[0].captureId) instanceof OriginalMap);expect(holds).toBeDefined();const entries=()=>[...holds.values()].reduce((n:number,m:any)=>n+m.size,0);expect(entries()).toBe(20);
 w.evidence.deleteByUser(ids.slice(0,10).map((x:any)=>x.id),'delete-10');for(const x of ids)w.evidence.frameDemand(x.captureId);expect(entries()).toBe(10);
 w.evidence.sweepExpired(w.clock.wall+31*86400000,30);w.clock.mono+=86400000;for(const x of ids)w.evidence.frameDemand(x.captureId);
 expect(w.evidence.captures()).toHaveLength(0);expect(holds.size).toBe(0);
});
