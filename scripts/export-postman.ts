/**
 * Generates a Postman v2.1 collection from the OpenAPI 3.1 document.
 *
 * The output is deterministic: paths are emitted in document order, example payloads are derived
 * from the request schemas, and collection-level variables (baseUrl, accessToken, adminConfirmation)
 * are declared with placeholders. Financial mutations carry Idempotency-Key ({{$guid}}) and, for
 * administrative routes, X-Admin-Confirmation ({{adminConfirmation}}) headers.
 *
 * Usage: npm run postman:export [output]   (default postman/NEXUS_BANK.postman_collection.json)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openapiDocument } from '../src/openapi/document';

interface JsonObject {
  [key: string]: unknown;
}

type Schema = JsonObject | null | undefined;

const document = openapiDocument as unknown as {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, JsonObject>>;
  components?: { schemas?: Record<string, JsonObject> };
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options']);
const FINANCIAL_PREFIXES = ['/deposits', '/withdrawals', '/transfers', '/admin/'];

function resolveRef(ref: string): JsonObject | undefined {
  const name = ref.split('/').pop();
  return name ? document.components?.schemas?.[name] : undefined;
}

function exampleFor(schema: Schema, depth = 0): unknown {
  if (!schema || depth > 6) return undefined;

  if (typeof schema.$ref === 'string') return exampleFor(resolveRef(schema.$ref), depth + 1);

  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) return exampleFor(options[0] as Schema, depth + 1);
  }

  const declaredType = Array.isArray(schema.type)
    ? (schema.type as string[]).find((entry) => entry !== 'null')
    : (schema.type as string | undefined);

  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (declaredType) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        const example = exampleFor(value, depth + 1);
        if (example !== undefined) out[key] = example;
      }
      return out;
    }
    case 'array': {
      const item = exampleFor(schema.items as Schema, depth + 1);
      return item === undefined ? [] : [item];
    }
    case 'string': {
      if (schema.format === 'email') return 'alice@nexusbank.test';
      if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      if (typeof schema.pattern === 'string' && schema.pattern.includes('\\d{6}')) return '246810';
      if (typeof schema.maxLength === 'number' && schema.maxLength <= 12) return 'Demo';
      if (schema.description && /pin/i.test(String(schema.description))) return '246810';
      return 'string';
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return false;
    default:
      return typeof declaredType === 'undefined' && schema.properties
        ? exampleFor({ type: 'object', properties: schema.properties }, depth)
        : undefined;
  }
}

function bodyFor(operation: JsonObject): { raw: string; present: boolean } {
  const content = (operation.requestBody as JsonObject | undefined)?.content as JsonObject | undefined;
  const json = content?.['application/json'] as JsonObject | undefined;
  const schema = json?.schema as Schema;
  const example = exampleFor(schema);
  return { raw: JSON.stringify(example ?? {}, null, 2), present: Boolean(schema) };
}

function pathToPostman(path: string): { rawPath: string; pathVars: Array<{ key: string; value: string }> } {
  const pathVars: Array<{ key: string; value: string }> = [];
  const rawPath = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    pathVars.push({ key: name, value: `example-${name}` });
    return `:${name}`;
  });
  return { rawPath, pathVars };
}

function requiresAuth(operation: JsonObject): boolean {
  const security = operation.security;
  if (Array.isArray(security)) return security.length > 0;
  return true; // global security applies unless explicitly disabled
}

const itemsByTag = new Map<string, JsonObject[]>();
for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(method)) continue;

    const tags = Array.isArray(operation.tags) && operation.tags.length > 0 ? (operation.tags as string[]) : ['General'];
    const summary = typeof operation.summary === 'string' ? operation.summary : `${method.toUpperCase()} ${path}`;
    const description = typeof operation.description === 'string' ? operation.description : '';

    const { rawPath, pathVars } = pathToPostman(path);
    const { raw: bodyRaw, present } = bodyFor(operation);

    const headers: JsonObject[] = [
      ...(present ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ...(requiresAuth(operation) ? [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }] : []),
      ...(FINANCIAL_PREFIXES.some((prefix) => path.startsWith(prefix)) && method !== 'get'
        ? [
            { key: 'Idempotency-Key', value: '{{$guid}}', description: 'Replay-safe key for financial mutations' },
          ]
        : []),
      ...(path.startsWith('/admin/') && method !== 'get'
        ? [{ key: 'X-Admin-Confirmation', value: '{{adminConfirmation}}', description: 'Destructive-action confirmation' }]
        : []),
    ];

    const request: JsonObject = {
      method: method.toUpperCase(),
      header: headers,
      url: {
        raw: `{{baseUrl}}/api/v1${rawPath}`,
        host: ['{{baseUrl}}'],
        path: ['api', 'v1', ...rawPath.split('/').filter(Boolean)],
        ...(pathVars.length > 0 ? { variable: pathVars.map((v) => ({ key: v.key, value: v.value })) } : {}),
      },
      ...(present ? { body: { mode: 'raw', raw: bodyRaw, options: { raw: { language: 'json' } } } } : {}),
      description,
    };

    const entry: JsonObject = { name: `${method.toUpperCase()} ${path} — ${summary}`, request, response: [] };
    for (const tag of tags) {
      const bucket = itemsByTag.get(tag) ?? [];
      bucket.push(entry);
      itemsByTag.set(tag, bucket);
    }
  }
}

const folders = [...itemsByTag.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([tag, items]) => ({ name: tag, item: items }));

const collection = {
  info: {
    name: 'NEXUS BANK — Educational Banking API (simulation)',
    description: [
      'Generated from docs/openapi.generated.json. Educational simulation — not a real bank, no real money moves.',
      '',
      'Quick start:',
      '1. Run the API locally (see README) and the seed: `npx prisma db seed`.',
      '2. `POST /auth/login` with `alice@nexusbank.test` / `NexusDemo#2026` (PIN 246810) and copy `data.accessToken` into the `accessToken` collection variable.',
      '3. The refresh token arrives as a SameSite=Strict HttpOnly cookie scoped to /api/v1/auth; this collection captures both header and cookie flows.',
      '',
      'All financial mutations require an `Idempotency-Key` header. Destructive admin routes additionally require `X-Admin-Confirmation` (user id, wallet id or transfer id, as documented on the endpoint).',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: folders,
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000', type: 'string' },
    { key: 'accessToken', value: '', type: 'string' },
    { key: 'adminConfirmation', value: '', type: 'string', description: 'User id, wallet id or transfer id, depending on the route' },
  ],
};

async function main(): Promise<void> {
  const operationCount = folders.reduce((total, folder) => total + folder.item.length, 0);
  const output = resolve(process.argv[2] ?? 'postman/NEXUS_BANK.postman_collection.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');

  console.log(`Exported ${output}: ${folders.length} folders, ${operationCount} requests.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
