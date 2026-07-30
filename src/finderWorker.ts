/**
 * Worker thread hosting the native FFF finder.
 *
 * The fff-node search calls (`fileSearch`, `grep`, ...) are synchronous
 * native calls: running them on the extension host thread freezes VS Code
 * whenever a query is slow (e.g. content search while the index warms up).
 * This worker isolates those calls so the extension host stays responsive
 * and searches can run against the partial index while scanning continues.
 */
import { parentPort } from "node:worker_threads";
import type { FileFinderApi, GrepOptions, InitOptions, SearchOptions } from "@ff-labs/fff-node";

interface WorkerRequest {
  id: number;
  op: string;
  args: Record<string, unknown>;
}

let finder: FileFinderApi | undefined;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

function active(): FileFinderApi {
  if (!finder || finder.isDestroyed) {
    throw new Error("FFF finder is not initialized.");
  }
  return finder;
}

async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "init": {
      const mod = await import("@ff-labs/fff-node");
      if (finder && !finder.isDestroyed) {
        finder.destroy();
      }
      finder = unwrap(mod.FileFinder.create(args.options as InitOptions));
      return true;
    }
    case "fileSearch":
      return unwrap(active().fileSearch(args.query as string, args.options as SearchOptions));
    case "grep":
      return unwrap(active().grep(args.query as string, args.options as GrepOptions));
    case "scanFiles":
      return unwrap(active().scanFiles());
    case "progress":
      return unwrap(active().getScanProgress());
    case "health":
      return unwrap(active().healthCheck(args.testPath as string | undefined));
    case "waitForIndexReady":
      return unwrap(await active().waitForIndexReady(args.timeoutMs as number | undefined));
    case "destroy":
      if (finder && !finder.isDestroyed) {
        finder.destroy();
      }
      finder = undefined;
      return true;
    default:
      throw new Error(`Unknown worker op: ${op}`);
  }
}

const port = parentPort;
if (!port) {
  throw new Error("finderWorker must be run as a worker thread.");
}

port.on("message", (request: WorkerRequest) => {
  void (async () => {
    try {
      const value = await dispatch(request.op, request.args ?? {});
      port.postMessage({ id: request.id, ok: true, value });
    } catch (error) {
      port.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
