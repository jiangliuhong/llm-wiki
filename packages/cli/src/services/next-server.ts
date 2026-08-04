import http from "node:http";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import nodeFs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WikiConfig } from "../types/config.js";
import { getWebAppDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import type { GlobalContext } from "../utils/global-options.js";

/**
 * Starts the bundled Next.js app **in-process**, using the Next.js Node API
 * directly — no `child_process`, no shell, no `pnpm dev`/`npm run dev`.
 *
 * Flow:
 *   1. Resolve the web app directory (published or monorepo layout).
 *   2. Forward `title`/`port` to the app via `NEXT_PUBLIC_*` env vars.
 *   3. `next({ dev, dir }).prepare()` to boot the app.
 *   4. `http.createServer(handler)` to serve requests.
 *   5. `server.listen(port)` and resolve the running {@link Server}.
 */

/**
 * The subset of the Next.js custom-server API the CLI relies on.
 *
 * Next.js ships its public type entry (`index.d.ts` -> `./types` ->
 * `./dist/types`) as a chain that is only resolvable through the Next.js
 * compiler's path-mapped self-reference; importing `next` from an external
 * package (like this CLI) leaves the default export untyped as callable.
 *
 * To stay type-safe without depending on that brittle self-reference, we
 * declare the factory shape ourselves. The runtime object returned by
 * `next(...)` exposes exactly these methods, and we only use these.
 */
interface NextApp {
  prepare(): Promise<void>;
  getRequestHandler(): NextRequestHandler;
  close(): Promise<void>;
}

interface NextServerOptions {
  dev?: boolean;
  dir?: string;
  conf?: unknown;
  customServer?: boolean;
}

/** The callable default export of the `next` package. */
type NextFactory = (options: NextServerOptions) => NextApp;

type NextRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void> | void;

export interface ServeOptions {
  /** Wiki config providing title + port. */
  config: WikiConfig;
  /** Fully resolved knowledge-base paths exposed to server-side Web code. */
  context: GlobalContext;
  /** One or more independently stored knowledge bases exposed by this server. */
  knowledgeBases?: Array<{ config: WikiConfig; context: GlobalContext }>;
  /** Registry backing an editable multi-library service. Omitted for single-library serving. */
  registryPath?: string;
  /** Run in dev mode (HMR, on-the-fly compile). Defaults to true. */
  dev?: boolean;
  /** Optional override host. Defaults to listening on all interfaces. */
  hostname?: string;
}

export interface ServeResult {
  /** The running HTTP server. */
  server: Server;
  /** The URL the server is reachable on. */
  url: string;
  /** Absolute path to the web app that was served. */
  dir: string;
}

/**
 * Dynamically imports the `next` package and returns its factory.
 *
 * Using a dynamic import keeps the heavy `next` module out of the CLI's
 * startup path when the user runs `init` (which doesn't need Next at all),
 * and lets us cast to our local {@link NextFactory} type.
 */
async function loadNext(): Promise<NextFactory> {
  // The runtime default export of `next` is `createServer`, a callable that
  // returns a server object with `prepare()` / `getRequestHandler()`.
  const mod = (await import("next")) as { default: unknown };
  return mod.default as NextFactory;
}

/**
 * Starts the Next.js server and resolves once it is listening.
 *
 * The caller is responsible for keeping the process alive (the listening
 * server already does that) and for wiring up graceful shutdown if desired.
 */
export async function startNextServer(options: ServeOptions): Promise<ServeResult> {
  const {
    config,
    context,
    knowledgeBases = [{ config, context }],
    registryPath,
    dev = true,
    hostname = "0.0.0.0",
  } = options;

  const dir = getWebAppDir();

  // Surface the wiki title to the React app. NEXT_PUBLIC_* is inlined at
  // build/eval time, so we set it before `next().prepare()`.
  process.env.NEXT_PUBLIC_WIKI_TITLE = config.title;
  // Also expose as a plain env var for any server components.
  process.env.WIKI_TITLE = config.title;
  process.env.LLM_WIKI_ROOT = context.root;
  process.env.LLM_WIKI_DB = context.dbPath;
  process.env.LLM_WIKI_CONFIG = context.configPath;
  process.env.LLM_WIKI_KB_ID = context.kbId ?? "default";
  const manifestPath = writeServeManifest(knowledgeBases, context.kbId ?? "default", registryPath);
  process.env.LLM_WIKI_SERVE_MANIFEST = manifestPath;

  // Next.js needs a writable `.next` cache dir. In the monorepo that lives
  // inside the web package; when packaged we still want it writable, so we
  // make the dir and let Next create `.next` under it.
  ensureNextCacheWritable(dir);

  const next = await loadNext();
  const app = next({ dev, dir });

  await app.prepare();
  const handler = app.getRequestHandler();

  const server = http.createServer((req, res) => {
    // `handler` expects IncomingMessage / ServerResponse; the http server
    // provides exactly those types.
    handler(req, res);
  });
  server.once("close", () => {
    try {
      nodeFs.unlinkSync(manifestPath);
    } catch {
      // Best-effort cleanup; the OS temp directory is safe if the process exits abruptly.
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${config.port} is already in use. ` +
              `Set a different "port" in .llm-wiki/config.json and try again.`,
          ),
        );
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(config.port, hostname, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const displayHost = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
  const url = `http://${displayHost}:${address.port}`;

  logger.success(`Server started at ${url}`);
  logger.info(`Serving wiki "${config.title}" from ${dir}`);
  logger.info(`Press Ctrl+C to stop.`);

  return { server, url, dir };
}

function writeServeManifest(
  knowledgeBases: Array<{ config: WikiConfig; context: GlobalContext }>,
  defaultKb: string,
  registryPath?: string,
): string {
  const manifestPath = nodePath.join(tmpdir(), `llm-wiki-serve-${process.pid}.json`);
  const manifest = {
    version: 1,
    defaultKb,
    registryPath,
    knowledgeBases: knowledgeBases.map(({ config, context }) => ({
      id: context.kbId ?? "default",
      title: config.title,
      root: context.root,
      configPath: context.configPath,
      dbPath: context.dbPath,
      embedding: {
        enabled: config.kb?.embedding.enabled ?? false,
        dimensions: config.kb?.embedding.dimensions ?? 1536,
      },
    })),
  };
  nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return manifestPath;
}

/**
 * Ensures the web app directory (and thus its `.next` cache) is writable.
 * Some read-only installs need `.next` redirected to a temp dir; we detect
 * that by attempting to create a probe file.
 */
function ensureNextCacheWritable(dir: string): void {
  const probe = nodePath.join(dir, `.llm-write-probe-${process.pid}`);
  try {
    nodeFs.writeFileSync(probe, "");
    nodeFs.unlinkSync(probe);
    return; // writable — let Next use `<dir>/.next` as normal.
  } catch {
    // Not writable: redirect `.next` into the OS temp directory.
    const tmp = nodePath.join(tmpdir(), `llm-wiki-next-${sanitise(dir)}`);
    nodeFs.mkdirSync(tmp, { recursive: true });
    process.env.NEXT_DIST_DIR = nodePath.join(tmp, ".next");
    logger.warn(`Web directory is read-only; using cache at ${tmp}`);
  }
}

function sanitise(input: string): string {
  return input.replace(/[^a-zA-Z0-9-_]/g, "_").slice(-40);
}
