import assert from 'node:assert/strict';
import {test} from 'node:test';
import {responsePathValue,validResponsePath} from '../../src/response-path.js';

test('response paths read OpenAPI dictionary keys without evaluating expressions or inherited properties',()=>{
  const response={paths:{'/register':{post:{summary:'Register'}},'/v1.2/menu/{id}':{put:true}},'a~b':{'[0]':'literal'},items:[{id:7}]};
  assert.equal(responsePathValue(response,'$.paths./register.post.summary'),'Register');
  assert.equal(responsePathValue(response,'/paths/~1v1.2~1menu~1{id}/put'),true);
  assert.equal(responsePathValue(response,'/a~0b/[0]'),'literal');
  assert.equal(responsePathValue(response,'/items/0/id'),7);
  assert.equal(responsePathValue(response,'$.constructor'),undefined);
  assert.equal(responsePathValue(response,'/absent/field'),undefined);
  for(const invalid of ['$.items.map(x=>x)','/bad~escape','$.items[*]']) assert.equal(validResponsePath(invalid),false);
});
