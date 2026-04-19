export function normalizePhone(phone = "") {
  return phone.replace(/[^\d+]/g, "").trim();
}

export function isValidTurkishPhone(phone = "") {
  const normalized = normalizePhone(phone);
  return /^(\+?90|0)?5\d{9}$/.test(normalized);
}

export function stripSpaces(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

export function chunkText(text, maxLength = 900, overlap = 120) {
  const clean = stripSpaces(text);
  if (!clean) return [];

  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + maxLength));
    i += maxLength - overlap;
  }
  return chunks;
}

export function simpleScore(text, query) {
  const t = String(text || "").toLowerCase();
  const q = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  let score = 0;
  for (const token of q) {
    if (t.includes(token)) score += 2;
  }
  return score;
}
