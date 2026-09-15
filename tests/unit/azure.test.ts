import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {azureResponsesUrl} from '../../src/azure.js';
import {createAgentProvider} from '../../src/agents.js';
import {loadConfig} from '../../src/config.js';
import {onboard} from '../../src/onboarding.js';

test('Azure v1 endpoint normalization rejects legacy routes, insecure remote URLs and embedded credentials',()=>{
  for(const suffix of ['', '/', '/openai/v1', '/openai/v1/', '/openai/v1/responses']) assert.equal(azureResponsesUrl(`https://example.openai.azure.com${suffix}`),'https://example.openai.azure.com/openai/v1/responses');
  for(const endpoint of [undefined,'','http://example.com','https://user:secret@example.com','https://example.com/?key=secret','https://example.com/#secret','https://example.com/openai/deployments/chat','not-a-url']) assert.throws(()=>azureResponsesUrl(endpoint),/CONFIG_INVALID/);
});

test('Azure default key, deployment, structured output and provider errors use real HTTP transport',async()=>{
  const saved=process.env.AZURE_OPENAI_API_KEY;process.env.AZURE_OPENAI_API_KEY='test-azure-key';
  let status=200;let count=0;
  const server=createServer(async(req,res)=>{
    count++;let body='';for await(const chunk of req) body+=chunk;
    assert.equal(req.url,'/openai/v1/responses');assert.equal(req.headers['api-key'],'test-azure-key');assert.equal(req.headers.authorization,undefined);
    const payload=JSON.parse(body);assert.equal(payload.model,'my-deployment');assert.equal(payload.text.format.type,'json_schema');assert.equal(payload.text.format.strict,true);
    res.writeHead(status,{'content-type':'application/json'});res.end(status===200?JSON.stringify({output:[{content:[{type:'output_text',text:'{"action":"block","reason":"test response"}'}]}],usage:{input_tokens:10,output_tokens:5}}):'private provider error');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const provider=createAgentProvider({provider:'azure',azureEndpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}`,builderModel:'my-deployment',criticModel:'my-deployment'});
  try{
    const reply=await provider.invoke('lead','my-deployment','test',{});assert.deepEqual(reply.output,{action:'block',reason:'test response'});assert.deepEqual(reply.usage,{inputTokens:10,outputTokens:5});
    status=401;await assert.rejects(provider.invoke('lead','my-deployment','test',{}),/AGENT_PROVIDER_FAILED: lead returned HTTP 401/);assert.equal(count,2);
    delete process.env.AZURE_OPENAI_API_KEY;await assert.rejects(provider.invoke('lead','my-deployment','test',{}),/CREDENTIAL_MISSING: AZURE_OPENAI_API_KEY/);assert.equal(count,2);
  }finally{if(saved===undefined)delete process.env.AZURE_OPENAI_API_KEY;else process.env.AZURE_OPENAI_API_KEY=saved;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('Azure environment onboarding preserves provider and role deployments on refresh and enables live quality gates',async()=>{
  const names=['GAUNTLET_AGENT_PROVIDER','GAUNTLET_AGENT_MODEL','AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_DEPLOYMENT'];
  const saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  const directory=await mkdtemp(path.join(os.tmpdir(),'gauntlet-azure-'));
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({openapi:'3.1.0',info:{title:'Health',version:'1'},paths:{'/health':{get:{operationId:'health',responses:{200:{description:'ok'}}}}}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    process.env.GAUNTLET_AGENT_PROVIDER='azure';delete process.env.GAUNTLET_AGENT_MODEL;process.env.AZURE_OPENAI_DEPLOYMENT='azure-chat';process.env.AZURE_OPENAI_ENDPOINT='https://example.openai.azure.com';
    const options={directory,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/openapi.json`,context:[]};
    const file=await onboard(options);let {config}=await loadConfig(file);
    assert.equal(config.agents.provider,'azure');assert.equal(config.agents.builderModel,'azure-chat');assert.equal(config.agents.verifierModel,'azure-chat');
    assert.equal(config.quality.requireSemanticVerification,true);assert.equal(config.quality.requireIsolationReview,true);
    const raw=JSON.parse(await readFile(file,'utf8'));raw.agents.azureEndpoint=process.env.AZURE_OPENAI_ENDPOINT;raw.agents.verifierModel='azure-review';delete raw.quality.requireSemanticVerification;delete raw.quality.requireIsolationReview;delete raw.quality.minimumScenarioCoverage;await writeFile(file,JSON.stringify(raw));
    for(const name of names)delete process.env[name];
    await onboard(options);({config}=await loadConfig(file));
    assert.equal(config.agents.provider,'azure');assert.equal(config.agents.verifierModel,'azure-review');
    assert.equal(config.quality.requireSemanticVerification,true);assert.equal(config.quality.requireIsolationReview,true);
    const cli=await promisify(execFile)(process.execPath,['dist/src/cli.js','doctor','--url',options.url,'--project-dir',directory,'--agentic','--model','azure-cli']);
    assert.equal(JSON.parse(cli.stdout).ok,true);
    const cliConfig=JSON.parse(await readFile(file,'utf8'));assert.equal(cliConfig.agents.provider,'azure');assert.equal(cliConfig.agents.builderModel,'azure-cli');
    raw.agents.azureEndpoint='';await writeFile(file,JSON.stringify(raw));await assert.rejects(loadConfig(file),/Azure requires/);
  }finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
});
