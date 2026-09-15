import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROMPT_NAMES = ['discovery','lead','builder','verifier','critic','healer','developer','plan-protocol','transport'] as const;
export type PromptName = typeof PROMPT_NAMES[number];
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
// Both source execution (src/) and the shipped build (dist/src/) read the same
// editable repository files. Resolution is independent of the target's cwd.
export const PROMPTS_DIRECTORY = path.resolve(moduleDirectory, path.basename(path.dirname(moduleDirectory)) === 'dist' ? '../../prompts' : '../prompts');

export function readPromptFile(name: PromptName, directory = PROMPTS_DIRECTORY): string {
  if (!PROMPT_NAMES.includes(name)) throw new Error(`PROMPT_UNKNOWN: ${name}`);
  const file = path.join(directory, `${name}.md`);
  let text: string;
  try {
    if (statSync(file).size > 262144) throw new Error(`PROMPT_TOO_LARGE: ${file}`);
    text = readFileSync(file,'utf8').trim();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PROMPT_TOO_LARGE:')) throw error;
    throw new Error(`PROMPT_UNREADABLE: ${file}`);
  }
  if (!text) throw new Error(`PROMPT_EMPTY: ${file}`);
  return text;
}

export function loadPrompt(name: PromptName, directory = PROMPTS_DIRECTORY): string {
  const text = readPromptFile(name,directory);
  // Only this include is expanded; API capture syntax such as ${runId} is literal.
  return text.replace(/\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g, (_match, include: string) => {
    if (include !== 'plan_protocol' || !['builder','healer'].includes(name)) throw new Error(`PROMPT_INCLUDE_INVALID: ${name}: ${include}`);
    const shared = readPromptFile('plan-protocol',directory);
    if (/\{\{[a-zA-Z][a-zA-Z0-9_-]*\}\}/.test(shared)) throw new Error('PROMPT_INCLUDE_INVALID: nested includes are unsupported');
    return shared;
  });
}
