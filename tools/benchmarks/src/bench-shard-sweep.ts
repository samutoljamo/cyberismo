/**
 * Symbol-table shard sweep — measures how clingo's CLINGO_MAP_NUM_SHARDS
 * compile-time setting affects concurrent solve throughput.
 *
 * The binary under test is whatever is currently built into
 * @cyberismo/node-clingo; this script only measures. The caller rebuilds
 * node-clingo with a different CLINGO_MAP_NUM_SHARDS between invocations and
 * passes a distinct <label> each time. Results accumulate into a single JSON
 * array so the whole sweep lands in one file.
 *
 * Usage: tsx src/bench-shard-sweep.ts <fixtures-dir> <output-json> <label>
 */
import { CommandManager } from '@cyberismo/data-handler';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { listProjects, loadFixture } from './fixture-loader.js';

const fixturesDir = process.argv[2];
const outputPath = process.argv[3];
const label = process.argv[4];

if (!fixturesDir || !outputPath || !label) {
  console.error(
    'Usage: tsx src/bench-shard-sweep.ts <fixtures-dir> <output-json> <label>',
  );
  process.exit(1);
}

const PROJECT = 'cyberismo-docs';
const SCALE = 5000;
const WARMUP_RUNS = 3; // sequential warm-up solves
const BATCHES = 5; // Promise.all batches measured
const CONCURRENCY = 64; // solves per batch, and sequential solve count

interface SweepEntry {
  label: string;
  batchMs: number[];
  batchMedianMs: number;
  seqMs: number;
  timestamp: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Reads the existing sweep array, tolerating a missing file. */
async function readExisting(path: string): Promise<SweepEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (raw.trim() === '') return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} exists but does not contain a JSON array`);
  }
  return parsed as SweepEntry[];
}

async function main() {
  const root = resolve(fixturesDir);
  const projects = await listProjects(root);
  if (!projects.includes(PROJECT)) {
    console.error(`Project '${PROJECT}' not found under ${root}.`);
    process.exit(1);
  }

  const bundle = await loadFixture(root, PROJECT, SCALE);
  const commands = await CommandManager.getInstance(bundle.projectDir);
  const clingo = commands.project.calculationEngine.context;
  const treeQuery = bundle.queries.tree;

  let batchMs: number[];
  let seqMs: number;

  try {
    console.error(
      `=== ${label}: project=${PROJECT} scale=${SCALE} cards=${bundle.meta.cardCount} ===`,
    );

    console.error(`  warming up (${WARMUP_RUNS} solves)...`);
    for (let i = 0; i < WARMUP_RUNS; i++) {
      await clingo.solve(treeQuery, ['all'], { cache: false });
    }

    console.error(`  concurrent: ${BATCHES} batches x ${CONCURRENCY} solves...`);
    batchMs = [];
    for (let batch = 1; batch <= BATCHES; batch++) {
      const start = performance.now();
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          clingo.solve(treeQuery, ['all'], { cache: false }),
        ),
      );
      const wallClockMs = performance.now() - start;
      batchMs.push(wallClockMs);
      console.error(
        `    batch ${batch}/${BATCHES}: ${wallClockMs.toFixed(1)}ms`,
      );
    }

    console.error(`  sequential: ${CONCURRENCY} solves...`);
    const seqStart = performance.now();
    for (let i = 0; i < CONCURRENCY; i++) {
      await clingo.solve(treeQuery, ['all'], { cache: false });
    }
    seqMs = performance.now() - seqStart;
    console.error(`    sequential total: ${seqMs.toFixed(1)}ms`);
  } finally {
    commands.project.dispose();
  }

  const entry: SweepEntry = {
    label,
    batchMs,
    batchMedianMs: median(batchMs),
    seqMs,
    timestamp: new Date().toISOString(),
  };

  const outPath = resolve(outputPath);
  await mkdir(dirname(outPath), { recursive: true });
  const entries = await readExisting(outPath);
  entries.push(entry);
  await writeFile(outPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');

  console.error(
    `${label}: batchMedianMs=${entry.batchMedianMs.toFixed(1)} ` +
      `batches=[${batchMs.map((m) => m.toFixed(1)).join(', ')}] ` +
      `seqMs=${seqMs.toFixed(1)} -> ${outPath}`,
  );
}

main().catch((error) => {
  console.error('Shard sweep failed:', error);
  process.exit(1);
});
