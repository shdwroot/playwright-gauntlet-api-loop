import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GauntletConfig, TestPlan } from './types.js';
import { DVRA_FIXTURE } from './dvra-fixture.js';
import { redactAgentData } from './agent-redaction.js';

export const FIXTURE_ACTORS = ['customerA','customerB','employee','chef','paginationCustomer','expiredCustomer'];
export const FIXTURE_BINDINGS = ['fixturePassword','fixtureResetCode','fixtureExpiredResetCode','fixtureMenuId','fixtureUnusedMenuId','fixtureOrderId','fixtureCouponId','tamperedSubjectToken','paginationOrderCount','fixtureImageUrl','fixtureForbiddenImageUrl','fixtureImageBase64',
  ...FIXTURE_ACTORS.flatMap(actor => ['Id','Username','Phone','Token'].map(field => actor + field))];

export function fixtureObservationType(path: string): 'number' | 'boolean' | 'string' | undefined {
  if (['$.imageRequests','$.sentinelRequests'].includes(path)) return 'number';
  const match = /^\$\.actors\.([^.]+)\.([^.]+)$/.exec(path);
  if (!match || !FIXTURE_ACTORS.includes(match[1]!)) return undefined;
  if (['id','orders','orderItems','coupons','usedCoupons','resetExpiresInSeconds'].includes(match[2]!)) return 'number';
  if (['exists','credentialUnchanged','resetInitiated','resetFormatValid'].includes(match[2]!)) return 'boolean';
  if (match[2] === 'role') return 'string';
  return undefined;
}

export function fixtureTokenActors(unit: unknown): string[] {
  const serialized = JSON.stringify(unit);
  return FIXTURE_ACTORS.filter(actor => serialized.includes(`\${${actor}Token}`) || actor === 'customerA' && serialized.includes('${tamperedSubjectToken}'));
}

export const FIXTURE_OBSERVATION_GUIDE = 'Assertions with target:"fixture" inspect real namespace-scoped database state immediately after that HTTP request. Paths: $.actors.<actor>.exists, .id, .role, .credentialUnchanged (password still authenticates), .orders, .orderItems, .coupons, .usedCoupons, .resetInitiated, .resetFormatValid (four digits), .resetExpiresInSeconds. Actor names match credential bindings. Initial Customer A: one order/item, one unused 20-percent coupon, valid reset code; Customer B: no orders/coupons/reset initiation. paginationCustomer has 101 orders. expiredCustomer has an already-expired reset code (${fixtureExpiredResetCode}); no clock mocking. A fixture observation after reset initiation refreshes ${fixtureResetCode} privately for following workflow steps without exposing the code to the model or report. Use these observations to prove rollback/no side effects, credential preservation, reset-code format/expiry and coupon counts. Controlled PNG: ${fixtureImageUrl}, expected bytes encoded as ${fixtureImageBase64}; forbidden internal sentinel: ${fixtureForbiddenImageUrl}. Assert $.imageRequests and $.sentinelRequests with target:"fixture" to prove fetch or non-fetch. The local source deployment configures IMAGE_FETCH_ALLOWED_ORIGINS for the permitted origin http://127.0.0.1:9083; port 9084 remains forbidden. These are loopback servers inside the API container, never real third-party or metadata services. They do not prove global SQL statement counts. For concurrency, use a parallel workflow group and assert the final fixture state in a following sequential step.';

export async function fixtureAction(config: NonNullable<GauntletConfig['fixtures']>, action: 'prepare' | 'cleanup' | 'observe', namespace: string, actors = FIXTURE_ACTORS): Promise<Record<string, unknown>> {
  const result = await promisify(execFile)(config.command[0]!, [...config.command.slice(1), DVRA_FIXTURE, action, namespace, config.apiOrigin ?? 'http://127.0.0.1:8091', JSON.stringify(actors)], { timeout: 30_000, maxBuffer: 100_000 }).catch((error: {code?:string|number;stderr?:string})=>{
    const diagnostic=(error.stderr ?? '').split('\n').find(line=>/^[A-Za-z_.]*(?:Error|Exception):/.test(line))?.slice(0,300) ?? 'Fixture process failed; inspect the configured adapter and API availability';
    throw new Error(`FIXTURE_${action.toUpperCase()}_FAILED (${error.code ?? 'process'}): ${redactAgentData(diagnostic)}`);
  });
  const value: unknown = JSON.parse(result.stdout.trim());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FIXTURE_OUTPUT_INVALID');
  return value as Record<string, unknown>;
}

export function bindFixtureDefaults(plan: TestPlan, config: GauntletConfig): TestPlan {
  if (!config.fixtures || config.fixtures.adapter !== 'dvra') return plan;
  const result = structuredClone(plan);
  result.fixtureAuthentication = true;
  for (const c of result.cases) {
    if (c.authoredBy === 'agent') continue;
    const staff = c.path.startsWith('/menu') && c.method !== 'GET' || c.path === '/users/update_role';
    const actor = c.path.startsWith('/admin/') ? 'chef' : staff ? 'employee' : 'customerA';
    if (c.useAuth) c.headers.authorization = `Bearer \${${actor}Token}`;
    if (c.kind !== 'not-found' && c.kind !== 'validation') {
      if ('item_id' in c.pathParams) c.pathParams.item_id = c.method === 'DELETE' ? '${fixtureUnusedMenuId}' : '${fixtureMenuId}';
      if ('order_id' in c.pathParams) c.pathParams.order_id = '${fixtureOrderId}';
    }
    if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) continue;
    const body = c.body as Record<string, unknown>;
    if ('username' in body) body.username = c.path === '/register' ? '${runId}-registered' : c.path === '/users/update_role' ? '${customerBUsername}' : '${customerAUsername}';
    if ('password' in body) body.password = '${fixturePassword}';
    if ('new_password' in body) body.new_password = 'gauntlet-${runId}-new!';
    if ('reset_password_code' in body) body.reset_password_code = '${fixtureResetCode}';
    if ('phone_number' in body) body.phone_number = c.path === '/register' ? '${runId}-phone' : '${customerAPhone}';
    if (c.path.startsWith('/menu') && 'name' in body) body.name = '${runId}-created-menu';
    if (c.path.startsWith('/menu') && 'image_url' in body && c.kind !== 'validation') body.image_url = '${fixtureImageUrl}';
    if (c.path === '/users/update_role' && 'role' in body && c.kind !== 'validation') body.role = 'Employee';
    if (c.path === '/orders' && 'coupon_id' in body && c.kind !== 'validation') body.coupon_id = '${fixtureCouponId}';
    if (Array.isArray(body.items)) for (const item of body.items) if (item && typeof item === 'object' && 'menu_item_id' in item) item.menu_item_id = '${fixtureMenuId}';
  }
  return result;
}
