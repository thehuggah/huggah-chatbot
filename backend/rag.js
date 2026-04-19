import fs from "fs/promises";
import path from "path";
import { simpleScore } from "./utils.js";

const INDEX_PATH = path.join(process.cwd(), "data", "store-index.json");

let storeIndex = {
  generatedAt: null,
  pages: [],
  chunks: []
};

export async function loadIndex() {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf-8");
    storeIndex = JSON.parse(raw);
  } catch {
    storeIndex = { generatedAt: null, pages: [], chunks: [] };
  }
  return storeIndex;
}

export function getIndexMeta() {
  return {
    generatedAt: storeIndex.generatedAt,
    pageCount: storeIndex.pages?.length || 0,
    chunkCount: storeIndex.chunks?.length || 0
  };
}

export function searchChunks(query, limit = 8) {
  const ranked = (storeIndex.chunks || [])
    .map((chunk) => ({
      ...chunk,
      score:
        simpleScore(chunk.title, query) +
        simpleScore(chunk.h1, query) +
        simpleScore(chunk.text, query) +
        (chunk.type === "product" ? 2 : 0)
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

export function buildRagContext(chunks = []) {
  return chunks
    .map(
      (c, i) =>
        `Kaynak ${i + 1}\nTür: ${c.type}\nBaşlık: ${c.title}\nURL: ${c.url}\nİçerik: ${c.text}`
    )
    .join("\n\n---\n\n");
}
