import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import * as cheerio from "cheerio";
import { chunkText, stripSpaces } from "./utils.js";

dotenv.config();

const STORE_BASE_URL = process.env.STORE_BASE_URL || "https://thehuggah.com";
const OUT = path.join(process.cwd(), "data", "store-index.json");

const seedUrls = [
  `${STORE_BASE_URL}/`,
  `${STORE_BASE_URL}/collections/all`,
  `${STORE_BASE_URL}/policies/shipping-policy`,
  `${STORE_BASE_URL}/policies/refund-policy`,
  `${STORE_BASE_URL}/policies/privacy-policy`,
  `${STORE_BASE_URL}/pages/contact`
];

function abs(base, href) {
  try {
    return new URL(href, base).toString().split("#")[0];
  } catch {
    return null;
  }
}

function allowed(url) {
  if (!url) return false;
  if (!url.startsWith(STORE_BASE_URL)) return false;

  return (
    url === `${STORE_BASE_URL}/` ||
    url === `${STORE_BASE_URL}` ||
    url.includes("/products/") ||
    url.includes("/collections/") ||
    url.includes("/policies/") ||
    url.includes("/pages/")
  );
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 HuggahBotCrawler/1.0" }
  });

  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return await res.text();
}

function parsePage(url, html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const title = stripSpaces($("title").first().text());
  const h1 = stripSpaces($("h1").first().text());
  const bodyText = stripSpaces($("body").text());
  const ogImage = $("meta[property='og:image']").attr("content") || "";

  let type = "page";
  if (url.includes("/products/")) type = "product";
  else if (url.includes("/collections/")) type = "collection";
  else if (url.includes("/policies/")) type = "policy";

  const chunks = chunkText(`${title}\n${h1}\n${bodyText}`).map((text, idx) => ({
    id: `${Buffer.from(url).toString("base64").slice(0, 12)}-${idx}`,
    type,
    url,
    title,
    h1,
    image: ogImage,
    text
  }));

  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const full = abs(url, href);
    if (allowed(full)) links.push(full);
  });

  return {
    meta: { url, type, title, h1, image: ogImage },
    chunks,
    links: [...new Set(links)]
  };
}

async function run() {
  const queue = [...seedUrls];
  const visited = new Set();
  const pages = [];
  const chunks = [];

  while (queue.length) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      const html = await fetchHtml(url);
      const parsed = parsePage(url, html);
      pages.push(parsed.meta);
      chunks.push(...parsed.chunks);

      for (const link of parsed.links) {
        if (!visited.has(link)) queue.push(link);
      }
    } catch (err) {
      console.error("crawl error", err.message);
    }
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pages,
        chunks
      },
      null,
      2
    )
  );

  console.log(`indexed ${pages.length} pages, ${chunks.length} chunks`);
}

run();
