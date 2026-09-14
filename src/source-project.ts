import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GauntletConfig } from './types.js';

const execute = promisify(execFile);
const docker = async (args: string[]) => (await execute('docker', args, { timeout: 15_000, maxBuffer: 100_000 })).stdout.trim();

export async function discoverSourceProject(baseUrl: string, requested: string): Promise<NonNullable<GauntletConfig['sourceRepair']>> {
  const target = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('SOURCE_AUTO_LOCAL_ONLY: configure sourceRepair explicitly for a remote service');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const ids = (await docker(['ps', '--filter', `publish=${port}`, '--format', '{{.ID}}'])).split('\n').filter(Boolean);
  const matches: Array<{ root: string; compose: string; service: string }> = [];
  for (const id of ids) {
    const meta = JSON.parse(await docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}'])) as Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
    if (!Object.values(meta).some(bindings => bindings?.some(b => b.HostPort === port && ['127.0.0.1', '::1'].includes(b.HostIp)))) continue;
    const labels = JSON.parse(await docker(['inspect', id, '--format', '{{json .Config.Labels}}'])) as Record<string, string>;
    const rootPath = labels['com.docker.compose.project.working_dir'];
    const compose = labels['com.docker.compose.project.config_files'];
    const service = labels['com.docker.compose.service'];
    if (!rootPath || !compose || compose.includes(',') || !service || !/^[a-zA-Z0-9_-]+$/.test(service)) continue;
    const root = await realpath(rootPath);
    if (requested !== 'auto' && root !== await realpath(requested)) continue;
    const file = await realpath(compose);
    if (!file.startsWith(root + path.sep)) continue;
    matches.push({ root, compose: file, service });
  }
  if (matches.length !== 1) throw new Error('SOURCE_AUTO_AMBIGUOUS: could not identify one loopback Compose service; configure sourceRepair.root, include, verifyCommand and restartCommand');
  const match = matches[0]!;
  // Supported adapter: a Python app in a Compose service. Other application
  // layouts use the same sourceRepair interface with owner-configured commands.
  await access(path.join(match.root, 'pyproject.toml'));
  await access(path.join(match.root, 'app'));
  const fixtureModels = await readFile(path.join(match.root, 'app/db/models.py'), 'utf8').catch(() => '');
  const sourceOnlyLab = ['class User(', 'class MenuItem(', 'class Order(', 'class DiscountCoupon(', 'reset_password_code_expiry_date'].every(marker => fixtureModels.includes(marker));
  return { root: match.root, include: ['app'], verifyCommand: ['python3', '-m', 'compileall', '-q', 'app'],
    restartCommand: sourceOnlyLab
      ? [process.execPath, fileURLToPath(new URL('./local-source-restart.js', import.meta.url)), match.root, match.compose, match.service]
      : ['docker', 'compose', '-f', match.compose, 'up', '--build', '--no-deps', '-d', '--wait', match.service],
    maxAttempts: 4, commandTimeoutMs: 300_000 };
}

export async function discoverFixtures(repair: NonNullable<GauntletConfig['sourceRepair']>, baseUrl?: string): Promise<GauntletConfig['fixtures']> {
  const models = await readFile(path.join(repair.root, 'app/db/models.py'), 'utf8').catch(() => '');
  if (!['class User(', 'class MenuItem(', 'class Order(', 'class DiscountCoupon(', 'reset_password_code_expiry_date'].every(marker => models.includes(marker))) return undefined;
  const restart = repair.restartCommand;
  let compose: string; let service: string;
  if (restart[1] && path.basename(restart[1]) === 'local-source-restart.js' && restart.length === 5) {
    compose=restart[3]!;service=restart[4]!;
  } else {
    const fileIndex = restart.indexOf('-f');
    if (restart[0] !== 'docker' || fileIndex < 0) return undefined;
    compose=restart[fileIndex+1]!;service=restart.at(-1)!;
  }
  const id=await docker(['compose','-f',compose,'ps','-q',service]);
  const ports=JSON.parse(await docker(['inspect',id,'--format','{{json .NetworkSettings.Ports}}'])) as Record<string,Array<{HostIp:string;HostPort:string}>|null>;
  const hostPort=baseUrl ? new URL(baseUrl).port || '80' : undefined;
  const candidates=Object.entries(ports).filter(([key,bindings])=>/^\d+\/tcp$/.test(key)&&bindings?.some(b=>['127.0.0.1','::1'].includes(b.HostIp)&&(!hostPort||b.HostPort===hostPort)));
  if(candidates.length!==1)throw new Error('FIXTURE_API_PORT_AMBIGUOUS: configure fixtures.apiOrigin for the API inside its container');
  return {adapter:'dvra',apiOrigin:`http://127.0.0.1:${candidates[0]![0].split('/')[0]}`,command:['docker','compose','-f',compose,'exec','-T',service,'python','-c']};
}
