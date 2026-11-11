/**
 * Exports the hand-authored OpenAPI 3.1 document to a standalone JSON file.
 * Usage: npm run openapi:export [output]   (default docs/openapi.generated.json)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openapiDocument } from '../src/openapi/document';

const output = resolve(process.argv[2] ?? 'docs/openapi.generated.json');

async function main(): Promise<void> {
  const paths = Object.keys((openapiDocument as { paths?: Record<string, unknown> }).paths ?? {});
  if (paths.length < 20) {
    throw new Error(`OpenAPI document looks incomplete: only ${paths.length} paths found.`);
  }

  await mkdir(dirname(output), { recursive: true });
  const serialized = `${JSON.stringify(openapiDocument, null, 2)}\n`;
  await writeFile(output, serialized, 'utf8');

  const methods = paths.reduce(
    (count, path) =>
      count + Object.keys((openapiDocument.paths as Record<string, Record<string, unknown>>)[path] ?? {}).length,
    0,
  );
  console.log(`Exported ${output}: ${paths.length} paths, ${methods} operations.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
