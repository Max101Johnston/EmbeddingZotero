import { runWithClientDeadline } from "./clientDeadline";
import { expect } from "chai";
import {
  RequestTaskManager,
  SerialTaskQueue,
  TaskError,
  abortableDelay,
} from "../src/modules/requestLifecycle";
import { StreamableMCPServer } from "../src/modules/streamableMCPServer";
import { PDFProcessor } from "../src/modules/pdfProcessor";
import { EmbeddingService } from "../src/modules/semantic/embeddingService";
import { MCPSettingsService } from "../src/modules/mcpSettingsService";
import { runSerializedWrite } from "../src/modules/deferredNotifierCommitter";
import { testMCPIntegration } from "../src/modules/mcpTest";

describe("MCP request lifecycle", () => {
  const originalZotero = (globalThis as any).Zotero;
  const originalToolkit = (globalThis as any).ztoolkit;
  beforeEach(() => {
    (globalThis as any).ztoolkit = { log: () => {} };
    (globalThis as any).Zotero = { Prefs: { get: () => undefined } };
  });
  afterEach(() => {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalToolkit;
  });
  it("dispatches and cancels tool calls without a sandbox-global AbortController", async () => {
    const windowAbortController = globalThis.AbortController;
    const requestedGlobals: string[] = [];
    try {
      (globalThis as any).AbortController = undefined;
      (globalThis as any).ztoolkit.getGlobal = (name: string) => {
        requestedGlobals.push(name);
        return name === "AbortController" ? windowAbortController : undefined;
      };
      const server = new StreamableMCPServer() as any;
      server.callGetLibraries = async () => ({ libraries: [{ libraryID: 1 }] });
      const call = (id: number, name: string) =>
        server.handleMCPRequest(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: {} },
          }),
          "sandbox",
        );
      const response = JSON.parse((await call(1, "get_libraries")).body);
      expect(response.error).to.equal(undefined);
      expect(response.result).to.have.property("content");
      expect(requestedGlobals).to.include("AbortController");
      const unknown = JSON.parse((await call(2, "__unknown_tool__")).body);
      expect(unknown.error.message).to.include("Unknown tool");

      let requestSignal!: AbortSignal;
      server.callGetContent = async (_args: any, signal: AbortSignal) => {
        requestSignal = signal;
        await abortableDelay(5000, signal);
      };
      const pending = server.handleMCPRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_content", arguments: { itemKey: "TEST" } },
        }),
        "sandbox",
      );
      await abortableDelay(0);
      const cancelled = await server.handleMCPRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 3 },
        }),
        "sandbox",
      );
      expect(cancelled.status).to.equal(202);
      expect((await pending).status).to.equal(202);
      expect(requestSignal.aborted).to.equal(true);
      await abortableDelay(0);
      expect(server.getStatus().tasks).to.deep.equal({
        active: 0,
        draining: 0,
        limit: 32,
      });
    } finally {
      (globalThis as any).AbortController = windowAbortController;
    }
  });
  it("checks tool execution through a registered read-only tool in diagnostics", async () => {
    (globalThis as any).Zotero.Libraries = {
      getAll: () => [{ libraryID: 1, name: "My Library", libraryType: "user" }],
    };
    const report = await testMCPIntegration();
    expect(
      report.testResults.tests.filter((test) => test.status === "FAILED"),
    ).to.deep.equal([]);
    expect(
      report.testResults.tests.some(
        (test) => test.testName === "Tool Call - Get Libraries",
      ),
    ).to.equal(true);
  });
  it("aborts on deadline and retains a draining task until its operation settles", async () => {
    const manager = new RequestTaskManager(1);
    let finish!: () => void;
    let signal!: AbortSignal;
    const result = runWithClientDeadline(
      manager,
      "client",
      1,
      15,
      async (requestSignal) => {
        signal = requestSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return "late result";
      },
    ).catch((error) => error);
    const error = await result;
    expect(error).to.be.instanceOf(TaskError);
    expect(error.code).to.equal(-32001);
    expect(signal.aborted).to.equal(true);
    expect(manager.getStatus()).to.deep.equal({
      active: 0,
      draining: 1,
      limit: 1,
    });
    const overflow = await runWithClientDeadline(
      manager,
      "client",
      2,
      100,
      async () => true,
    ).catch((e) => e);
    expect(overflow.code).to.equal(-32002);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getStatus().draining).to.equal(0);
    expect(
      await runWithClientDeadline(
        manager,
        "client",
        3,
        100,
        async () => "recovered",
      ),
    ).to.equal("recovered");
  });

  it("scopes cancellation to the session and preserves numeric versus string IDs", async () => {
    const manager = new RequestTaskManager();
    const first = runWithClientDeadline(manager, "a", 1, 500, (signal) =>
      abortableDelay(100, signal),
    ).catch((e) => e);
    const second = runWithClientDeadline(manager, "b", 1, 500, async () => {
      await abortableDelay(30);
      return "b";
    });
    const third = runWithClientDeadline(manager, "a", "1", 500, async () => {
      await abortableDelay(30);
      return "string";
    });
    expect(manager.cancel("b", 99)).to.equal(false);
    expect(manager.cancel("a", 1)).to.equal(true);
    expect((await first).code).to.equal(-32800);
    expect(await second).to.equal("b");
    expect(await third).to.equal("string");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getStatus().active).to.equal(0);
    expect(manager.getStatus().draining).to.equal(0);
  });

  it("removes expired queued work without releasing an operation that is still running", async () => {
    const queue = new SerialTaskQueue(2);
    let release!: () => void;
    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    let expiredRan = false;
    const expired = queue
      .run(async () => {
        expiredRan = true;
      }, controller.signal)
      .catch((e) => e);
    controller.abort(new TaskError(-32001, "deadline"));
    expect((await expired).code).to.equal(-32001);
    expect(queue.size).to.equal(1);
    let nextRan = false;
    const next = queue.run(async () => {
      nextRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nextRan).to.equal(false);
    release();
    await Promise.all([first, next]);
    expect(expiredRan).to.equal(false);
    expect(nextRan).to.equal(true);
    expect(queue.size).to.equal(0);
  });

  it("routes MCP cancellation to the matching session and aborts the actual tool", async () => {
    const server = new StreamableMCPServer() as any;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    server.callGetContent = async (_args: any, signal: AbortSignal) => {
      started();
      try {
        await abortableDelay(5000, signal);
      } finally {
        cancelled = signal.aborted;
      }
    };
    const response = server.handleMCPRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_content", arguments: { itemKey: "TEST" } },
      }),
      "session-a",
    );
    await ready;
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 4 },
    });
    expect(
      (await server.handleMCPRequest(notification, "session-b")).status,
    ).to.equal(202);
    expect(server.getStatus().tasks.active).to.equal(1);
    expect(
      (await server.handleMCPRequest(notification, "session-a")).status,
    ).to.equal(202);
    expect((await response).status).to.equal(202);
    expect(cancelled).to.equal(true);
    await abortableDelay(0);
    expect(server.getStatus().tasks).to.deep.equal({
      active: 0,
      draining: 0,
      limit: 32,
    });
  });

  it("honors two independent client deadlines through MCP cancellation notifications", async () => {
    const server = new StreamableMCPServer() as any;
    const aborted: string[] = [];
    server.callGetContent = async (args: any, signal: AbortSignal) => {
      try {
        await abortableDelay(5000, signal);
      } finally {
        if (signal.aborted) aborted.push(args.itemKey);
      }
    };
    const clientCall = (id: number, itemKey: string, timeoutMs: number) => {
      const response = server.handleMCPRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "get_content", arguments: { itemKey } },
        }),
        "agent",
      );
      const timer = setTimeout(() => {
        void server.handleMCPRequest(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: {
              requestId: id,
              reason: `Client timeout after ${timeoutMs}ms`,
            },
          }),
          "agent",
        );
      }, timeoutMs);
      return response.finally(() => clearTimeout(timer));
    };
    const short = clientCall(11, "short", 10);
    const long = clientCall(12, "long", 60);
    expect((await short).status).to.equal(202);
    expect(aborted).to.deep.equal(["short"]);
    expect(server.getStatus().tasks.active).to.equal(1);
    expect((await long).status).to.equal(202);
    expect(aborted).to.deep.equal(["short", "long"]);
    await abortableDelay(0);
    expect(server.getStatus().tasks).to.deep.equal({
      active: 0,
      draining: 0,
      limit: 32,
    });
  });

  it("stops queued writes from executing after cancellation while preserving write serialization", async () => {
    let release!: () => void;
    const first = runSerializedWrite(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    let wrote = false;
    const second = runSerializedWrite(async () => {
      wrote = true;
    }, controller.signal).catch((e) => e);
    controller.abort(new TaskError(-32001, "expired"));
    expect((await second).code).to.equal(-32001);
    release();
    await first;
    await abortableDelay(0);
    expect(wrote).to.equal(false);
    expect(await runSerializedWrite(async () => "next")).to.equal("next");
  });

  it("terminates a PDF worker and clears pending callbacks on cancellation", async () => {
    const originalWorker = (globalThis as any).Worker;
    const originalIO = (globalThis as any).IOUtils;
    const listeners: Record<string, (event: any) => void> = {};
    let terminated = false;
    let posted!: () => void;
    const started = new Promise<void>((resolve) => {
      posted = resolve;
    });
    (globalThis as any).Worker = class {
      addEventListener(type: string, callback: any) {
        listeners[type] = callback;
      }
      postMessage() {
        posted();
      }
      terminate() {
        terminated = true;
      }
    };
    (globalThis as any).IOUtils = { read: async () => new Uint8Array([1, 2]) };
    const processor = new PDFProcessor({
      getGlobal: () => ({ version: "10", Prefs: { get: () => 10 } }),
      log: () => {},
    }) as any;
    try {
      const controller = new AbortController();
      const result = processor
        .extractText("fixture.pdf", controller.signal)
        .catch((e: any) => e);
      await started;
      controller.abort(new TaskError(-32800, "cancel"));
      expect((await result).code).to.equal(-32800);
      expect(terminated).to.equal(true);
      expect(Object.keys(processor._waitingPromises)).to.have.length(0);
      expect(() =>
        listeners.message({ data: { responseID: 1, data: { text: "late" } } }),
      ).not.to.throw();
    } finally {
      processor.terminate();
      (globalThis as any).Worker = originalWorker;
      (globalThis as any).IOUtils = originalIO;
    }
  });

  it("aborts an embedding HTTP request and prevents API retries", async () => {
    let aborted = false,
      requests = 0;
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith("apiBase")
            ? "https://example.invalid/v1"
            : key.endsWith("model")
              ? "test-model"
              : undefined,
        set: () => {},
      },
      HTTP: {
        request: async (_method: string, _url: string, options: any) => {
          requests++;
          return new Promise((_resolve, reject) => {
            options.requestObserver({
              abort: () => {
                aborted = true;
                reject(new Error("aborted"));
              },
            });
            begin();
          });
        },
      },
    };
    const service = new EmbeddingService();
    const controller = new AbortController();
    const result = service
      .embed("fixture query", "en", true, controller.signal)
      .catch((e) => e);
    await started;
    controller.abort(new TaskError(-32001, "expired"));
    expect((await result).code).to.equal(-32001);
    expect(aborted).to.equal(true);
    expect(requests).to.equal(1);
  });

  it("validates and exposes execution settings without changing index concurrency", () => {
    const values = new Map<string, any>();
    (globalThis as any).Zotero.Prefs = {
      get: (key: string) => values.get(key),
      set: (key: string, value: any) => values.set(key, value),
    };
    MCPSettingsService.updateSettings({
      execution: { searchWorkers: 8 },
    });
    expect(MCPSettingsService.getAllSettings().execution).to.deep.equal({
      searchWorkers: 8,
    });
    expect(() =>
      MCPSettingsService.set("execution.searchWorkers", 33),
    ).to.throw();
    expect(() =>
      MCPSettingsService.set("execution.searchWorkers", 0),
    ).to.throw();
    expect(
      [...values.keys()].some((key) => key.includes("indexConcurrency")),
    ).to.equal(false);
  });
});
