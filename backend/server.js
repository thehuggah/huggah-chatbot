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

const leads = [];

function normalizePhone(phone = "") {
  return phone.replace(/[^\d+]/g, "").trim();
}

function isValidTurkishPhone(phone = "") {
  const normalized = normalizePhone(phone);
  return /^(\+?90|0)?5\d{9}$/.test(normalized);
}

function buildContext() {
  const products = knowledgeBase.products
    .map((p) => {
      const benefitsText = p.benefits?.length
        ? `\nFaydalar: ${p.benefits.join(", ")}`
        : "";

      const ingredientsText = p.ingredients?.length
        ? `\nİçerikler: ${p.ingredients.join(", ")}`
        : "";

      const claimsText = p.claims?.length
        ? `\nClaimler: ${p.claims.join(", ")}`
        : "";

      return `Ürün: ${p.name}
Anahtar kelimeler: ${p.aliases.join(", ")}
Özet: ${p.summary}${benefitsText}${ingredientsText}${claimsText}`;
    })
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

function keywordRetrieve(message) {
  const text = message.toLowerCase().trim();

  const greetingWords = ["merhaba", "selam", "selamlar", "iyi günler", "hello", "hi"];
  const shippingWords = ["kargo", "teslimat", "kaç günde", "ne zaman gelir", "ücretsiz kargo"];
  const ingredientWords = ["içerik", "içindekiler", "ingredients", "formül"];
  const returnWords = ["iade", "cayma", "refund", "iptal"];
  const organicWords = ["organik", "cosmos", "sertifika", "sertifikalı", "vegan"];

  const matchedProducts = knowledgeBase.products.filter((product) =>
    product.aliases.some((alias) => text.includes(alias.toLowerCase())) ||
    text.includes(product.name.toLowerCase())
  );

  const matchedFaq = knowledgeBase.faq.filter((item) => {
    const q = item.q.toLowerCase();
    return text.includes(q) || q.includes(text);
  });

  return {
    matchedProducts,
    matchedFaq,
    lowSignal:
      matchedProducts.length === 0 &&
      matchedFaq.length === 0 &&
      !greetingWords.some((word) => text.includes(word)) &&
      !shippingWords.some((word) => text.includes(word)) &&
      !ingredientWords.some((word) => text.includes(word)) &&
      !returnWords.some((word) => text.includes(word)) &&
      !organicWords.some((word) => text.includes(word))
  };
}

// BURASI YENİ: webhook gönderme
async function maybeSendToWebhook(payload) {
  if (!process.env.ADMIN_WEBHOOK_URL) return;

  try {
    const response = await fetch(process.env.ADMIN_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log("Webhook response:", text);
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/lead", async (req, res) => {
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
    consent: true,
    createdAt: new Date().toISOString()
  };

  leads.push(lead);

  // BURASI YENİ: form doldurulunca Google Sheet’e gönder
  await maybeSendToWebhook({
    type: "new_lead",
    lead
  });

  res.json({ success: true, leadId: lead.id });
});

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
      // BURASI YENİ: cevap veremediği soruyu Google Sheet’e gönder
      await maybeSendToWebhook({
        type: "fallback_question",
        leadId,
        name,
        phone,
        question: message,
        createdAt: new Date().toISOString()
      });

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

app.listen(PORT, () => {
  console.log(`Chatbot çalışıyor: ${PORT}`);
});
