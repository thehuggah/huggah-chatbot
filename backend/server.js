import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { knowledgeBase } from "./knowledge-base.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(helmet());
app.use(express.json());

app.use(
  cors({
    origin: [
      process.env.ALLOWED_ORIGIN,
      "https://thehuggah.com",
      "https://www.thehuggah.com"
    ].filter(Boolean)
  })
);

// geçici lead storage
const leads = [];

// telefon temizleme
function normalizePhone(phone = "") {
  return phone.replace(/[^\d+]/g, "").trim();
}

// TR telefon kontrol
function isValidTurkishPhone(phone = "") {
  const normalized = normalizePhone(phone);
  return /^(\+?90|0)?5\d{9}$/.test(normalized);
}

// bilgi bağlamı oluştur
function buildContext() {
  const products = knowledgeBase.products
    .map(
      (p) =>
        `Ürün: ${p.name}\nAnahtar kelimeler: ${p.aliases.join(", ")}\nÖzet: ${p.summary}`
    )
    .join("\n\n");

  const faq = knowledgeBase.faq
    .map((f) => `Soru: ${f.q}\nCevap: ${f.a}`)
    .join("\n\n");

  const policies = Object.entries(knowledgeBase.policies)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return `
Marka: ${knowledgeBase.brand.name}
Konumlandırma: ${knowledgeBase.brand.positioning}
İletişim: ${knowledgeBase.brand.contact.email}

${products}

SSS:
${faq}

Politikalar:
${policies}
`;
}

// basit eşleşme
function keywordRetrieve(message) {
  const text = message.toLowerCase();

  const matchedProducts = knowledgeBase.products.filter((product) =>
    product.aliases.some((alias) => text.includes(alias.toLowerCase())) ||
    text.includes(product.name.toLowerCase())
  );

  const matchedFaq = knowledgeBase.faq.filter((item) =>
    text.includes(item.q.toLowerCase().slice(0, 10))
  );

  return {
    matchedProducts,
    matchedFaq,
    lowSignal: matchedProducts.length === 0 && matchedFaq.length === 0
  };
}

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// lead kaydet
app.post("/api/lead", (req, res) => {
  const { name, phone, consent } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({ error: "İsim ve telefon zorunludur." });
  }

  if (!consent) {
    return res.status(400).json({ error: "Onay zorunludur." });
  }

  if (!isValidTurkishPhone(phone)) {
    return res.status(400).json({ error: "Geçerli telefon giriniz." });
  }

  const lead = {
    id: Date.now().toString(),
    name,
    phone: normalizePhone(phone),
    createdAt: new Date().toISOString()
  };

  leads.push(lead);

  res.json({ success: true, leadId: lead.id });
});

// chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, leadId, name, phone } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: "Mesaj boş olamaz." });
    }

    const retrieval = keywordRetrieve(message);
    const context = buildContext();

    const completion = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: buildSystemPrompt(context)
        },
        {
          role: "user",
          content: buildUserPrompt({ message })
        }
      ]
    });

    const answer = (completion.output_text || "").trim();

    const shouldFallback =
      retrieval.lowSignal || !answer || answer.includes("FALLBACK_REQUIRED");

    if (shouldFallback) {
      return res.json({
        success: true,
        fallback: true,
        answer:
          "Bu konuda sizi yanlış yönlendirmek istemem 🤍 Sorunuzu not aldım. Gerekirse ekibimiz sizinle iletişime geçebilir."
      });
    }

    res.json({
      success: true,
      fallback: false,
      answer
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Şu anda bir sorun oluştu, lütfen tekrar deneyin."
    });
  }
});

// server başlat
app.listen(PORT, () => {
  console.log(`Chatbot çalışıyor: ${PORT}`);
});
