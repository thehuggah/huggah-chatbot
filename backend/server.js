import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { execSync } from "child_process";
import { OpenAI } from "openai";
import { knowledgeBase } from "./knowledge-base.js";
import { normalizePhone, isValidTurkishPhone } from "./utils.js";
import { loadIndex, getIndexMeta, searchChunks, buildRagContext } from "./rag.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sessions = new Map();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: [
      process.env.ALLOWED_ORIGIN,
      "https://thehuggah.com",
      "https://www.thehuggah.com"
    ].filter(Boolean)
  })
);

async function maybeSendToWebhook(payload) {
  if (!process.env.ADMIN_WEBHOOK_URL) return;

  try {
    const response = await fetch(process.env.ADMIN_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log("Webhook response:", text);
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
}

function buildWhatsAppLink(topic = "destek") {
  const number = process.env.WHATSAPP_NUMBER;
  const messages = {
    destek: "Merhaba, destek almak istiyorum.",
    kargo: "Merhaba, kargo süresi hakkında bilgi almak istiyorum.",
    iade: "Merhaba, iade süreci hakkında bilgi almak istiyorum.",
    iletisim: "Merhaba, sizinle iletişime geçmek istiyorum."
  };

  const text = messages[topic] || messages.destek;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function buildBaseContext() {
  const siteInfo = Object.entries(knowledgeBase.siteInfo || {})
    .map(([k, v]) => Array.isArray(v) ? `${k}: ${v.join(", ")}` : `${k}: ${v}`)
    .join("\n");

  const faq = (knowledgeBase.faq || [])
    .map((f) => `Soru: ${f.q}\nCevap: ${f.a}`)
    .join("\n\n");

  const policyText = Object.entries(knowledgeBase.policies || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const products = (knowledgeBase.productCards || [])
    .map((p) => `Ürün: ${p.name}\nKategori: ${p.category}\nLink: ${p.url}\nÖzet: ${p.summary}`)
    .join("\n\n");

  return `
Marka: ${knowledgeBase.brand?.name || ""}
Slogan: ${knowledgeBase.brand?.slogan || ""}
Konumlandırma: ${knowledgeBase.brand?.positioning || ""}
İletişim e-posta: ${knowledgeBase.brand?.contact?.email || ""}
İletişim adresi: ${knowledgeBase.brand?.contact?.address || ""}
Telefon geri dönüş notu: ${knowledgeBase.brand?.contact?.supportNote || ""}

Site bilgileri:
${siteInfo}

SSS:
${faq}

Politikalar:
${policyText}

Ürünler:
${products}
`;
}

function detectQuickAnswer(message = "") {
  const text = message.toLowerCase().trim();

  if (["merhaba", "selam", "selamlar", "iyi günler", "hello", "hi"].includes(text)) {
    return {
      answer:
        "Merhaba 🤍 Size ürünler, içerikler, kargo, kampanya ve genel site bilgileri konusunda yardımcı olabilirim. Dilerseniz aklınızdaki ürünü yazabilirsiniz 🌿",
      links: []
    };
  }

  return null;
}

function getMatchedCards(message = "") {
  const text = message.toLowerCase();
  return (knowledgeBase.productCards || []).filter((p) =>
    (p.aliases || []).some((a) => text.includes(a.toLowerCase())) ||
    text.includes((p.name || "").toLowerCase())
  );
}

function buildHelpfulLinks(message = "", cards = []) {
  const text = message.toLowerCase();
  const links = [];

  for (const card of cards) {
    links.push({
      type: "product",
      title: card.name,
      subtitle: card.category,
      url: card.url,
      image: card.image,
      ctaPrimary: "Ürünü İncele",
      ctaPrimaryUrl: card.url,
      ctaSecondary: "Sepete Git",
      ctaSecondaryUrl: card.url
    });
  }

  if (text.includes("kargo") || text.includes("teslimat")) {
    links.push({
      type: "policy",
      title: "Kargo ve Teslimat Politikası",
      subtitle: "Politika",
      url: knowledgeBase.links?.shippingPolicy || "",
      image: "",
      ctaPrimary: "Sayfayı Aç",
      ctaPrimaryUrl: knowledgeBase.links?.shippingPolicy || "",
      ctaSecondary: "WhatsApp",
      ctaSecondaryUrl: `https://huggah-chatbot.onrender.com/go/whatsapp?topic=kargo`
    });
  }

  if (text.includes("iade") || text.includes("iptal") || text.includes("cayma")) {
    links.push({
      type: "policy",
      title: "İptal / İade Politikası",
      subtitle: "Politika",
      url: knowledgeBase.links?.refundPolicy || "",
      image: "",
      ctaPrimary: "Sayfayı Aç",
      ctaPrimaryUrl: knowledgeBase.links?.refundPolicy || "",
      ctaSecondary: "WhatsApp",
      ctaSecondaryUrl: `https://huggah-chatbot.onrender.com/go/whatsapp?topic=iade`
    });
  }

  if (
    text.includes("iletişim") ||
    text.includes("telefon") ||
    text.includes("mail") ||
    text.includes("email") ||
    text.includes("e-posta") ||
    text.includes("whatsapp")
  ) {
    links.push({
      type: "contact",
      title: "İletişim",
      subtitle: "Destek",
      url: knowledgeBase.links?.contact || "",
      image: "",
      ctaPrimary: "İletişim Sayfası",
      ctaPrimaryUrl: knowledgeBase.links?.contact || "",
      ctaSecondary: "WhatsApp",
      ctaSecondaryUrl: `https://huggah-chatbot.onrender.com/go/whatsapp?topic=iletisim`
    });
  }

  const seen = new Set();
  return links
    .filter((x) => x.url || x.ctaSecondaryUrl)
    .filter((x) => {
      const key = `${x.title}-${x.url}-${x.ctaSecondaryUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function getSession(sessionId) {
  if (!sessionId) return [];
  return sessions.get(sessionId) || [];
}

function saveSessionTurn(sessionId, userMessage, assistantMessage) {
  if (!sessionId) return;
  const current = sessions.get(sessionId) || [];
  current.push({ user: userMessage, assistant: assistantMessage });
  sessions.set(sessionId, current.slice(-6));
}

function summarizeHistory(history = []) {
  if (!history.length) return "yok";
  return history
    .map((x, i) => `Tur ${i + 1} Kullanıcı: ${x.user} | Asistan: ${x.assistant}`)
    .join("\n");
}

function inferPageContext(sourcePage = "") {
  const page = String(sourcePage || "").toLowerCase();
  if (!page) return "yok";

  const matched = (knowledgeBase.productCards || []).find((p) => {
    try {
      return page.includes(new URL(p.url).pathname.toLowerCase());
    } catch {
      return false;
    }
  });

  if (matched) {
    return `Kullanıcı şu anda ürün sayfasında olabilir: ${matched.name} / ${matched.category}`;
  }
  if (page.includes("/products/")) return "Kullanıcı bir ürün detay sayfasında.";
  if (page.includes("/collections/")) return "Kullanıcı bir koleksiyon sayfasında.";
  if (page.includes("/policies/")) return "Kullanıcı bir politika sayfasında.";
  return "Kullanıcı genel site sayfasında.";
}

async function boot() {
  if (String(process.env.CRAWL_ON_BOOT).toLowerCase() === "true") {
    try {
      execSync("node crawler.js", { stdio: "inherit" });
    } catch (err) {
      console.error("crawler boot error", err.message);
    }
  }
  await loadIndex();
}

app.get("/go/whatsapp", (req, res) => {
  const topic = String(req.query.topic || "destek");
  return res.redirect(buildWhatsAppLink(topic));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, index: getIndexMeta() });
});

app.post("/api/lead", async (req, res) => {
  const { name, phone, consent, sourcePage } = req.body || {};

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
    sourcePage: sourcePage || "",
    createdAt: new Date().toISOString()
  };

  await maybeSendToWebhook({
    type: "new_lead",
    lead
  });

  return res.json({ success: true, leadId: lead.id });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, leadId, name, phone, sessionId, sourcePage } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: "Mesaj boş olamaz." });
    }

    const quick = detectQuickAnswer(message);
    if (quick) {
      saveSessionTurn(sessionId, message, quick.answer);
      return res.json({
        success: true,
        fallback: false,
        answer: quick.answer,
        links: quick.links || []
      });
    }

    const matchedCards = getMatchedCards(message);
    const helpfulLinks = buildHelpfulLinks(message, matchedCards);
    const ragChunks = searchChunks(`${message} ${sourcePage || ""}`, 8);

    const context = `${buildBaseContext()}\n\nRAG:\n${buildRagContext(ragChunks)}`;
    const history = summarizeHistory(getSession(sessionId));
    const pageContext = inferPageContext(sourcePage);

    const completion = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: buildSystemPrompt({
            context,
            recentHistory: history,
            pageContext
          })
        },
        {
          role: "user",
          content: buildUserPrompt({ message })
        }
      ]
    });

    const answer = (completion.output_text || "").trim();
    const shouldFallback = !answer || answer.includes("FALLBACK_REQUIRED");

    if (shouldFallback) {
      const fallbackAnswer =
        "Sizi yanlış yönlendirmek istemem 🤍 Notunuzu aldım, gerekli olursa telefon bilginiz üzerinden size ulaşılabilir. Dilerseniz info@thehuggah.com üzerinden de bizimle iletişime geçebilirsiniz.";

      await maybeSendToWebhook({
        type: "fallback_question",
        leadId,
        name,
        phone,
        question: message,
        sourcePage,
        createdAt: new Date().toISOString()
      });

      saveSessionTurn(sessionId, message, fallbackAnswer);

      return res.json({
        success: true,
        fallback: true,
        answer: fallbackAnswer,
        links: helpfulLinks
      });
    }

    saveSessionTurn(sessionId, message, answer);

    return res.json({
      success: true,
      fallback: false,
      answer,
      links: helpfulLinks
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error:
        "Şu anda teknik bir aksaklık oluştu 🤍 Notunuzu aldım, gerekli olursa telefon bilginiz üzerinden size ulaşılabilir. Dilerseniz info@thehuggah.com üzerinden de bizimle iletişime geçebilirsiniz."
    });
  }
});

boot().then(() => {
  app.listen(PORT, () => {
    console.log(`Chatbot çalışıyor: ${PORT}`);
  });
});
