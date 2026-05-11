import { execFile } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface BinaryResult {
  answers: string[];
  wallClockMs: number;
}

/**
 * Runs clingo with the given args. Treats SAT/UNSAT/UNKNOWN exits (10/20/30)
 * as success and returns their stdout. Re-throws any other failure.
 *
 * Note: execFile attaches `.stdout: ''` to *every* error it surfaces, including
 * spawn failures like ENOENT, so a naive `'stdout' in error` check would
 * silently treat "clingo not on PATH" as a successful run with zero answer
 * sets. We therefore differentiate by `.code`: numeric codes are clingo's exit
 * status (success only on 10/20/30), string codes (ENOENT, EACCES, …) mean the
 * process never ran and must be surfaced as an error.
 */
// Node's execFile default stdout buffer is 1 MiB. clingo's answer sets at
// 50 k cards × hundreds of #show'd atoms easily exceed that, which would
// surface as ERR_CHILD_PROCESS_STDIO_MAXBUFFER and the process gets killed
// mid-run. 1 GiB is a generous overshoot — plenty of headroom for the
// largest models we care about, and it stays an honest cap rather than
// allowing unbounded growth.
const CLINGO_MAX_BUFFER = 1024 * 1024 * 1024;

async function runClingo(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('clingo', args, {
      maxBuffer: CLINGO_MAX_BUFFER,
    });
    return result.stdout;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as { code: unknown }).code;
      if (
        (code === 10 || code === 20 || code === 30) &&
        'stdout' in error
      ) {
        return (error as { stdout: string }).stdout;
      }
      if (code === 'ENOENT') {
        throw new Error(
          'clingo binary not found on PATH. Install clingo or run the bench inside an environment that provides it (e.g. `distrobox enter cyberismo -- make bench`).',
        );
      }
    }
    throw error;
  }
}

function parseAnswers(stdout: string): string[] {
  const answers: string[] = [];
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Answer:') && i + 1 < lines.length) {
      answers.push(lines[i + 1]);
    }
  }
  return answers;
}

/**
 * Runs a logic program through the clingo binary. Returns wall-clock
 * time and parsed answer sets.
 */
export async function solveBinary(program: string): Promise<BinaryResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'clingo-bench-'));
  const lpFile = join(tmpDir, 'program.lp');
  await writeFile(lpFile, program);

  const start = performance.now();
  let stdout: string;
  try {
    stdout = await runClingo([lpFile]);
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
  const wallClockMs = performance.now() - start;
  await rm(tmpDir, { recursive: true, force: true });

  return { answers: parseAnswers(stdout), wallClockMs };
}

/**
 * Solves a pre-grounded ASPIF base together with an extra query LP via the
 * clingo binary. The base is read from `aspifPath` directly (no gringo
 * invocation). Returns wall-clock time and parsed answers.
 */
export async function solveAspifWithQuery(
  aspifPath: string,
  queryProgram: string,
): Promise<{ clingoMs: number; answers: string[] }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'clingo-incr-'));
  const queryFile = join(tmpDir, 'query.lp');
  await writeFile(queryFile, queryProgram);

  const start = performance.now();
  let stdout: string;
  try {
    stdout = await runClingo([aspifPath, queryFile]);
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
  const clingoMs = performance.now() - start;
  await rm(tmpDir, { recursive: true, force: true });

  return { clingoMs, answers: parseAnswers(stdout) };
}

