import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,access} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const example=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(example,'../..');
const lab=path.join(root,'.gauntlet/restaurant-example');
const checkout=path.join(lab,'api');
const stateFile=path.join(lab,'lab.json');
const repository='https://github.com/theowni/Damn-Vulnerable-RESTaurant-API-Game.git';
const commit='d32d09972aec7830f5f1d4a5d274cac7aae7eb82';
const [command,...args]=process.argv.slice(2);
const execute=(program,argv,cwd=root,env=process.env)=>new Promise((resolve,reject)=>{
  const child=spawn(program,argv,{cwd,env,stdio:'inherit'});
  child.once('error',reject);
  child.once('exit',(code,signal)=>code===0?resolve():reject(Object.assign(new Error(`${program} exited ${code ?? signal}`),{exitCode:code ?? 1})));
});
const compose=async(args)=>{const {port}=await state();return execute('docker',['compose','--project-directory',checkout,'-f',path.join(checkout,'compose.lab.yml'),...args],checkout,{...process.env,RESTAURANT_PORT:String(port)});};
async function state(){
  let value;try{value=JSON.parse(await readFile(stateFile,'utf8'));}catch{throw new Error('Run npm run restaurant:setup first. No existing application will be adopted automatically.');}
  if(!Number.isInteger(value.port)||value.port<1024||value.port>65535||value.commit!==commit)throw new Error('Invalid restaurant lab manifest');
  return value;
}
async function available(port){
  await new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Loopback port ${port} is occupied. Use restaurant:setup -- --port <free-port>; existing services are left alone.`)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
async function main(){
  if(command==='setup'){
    if(args.length && !(args.length===2&&args[0]==='--port'))throw new Error('Usage: restaurant:setup [-- --port 8091]');
    const port=args.length?Number(args[1]):8091;
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Port must be an integer from 1024 to 65535');
    await execute('docker',['info','--format','{{.ServerVersion}}']);
    await available(port);
    try{await access(checkout);throw new Error('The example checkout already exists. Use restaurant:up to resume it; inspect it before removing or replacing it.');}catch(error){if(error.code!=='ENOENT')throw error;}
    await mkdir(lab,{recursive:true});
    await execute('git',['clone',repository,checkout]);
    await execute('git',['checkout','--detach',commit],checkout);
    for(const file of ['Dockerfile.lab','compose.lab.yml','requirements.lock.txt'])await copyFile(path.join(example,file),path.join(checkout,file));
    await writeFile(path.join(checkout,'.env'),`RESTAURANT_PORT=${port}\n`);
    await writeFile(stateFile,JSON.stringify({repository,commit,port},null,2)+'\n');
    await compose(['up','--build','-d','--wait','--wait-timeout','180']);
    console.log(`Restaurant ready: http://127.0.0.1:${port}/docs\nNext: npm run restaurant:doctor`);
    return;
  }
  if(['up','down','status','logs'].includes(command)){
    if(args.length)throw new Error(`${command} does not take arguments`);
    await state();await compose(command==='up'?['up','-d','--wait','--wait-timeout','180']:command==='down'?['down']:command==='status'?['ps']:['logs','--tail','100','web']);return;
  }
  if(['doctor','discover','generate','run'].includes(command)){
    const {port}=await state();
    if(args.some(a=>['--url','--config','--project-dir'].includes(a)))throw new Error('The example selects its own target/project. Use the generic gauntlet command for other APIs.');
    await execute(process.execPath,[path.join(root,'dist/src/cli.js'),command,'--url',`http://127.0.0.1:${port}/openapi.json`,'--context',path.join(example,'context'),'--project-dir',path.join(lab,'project'),...args],root,{...process.env,RESTAURANT_PORT:String(port)});return;
  }
  throw new Error('Use setup, up, down, status, logs, doctor, discover, generate or run');
}
main().catch(error=>{console.error(error.message);process.exitCode=error.exitCode ?? 1;});
