import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fetchAgentResponse} from '../../src/provider-http.js';

test('provider transport retries temporary throttling but stops quota exhaustion without exposing response text',async()=>{
  let mode='recover';let calls=0;
  const server=createServer((_req,res)=>{
    calls++;
    if(mode==='recover'&&calls===2){res.writeHead(200);res.end('{}');return;}
    res.writeHead(mode==='server-error'?503:429,{'content-type':'application/json','retry-after':mode==='long'?'120':'0'});
    res.end(JSON.stringify({error:{code:mode==='quota'?'credit_balance_exhausted':'rate_limit_exceeded',message:'PRIVATE_PROVIDER_TEXT'}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const call=()=>fetchAgentResponse(url,{method:'POST',body:'{}'},3000,'builder');
  try{
    const response=await call();await response.text();assert.equal(calls,2);
    for(const [next,count,code] of [['quota',1,'AGENT_PROVIDER_QUOTA_EXHAUSTED'],['throttle',3,'AGENT_PROVIDER_RATE_LIMITED'],['long',1,'AGENT_PROVIDER_RATE_LIMITED'],['server-error',1,'AGENT_PROVIDER_FAILED']] as const){
      mode=next;calls=0;
      await assert.rejects(call(),(error:Error)=>{assert.match(error.message,new RegExp(code));assert.doesNotMatch(error.message,/PRIVATE_PROVIDER_TEXT/);return true;});
      assert.equal(calls,count);
    }
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
