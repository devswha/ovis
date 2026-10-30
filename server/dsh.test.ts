import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, open, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { completeDshFrames, dshConversation, dshToolOutput, projectDsh, resolveDshTranscript } from "./dsh.ts";
import { ConversationNotStarted, ConversationUnavailable, HistoryChanged } from "./conversation-shared.ts";
const id = "12345678-1234-1234-1234-123456789abc";
const header = {type:"session",version:4,id,delegationDepth:0};
const event = (type: string, data: unknown, seq: number) => ({type,data,seq,time:1700000000000+seq});
const message = (text: string) => ({role:"user",source:{kind:"user"},content:[{type:"text",text}]});
const log = (...rows: unknown[]) => [header,...rows].map(r=>JSON.stringify(r)).join("\n")+"\n";
async function fixture(run: (path:string)=>Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),"ovis-dsh-")); const dir=join(root,"sessions",id); await mkdir(dir,{recursive:true});
 const previous=process.env.DSH_HOME;process.env.DSH_HOME=root;
 try {await run(join(dir,"session.v4.jsonl.zstd"));} finally {if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(root,{recursive:true,force:true});}
}
const linuxTest = process.platform === "linux" ? test : test.skip;
describe("native dsh conversation",()=>{
 linuxTest("shows an unwritten new process as empty but does not guess a resumed session",async()=>{
 await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:["node","/bin/dsh","--profile","tui"]}]})).rejects.toBeInstanceOf(ConversationNotStarted);
 try {await resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:["node","/bin/dsh","--resume","missing"]}]});throw Error("unexpected binding");}catch(error){expect(error).toBeInstanceOf(ConversationUnavailable);expect(error).not.toBeInstanceOf(ConversationNotStarted);}
 });
 test("shows human messages, reasoning and tools without runtime instructions",()=>{
 const p=projectDsh(log(event("user/message",message("hello"),0),event("user/message",{...message("hidden"),source:{kind:"agent-instructions"}},1),event("assistant/message",{message:{role:"assistant",content:[{type:"reasoning",text:"reason"},{type:"text",text:"answer"},{type:"tool-call",id:"t"}]}},2),event("tool/call",{callId:"t",name:"shell",arguments:"{}"},3),event("tool/result",{message:{toolCallId:"t",content:[{type:"text",text:"done"}]}},4),event("turn/end",{reason:{kind:"completed"}},5)),"inode",id);
 expect(p.turns).toHaveLength(2);expect(JSON.stringify(p.turns)).not.toContain("hidden");expect(p.turns[1]!.parts.map(p=>p.kind)).toEqual(["thinking","text","tool"]);
 expect(p.turns[1]!.parts[2]).toMatchObject({state:"ok",output:"done"});
 });
 test("rejects unsupported versions, wrong sessions, and missing event sequences",()=>{
 expect(()=>projectDsh(JSON.stringify({...header,version:5})+"\n","x")).toThrow(ConversationUnavailable);
 expect(()=>projectDsh(log(),"x","other")).toThrow(ConversationUnavailable);
 expect(()=>projectDsh(log(event("user/message",message("x"),1)),"x")).toThrow(ConversationUnavailable);
 });
 test("rejects malformed event and content values with the terminal fallback",()=>{
 expect(()=>projectDsh(log(null),"x")).toThrow(ConversationUnavailable);
 expect(()=>projectDsh(log(event("user/message",{...message("x"),content:[null]},0)),"x")).toThrow(ConversationUnavailable);
 });
 test("reads concatenated compressed frames and ignores an incomplete final append",async()=>fixture(async path=>{
 const first=Bun.zstdCompressSync(log(event("user/message",message("hello"),0)));
 const second=Bun.zstdCompressSync(JSON.stringify(event("assistant/message",{message:{role:"assistant",content:[{type:"text",text:"answer"}]}},1))+"\n");
 await writeFile(path,Buffer.concat([first,second,second.subarray(0,7)]));
 expect(completeDshFrames(Buffer.concat([first,second,second.subarray(0,7)]))).toBe(first.length+second.length);
 expect((await dshConversation(path)).turns).toHaveLength(2);
 }));
 test("rejects corrupt frames and oversized decompressed logs",async()=>fixture(async path=>{
 expect(()=>completeDshFrames(Buffer.from("not a frame"))).toThrow(ConversationUnavailable);
 await writeFile(path,Bun.zstdCompressSync("x".repeat(16*1024*1024+1)));
 await expect(dshConversation(path)).rejects.toBeInstanceOf(ConversationUnavailable);
 }));
 test("pages history and rejects a cursor after an earlier message changes",async()=>fixture(async path=>{
 const rows=Array.from({length:60},(_,i)=>event("user/message",message(String(i)),i));
 await writeFile(path,Bun.zstdCompressSync(log(...rows)));const page=await dshConversation(path);
 expect(page.turns).toHaveLength(50);expect(page.cursor).not.toBeNull();expect((await dshConversation(path,{before:page.cursor!})).turns).toHaveLength(10);
 rows[0]=event("user/message",message("changed"),0);await writeFile(path,Bun.zstdCompressSync(log(...rows)));
 await expect(dshConversation(path,{before:page.cursor!})).rejects.toBeInstanceOf(HistoryChanged);
 }));
 test("uses the terminal fallback when the bound log disappears",async()=>fixture(async path=>{
 await expect(dshConversation(path)).rejects.toBeInstanceOf(ConversationUnavailable);
 }));
 test("reads plain logs and waits for an unfinished JSONL line",async()=>fixture(async compressed=>{
 const path=compressed.replace(".zstd","");
 await writeFile(path,log(event("user/message",message("hello"),0))+"{unfinished");
 expect((await dshConversation(path)).turns).toHaveLength(1);
 }));
 test("keeps prior human turns across compaction and marks failed turns",()=>{
 const p=projectDsh(log(event("user/message",message("original"),0),event("user/message",{...message("summary"),source:{kind:"compact-checkpoint"}},1),event("assistant/message",{message:{role:"assistant",content:[{type:"text",text:"partial"}]}},2),event("turn/end",{reason:{kind:"cancelled"}},3)),"inode");
 expect(p.turns[0]!.role).toBe("user");expect(p.turns[1]!.parts[0]!.kind).toBe("compact");expect(p.turns[1]!.parts.at(-1)).toMatchObject({kind:"notice",text:"Turn ended: cancelled"});
 });
 linuxTest("rejects two held session locks instead of choosing one",async()=>fixture(async first=>{
 const second=join(dirname(dirname(first)),"abcdefab-1234-1234-1234-123456789abc","session.v4.jsonl.zstd");await mkdir(dirname(second));
 await writeFile(first,Bun.zstdCompressSync(log()));await writeFile(second,Bun.zstdCompressSync(log()));
 const locks=await Promise.all([open(join(first,"..","session.lock"),"w"),open(join(second,"..","session.lock"),"w")]);
 try {await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:["/bin/dsh"]}]})).rejects.toBeInstanceOf(ConversationUnavailable);} finally {await Promise.all(locks.map(lock=>lock.close()));}
 }));
 for(const compressed of [false,true])linuxTest(`rejects a held ${compressed?"compressed":"plain"} log outside the sessions root`,async()=>fixture(async inside=>{
 const outside=join(dirname(dirname(dirname(inside))),id);await mkdir(outside);
 const path=join(outside,compressed?"session.v4.jsonl.zstd":"session.v4.jsonl");
 await writeFile(path,compressed?Bun.zstdCompressSync(log()):log());
 const lock=await open(join(outside,"session.lock"),"w");
 try {await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:["/bin/dsh"]}]})).rejects.toBeInstanceOf(ConversationUnavailable);}finally{await lock.close();}
 }));
 linuxTest("rejects a log symlink escaping the sessions root",async()=>fixture(async path=>{
 const outside=join(dirname(dirname(dirname(path))),"outside.jsonl.zstd");await writeFile(outside,Bun.zstdCompressSync(log()));
 await symlink(outside,path);const lock=await open(join(dirname(path),"session.lock"),"w");
 try {await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:["/bin/dsh"]}]})).rejects.toBeInstanceOf(ConversationUnavailable);}finally{await lock.close();}
 }));
 test("fetches long tool output by opaque reference",async()=>fixture(async path=>{
 await writeFile(path,Bun.zstdCompressSync(log(event("tool/call",{callId:"a",name:"shell",arguments:"{}"},0),event("tool/result",{message:{toolCallId:"a",content:[{type:"text",text:"x".repeat(5000)}]}},1))));
 const part=(await dshConversation(path)).turns[0]!.parts[0]!;expect(part.kind).toBe("tool");if(part.kind!=="tool")throw Error();expect(await dshToolOutput(path,part.output_ref!)).toHaveLength(5000);
 }));
 linuxTest("binds only an exact held lock",async()=>fixture(async path=>{
 await writeFile(path,Bun.zstdCompressSync(log()));const lock=await open(join(path,"..","session.lock"),"w");
 const info={foreground_processes:[{pid:process.pid,argv:["node","/bin/dsh"]}]};
 try {expect(await resolveDshTranscript(info)).toBe(path);expect((await dshConversation(await resolveDshTranscript(info))).turns).toHaveLength(0);await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:["unrelated"]}]})).rejects.toBeInstanceOf(ConversationUnavailable);}finally{await lock.close();}
 await expect(resolveDshTranscript(info)).rejects.toBeInstanceOf(ConversationUnavailable);
 }));
});
