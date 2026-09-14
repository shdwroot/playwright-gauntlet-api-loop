// Response paths are data, never evaluated JavaScript. JSON Pointer supports
// dictionary keys such as OpenAPI's /menu/{id} and keys containing literal dots.
export function validResponsePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 2000 && !/[\u0000-\u001f]/.test(path)
    && (/^\$(?:\.[a-zA-Z0-9_~\/{}-]+)*$/.test(path) || path.startsWith('/') && !/~(?![01])/.test(path));
}

export function responsePathParts(path: string): string[] {
  if (!validResponsePath(path)) throw new Error('RESPONSE_PATH_INVALID: use $, $.field, or a JSON Pointer such as /paths/~1menu/get');
  return path === '$' ? [] : path.startsWith('/') ? path.slice(1).split('/').map(p=>p.replaceAll('~1','/').replaceAll('~0','~')) : path.slice(2).split('.');
}

export function responsePathValue(value: unknown, path: string): unknown {
  return responsePathParts(path).reduce<unknown>((current,key)=>current && typeof current === 'object' && Object.hasOwn(current,key) ? (current as Record<string,unknown>)[key] : undefined,value);
}
