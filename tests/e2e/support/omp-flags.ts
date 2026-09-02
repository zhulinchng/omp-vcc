// @ts-nocheck
export async function probeFlags(): Promise<{ hasPrint: boolean; hasExtension: boolean; hasPlugin: boolean; helpText: string }> {
  try {
    const proc = Bun.spawn(["omp", "--help"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const out = await new Response(proc.stdout).text().catch(() => "");
    const err = await new Response(proc.stderr).text().catch(() => "");
    const text = out + err;
    return {
      hasPrint: /--print\b|-p\b/.test(text),
      hasExtension: /--extension\b|-e\b/.test(text),
      hasPlugin: /\bplugin\b/.test(text),
      helpText: text,
    };
  } catch {
    return { hasPrint: false, hasExtension: false, hasPlugin: false, helpText: "" };
  }
}
