import type { KbConfig } from "@llm-wiki/kb";
import type { WikiConfig } from "../types/config.js";

/**
 * Adapts the CLI's {@link WikiConfig}.kb (which may be partially populated and
 * is already merged with defaults by `loadConfig`) into the {@link KbConfig}
 * shape the kb package expects. Since `loadConfig` guarantees `kb` is present
 * and fully populated, this is mostly a structural copy.
 */
export function resolveKbConfig(config: WikiConfig): KbConfig {
  const kb = config.kb;
  // loadConfig always fills `kb`; guard for direct callers that built a config
  // without it.
  if (!kb) {
    throw new Error('Config is missing "kb"; run "llm-wiki-cli init" to create a full config.');
  }
  return {
    include: [...kb.include],
    exclude: [...kb.exclude],
    chunk: { maxChars: kb.chunk.maxChars, overlap: kb.chunk.overlap },
    embedding: { dimensions: kb.embedding.dimensions },
  };
}
