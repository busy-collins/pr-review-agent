import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

// ============================================================
// Lambda bundler. One esbuild call per handler entry point.
// Output paths mirror the CDK `handler` strings in
// infrastructure/cdk/stacks/lambda-api.stack.ts — keep in sync.
// ============================================================

const entries = [
  'agents/orchestrator/src/index.ts',
  'agents/security/src/index.ts',
  'agents/style/src/index.ts',
  'agents/aggregator/src/index.ts',
  'api/webhook/index.ts',
];

await rm('dist', { recursive: true, force: true });

const results = await Promise.all(
  entries.map((entry) =>
    build({
      entryPoints: [entry],
      outfile: `dist/${entry.replace(/\.ts$/, '.js')}`,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      sourcemap: 'inline',
      loader: { '.json': 'json' },
      logLevel: 'info',
      // aws-sdk v3 ships with the Node 20 Lambda runtime — keeping
      // it external shaves ~3MB per bundle and avoids pinning a
      // version that drifts from the runtime's.
      external: ['@aws-sdk/*'],
    })
  )
);

const failed = results.filter((r) => r.errors.length > 0);
if (failed.length > 0) {
  process.exit(1);
}

console.log(`✓ Bundled ${entries.length} Lambda handlers → dist/`);
