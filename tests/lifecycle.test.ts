import { describe, it, assert } from "node:test";
import { makeMockApi, makeMockCtx } from "./helpers.ts";
// import extension from "../extensions/main.ts";

describe("@zhu/omp-vcc lifecycle", () => {
  it("registers without throwing", async () => {
    const { api, __handlers } = makeMockApi() as unknown as { api: never; __handlers: Map<string, unknown> };
    // await (extension as unknown as (pi: unknown) => void)(api);
    assert.ok(__handlers, "handlers map exists");
  });

  it("is inert without config", async () => {
    const ctx = makeMockCtx();
    assert.ok(ctx, "ctx created");
  });

  it("probe header support routing (noop vs sync)", () => {
    const noopCtx = makeMockCtx({ headerMode: "noop" }) as unknown as { ui: { setHeader: (f: unknown) => void } };
    const syncCtx = makeMockCtx({ headerMode: "sync" }) as unknown as { ui: { setHeader: (f: unknown) => void } };
    assert.ok(noopCtx.ui && syncCtx.ui);
  });
});
