#!/usr/bin/env bun
// @ts-nocheck
// Usage: bun run e2e   or   bun run scripts/e2e.ts [--timeout 120000]

import { mkdtempSync, existsSync, mkdirSync, cpSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const timeoutArg = process.argv.find((a) => a.startsWith("--timeout"));
const timeout = timeoutArg ? Number(timeoutArg.split("=")[1] ?? 120000) : 120000;
const verbose = process.argv.includes("--verbose");

console.log("== omp-vcc E2E runner ==");

const ompDir = mkdtempSync(join(tmpdir(), "omp-vcc-e2e-runner-"));
const configPath = join(ompDir, "config.json");
console.log(`OMP_DIR=${ompDir}`);
console.log(`OMP_VCC_CONFIG_PATH=${configPath}`);

let failures = 0;

async function probeOmp(): Promise<void> {
  try {
    const proc = Bun.spawn(["omp", "--help"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const out = await new Response(proc.stdout).text().catch(() => "");
    const err = await new Response(proc.stderr).text().catch(() => "");
    const help = out + err;
    if (verbose) console.log(help.slice(0, 2000));
    const hasPrint = /--print\b/.test(help);
    const hasExtension = /--extension\b|-e\b/.test(help);
    const hasPlugin = /\bplugin\b/.test(help);
    console.log(`probe omp --help: hasPrint=${hasPrint} hasExtension=${hasExtension} hasPlugin=${hasPlugin}`);
    if (!hasPlugin) console.log("note: omp plugin subcommand not found — isolated plugin link test will be skipped");
  } catch (e) {
    console.log(`probe failed (omp not on PATH?): ${e}`);
  }
}

await probeOmp();

// Try plugin link in isolated dir (best effort, skip if omp missing)
try {
  const linkProc = Bun.spawn(["omp", "plugin", "link", process.cwd()], {
    env: { ...process.env, OMP_DIR: ompDir, PI_CODING_AGENT_DIR: ompDir, OMP_VCC_CONFIG_PATH: configPath, PI_VCC_CONFIG_PATH: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  await linkProc.exited;
  const code = linkProc.exitCode ?? 0;
  if (code === 0) {
    console.log("omp plugin link ok (isolated)");
    const doctor = Bun.spawn(["omp", "plugin", "doctor"], {
      env: { ...process.env, OMP_DIR: ompDir, PI_CODING_AGENT_DIR: ompDir, OMP_VCC_CONFIG_PATH: configPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    await doctor.exited;
    const out = await new Response(doctor.stdout).text().catch(() => "");
    console.log(out.slice(0, 1500));
  } else {
    const err = await new Response(linkProc.stderr).text().catch(() => "");
    console.log(`omp plugin link skipped or failed (code ${code}): ${err.slice(0, 500)}`);
  }
} catch (e) {
  console.log(`omp plugin link probe skipped: ${e}`);
}

console.log(`\n== running bun test tests/e2e --timeout ${timeout} ==`);
const env = {
  ...process.env,
  OMP_DIR: ompDir,
  PI_CODING_AGENT_DIR: ompDir,
  OMP_VCC_CONFIG_PATH: configPath,
  PI_VCC_CONFIG_PATH: configPath,
};
const testProc = Bun.spawn(["bun", "test", "tests/e2e", "--timeout", String(timeout)], {
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
// Stream
const outReader = testProc.stdout.getReader();
const errReader = testProc.stderr.getReader();
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, store: string[], isErr: boolean) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      store.push(text);
      if (isErr) process.stderr.write(text);
      else process.stdout.write(text);
    }
  } catch {}
}
await Promise.all([drain(outReader as any, stdoutChunks, false), drain(errReader as any, stderrChunks, true)]);
const exitCode = await testProc.exited;

console.log(`\n== bun test exit code: ${exitCode} ==`);

// collect debug artifacts
const artifactsDir = join(process.cwd(), "artifacts", "e2e-debug");
try {
  mkdirSync(artifactsDir, { recursive: true });
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) {
    if (existsSync(p)) {
      const dest = join(artifactsDir, p.split("/").pop()!);
      cpSync(p, dest);
      console.log(`artifact collected: ${p} -> ${dest}`);
    }
  }
  if (existsSync(configPath)) {
    cpSync(configPath, join(artifactsDir, "isolated-config.json"));
  }
} catch (e) {
  console.log(`artifact collection warning: ${e}`);
}

// cleanup isolated dir (keep artifacts)
try { rmSync(ompDir, { recursive: true, force: true }); } catch {}
console.log(`isolated OMP_DIR removed: ${ompDir}`);

if (exitCode !== 0) {
  console.log("\nE2E FAILED");
  process.exit(exitCode ?? 1);
} else {
  console.log("\nAll E2E checks passed.");
}
