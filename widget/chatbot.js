(function () {
  const CONFIG = {
    apiBase: "https://YOUR_BACKEND_DOMAIN.com", // BURAYI SONRA DEĞİŞTİRECEĞİZ
    title: "Huggah Asistan",
    welcome:
      "Merhaba 🤍 Size yardımcı olmaktan memnuniyet duyarım. Önce kısa bir bilgi alalım.",
    firstBotMessage:
      "Sorularınızı yazabilirsiniz. Ürünlerimiz ve site hakkında yardımcı olabilirim."
  };

  const root = document.createElement("div");
  root.id = "huggah-chatbot-root";

  root.innerHTML = `
    <button class="hc-toggle">💬</button>
    <div class="hc-panel">
      <div class="hc-header">${CONFIG.title}</div>
      <div class="hc-body" id="hc-body"></div>
      <div class="hc-footer" id="hc-footer"></div>
    </div>
  `;

  document.body.appendChild(root);

  const toggle = root.querySelector(".hc-toggle");
  const panel = root.querySelector(".hc-panel");
  const body = root.querySelector("#hc-body");
  const footer = root.querySelector("#hc-footer");

  let lead = {
    leadId: null,
    name: "",
    phone: "",
    started: false
  };

  function addMessage(text, sender = "bot") {
    const div = document.createElement("div");
    div.className = `hc-message ${sender}`;
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function renderLeadForm() {
    body.innerHTML = "";
    footer.innerHTML = "";

    addMessage(CONFIG.welcome, "bot");

    const form = document.createElement("form");
    form.className = "hc-form";

    form.innerHTML = `
      <input class="hc-input" name="name" placeholder="Adınız Soyadınız" required />
      <input class="hc-input" name="phone" placeholder="Cep Telefonunuz" required />

      <label class="hc-consent">
        <input type="checkbox" name="consent" required />
        <span>Kişisel verilerimin işlenmesini kabul ediyorum</span>
      </label>

      <button class="hc-btn" type="submit">Başlat</button>
    `;

    footer.appendChild(form);

    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      const fd = new FormData(form);

      const payload = {
        name: fd.get("name"),
        phone: fd.get("phone"),
        consent: true
      };

      try {
        const res = await fetch(`${CONFIG.apiBase}/api/lead`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (!res.ok) {
          alert(data.error || "Hata oluştu");
          return;
        }

        lead = {
          ...lead,
          ...payload,
          leadId: data.leadId,
          started: true
        };

        renderChat();
        addMessage(CONFIG.firstBotMessage, "bot");
      } catch (err) {
        alert("Bağlantı hatası");
      }
    });
  }

  function renderChat() {
    footer.innerHTML = `
      <form class="hc-chat-form">
        <textarea class="hc-textarea" name="message" placeholder="Sorunuzu yazın..."></textarea>
        <button class="hc-btn" type="submit">Gönder</button>
      </form>
    `;

    const form = footer.querySelector("form");
    const textarea = form.querySelector("textarea");
    const button = form.querySelector("button");

    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      const message = textarea.value.trim();
      if (!message) return;

      addMessage(message, "user");
      textarea.value = "";
      button.disabled = true;

      try {
        const res = await fetch(`${CONFIG.apiBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            leadId: lead.leadId,
            name: lead.name,
            phone: lead.phone
          })
        });

        const data = await res.json();

        if (!res.ok) {
          addMessage("Şu anda cevap veremiyorum", "bot");
          return;
        }

        addMessage(data.answer, "bot");
      } catch (err) {
        addMessage("Bağlantı hatası oluştu", "bot");
      } finally {
        button.disabled = false;
      }
    });
  }

  toggle.addEventListener("click", function () {
    panel.classList.toggle("open");

    if (panel.classList.contains("open") && !lead.started) {
      renderLeadForm();
    }
  });
})();
