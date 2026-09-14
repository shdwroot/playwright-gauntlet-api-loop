import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './utils.js';

// Source-only Python deployment reuses the installed local image dependencies.
// No registry login, dependency download, container filesystem patch or push.
export async function restartLocalSource(root: string, compose: string, service: string): Promise<void> {
  root = await realpath(root); compose = await realpath(compose);
  if (!compose.startsWith(root + path.sep) || !/^[a-zA-Z0-9_-]+$/.test(service)) throw new Error('LOCAL_RESTART_SCOPE_INVALID');
  const exec = promisify(execFile);
  const normal = async (args: string[]) => (await exec('docker', args, {timeout:15_000,maxBuffer:100_000})).stdout.trim();
  const ids = (await normal(['compose','-f',compose,'ps','-q',service])).split('\n').filter(Boolean);
  if (ids.length !== 1) throw new Error('LOCAL_RESTART_CONTAINER_AMBIGUOUS');
  const id = ids[0]!;
  const workdir = await normal(['inspect',id,'--format','{{.Config.WorkingDir}}']);
  if (workdir !== '/app') throw new Error('LOCAL_RESTART_LAYOUT_UNSUPPORTED');
  const image = await normal(['inspect',id,'--format','{{.Config.Image}}']);
  const imageId = await normal(['inspect',id,'--format','{{.Image}}']);
  const host = process.env.DOCKER_HOST ?? await normal(['context','inspect','--format','{{.Endpoints.docker.Host}}']);
  if (!host.startsWith('unix://')) throw new Error('LOCAL_RESTART_LOCAL_DOCKER_ONLY');
  const state = path.join(root,'.gauntlet','source-restart',sha256(service).slice(0,12));
  const dockerConfig = path.join(state,'docker-config');
  await mkdir(dockerConfig,{recursive:true,mode:0o700});
  await writeFile(path.join(dockerConfig,'config.json'),JSON.stringify({cliPluginsExtraDirs:[path.join(homedir(),'.docker','cli-plugins')]}),{mode:0o600});
  const prefix = ['--config',dockerConfig,'--host',host];
  const run = async (args:string[]) => {
    const result = await exec('docker',[...prefix,...args],{timeout:240_000,maxBuffer:200_000,env:{...process.env,DOCKER_BUILDKIT:'0'}});
    return result.stdout.trim();
  };
  const base = `gauntlet-source-base:${sha256(root + service).slice(0,16)}`;
  await run(['image','tag',imageId,base]);
  const dockerfile = path.join(state,'Dockerfile');
  await writeFile(dockerfile,`FROM ${base}\nENV IMAGE_FETCH_ALLOWED_ORIGINS=http://127.0.0.1:9083\nCOPY . /app\n`,{mode:0o600});
  console.error('[source-restart] Building source layer from the existing local image');
  await run(['build','--pull=false','--network=none','-f',dockerfile,'-t',image,path.join(root,'app')]);
  console.error('[source-restart] Recreating the Compose service with the updated image');
  await run(['compose','-f',compose,'up','--no-build','--pull','never','--no-deps','-d','--wait',service]);
  const next = (await normal(['compose','-f',compose,'ps','-q',service])).trim();
  const deployed = await normal(['inspect',next,'--format','{{.Image}}']);
  const expected = await normal(['image','inspect',image,'--format','{{.Id}}']);
  if (deployed !== expected) throw new Error('LOCAL_RESTART_IMAGE_MISMATCH');
  await writeFile(path.join(state,'latest.json'),JSON.stringify({beforeImage:imageId,afterImage:deployed,service,at:new Date().toISOString(),sourceDockerfile:await readFile(dockerfile,'utf8')},null,2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root,compose,service] = process.argv.slice(2);
  if (!root || !compose || !service) throw new Error('Usage: local-source-restart ROOT COMPOSE SERVICE');
  await restartLocalSource(root,compose,service);
}
