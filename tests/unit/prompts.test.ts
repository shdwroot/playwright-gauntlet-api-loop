import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,cp,writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {loadPrompt,PROMPTS_DIRECTORY,PROMPT_NAMES,type PromptName} from '../../src/prompts.js';
import {loadConfig} from '../../src/config.js';
import {OpenAIResponsesProvider} from '../../src/agents.js';
import {RunLedger,auditedAgentProvider} from '../../src/evidence.js';
import type {RunResult} from '../../src/types.js';

test('editable prompts reload without a build, preserve capture syntax, and fail closed on invalid files',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'gauntlet-prompts-'));
  try{
    await cp(PROMPTS_DIRECTORY,dir,{recursive:true});
    for(const name of PROMPT_NAMES)assert.ok(loadPrompt(name,dir).length);
    assert.match(loadPrompt('builder',dir),/\$\{runId\}/);
    await writeFile(path.join(dir,'lead.md'),'Manage updated coverage priorities.');
    assert.equal(loadPrompt('lead',dir),'Manage updated coverage priorities.');
    await writeFile(path.join(dir,'plan-protocol.md'),'Shared protocol revision two.');
    assert.match(loadPrompt('builder',dir),/Shared protocol revision two/);assert.match(loadPrompt('healer',dir),/Shared protocol revision two/);
    await writeFile(path.join(dir,'lead.md'),'{{unknown}}');assert.throws(()=>loadPrompt('lead',dir),/PROMPT_INCLUDE_INVALID/);
    await writeFile(path.join(dir,'lead.md'),' ');assert.throws(()=>loadPrompt('lead',dir),/PROMPT_EMPTY/);
    await writeFile(path.join(dir,'lead.md'),'x'.repeat(262145));assert.throws(()=>loadPrompt('lead',dir),/PROMPT_TOO_LARGE/);
    await rm(path.join(dir,'lead.md'));assert.throws(()=>loadPrompt('lead',dir),/PROMPT_UNREADABLE/);
    assert.throws(()=>loadPrompt('../secret' as PromptName,dir),/PROMPT_UNKNOWN/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('compiled runtime finds prompts outside cwd and prompt edits invalidate a running result',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'gauntlet-prompt-revision-'));
  try{
    await mkdir(path.join(dir,'dist'));
    await cp(path.resolve('dist/src'),path.join(dir,'dist/src'),{recursive:true});
    await cp(PROMPTS_DIRECTORY,path.join(dir,'prompts'),{recursive:true});
    await symlink(path.resolve('node_modules'),path.join(dir,'node_modules'),'dir');
    await writeFile(path.join(dir,'package.json'),'{"type":"module"}');
    const maintenance=await import(pathToFileURL(path.join(dir,'dist/src/maintenance.js')).href) as typeof import('../../src/maintenance.js');
    const {config}=await loadConfig('gauntlet.offline.config.json');config.agents.provider='openai';config.discovery.enabled=false;config.projectRoot=dir;config.generatedDir=path.join(dir,'generated');config.artifactsDir=path.join(dir,'runs');
    const first=await maintenance.snapshotContext(config);
    assert.equal(first.files.filter(f=>f.path.startsWith('framework-prompts/')).length,9);
    const result=await maintenance.maintainRun(config,undefined,async()=>{
      await writeFile(path.join(dir,'prompts/lead.md'),'Revised manager instructions.');
      return {runId:'prompt-drift',runDir:path.join(config.artifactsDir,'prompt-drift'),status:'PASSED',iterations:0,finalScore:100,findings:[],events:[],heals:[]} as RunResult;
    });
    assert.equal(result.status,'BLOCKED');assert.ok(result.findings.some(f=>f.code==='CONTEXT_CHANGED_DURING_RUN'));
    const next=await maintenance.snapshotContext(config);assert.notEqual(first.revision,next.revision);
    assert.deepEqual(maintenance.contextChanges(first,next).changed,['framework-prompts/lead.md']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('audit records the assembled instructions sent over HTTP and prompt hashes include system edits',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'gauntlet-prompt-audit-'));
  const seen:string[]=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push(JSON.parse(body).instructions);res.setHeader('content-type','application/json');res.end(JSON.stringify({output_text:'{"action":"block","reason":"test"}'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const key=process.env.GAUNTLET_PROMPT_TEST_KEY;process.env.GAUNTLET_PROMPT_TEST_KEY='test-only';
  try{
    const {config}=await loadConfig('gauntlet.offline.config.json');config.artifactsDir=dir;
    const ledger=new RunLedger('audit',config);await ledger.initialize('contract-hash');
    const provider=auditedAgentProvider(new OpenAIResponsesProvider({...config.agents,provider:'openai',openaiBaseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,apiKeyEnv:'GAUNTLET_PROMPT_TEST_KEY'}),ledger);
    const first=await provider.invoke('lead','test-model',loadPrompt('lead'),{});
    const second=await provider.invoke('lead','test-model','Updated role instructions',{});
    assert.notEqual(first.promptHash,second.promptHash);
    for(let i=0;i<seen.length;i++){
      const input=JSON.parse(await readFile(path.join(dir,`audit/agents/calls/${i+1}-lead-input.json`),'utf8'));
      assert.equal(input.effectiveInstructions,seen[i]);assert.equal(input.transportInstructions,loadPrompt('transport'));
    }
  }finally{if(key===undefined)delete process.env.GAUNTLET_PROMPT_TEST_KEY;else process.env.GAUNTLET_PROMPT_TEST_KEY=key;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
