/**
 * ============================================================================
 *  AutoSuVichar — Critical Workflow Tests  (PRD #47)
 *  ----------------------------------------------------------------------
 *  चलाने का तरीका:   npm test
 *  (कोई नई dependency नहीं — Node 20 का built-in test runner इस्तेमाल होता है)
 *
 *  ये tests कोई असली post नहीं भेजते और कोई AI key नहीं माँगते।
 *  ये सिर्फ़ वो चीज़ें जाँचते हैं जो पहले टूट चुकी हैं —
 *  ताकि आगे कभी चुपचाप दोबारा न टूटें।
 * ============================================================================
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf-8");

// ── छोटा helper: server.js से किसी हिस्से का होना जाँचो ──
const has = (needle) => SRC.includes(needle);
const count = (needle) => SRC.split(needle).length - 1;

// ═══════════════════════════════════════════════════════════
describe("1. तीनों brands सही तरह से बने हैं", () => {
  test("तीनों brand ids मौजूद हैं", () => {
    for (const id of ["vp_honda", "yakuza", "minimetro"]) {
      assert.ok(new RegExp(`\\b${id}:\\s*\\{`).test(SRC), `${id} नहीं मिला`);
    }
  });

  test("Yakuza का रंग लाल है (हरा नहीं — logo से मेल खाता है)", () => {
    const blk = SRC.slice(SRC.indexOf("yakuza: {"), SRC.indexOf("minimetro: {"));
    assert.ok(/accent:\s*"#ED1C24"/i.test(blk), "Yakuza accent लाल होना चाहिए");
    assert.ok(!/#0EA36A/i.test(blk), "पुराना हरा रंग अब भी पड़ा है");
  });

  test("Mini Metro का logo cutout बंद है (सफ़ेद outline design का हिस्सा है)", () => {
    const blk = SRC.slice(SRC.indexOf("minimetro: {"));
    assert.ok(/logoCutout:\s*false/.test(blk));
    assert.ok(/logoOnLight:\s*true/.test(blk));
  });

  test('किसी भी brand पर "Honda dealer" hardcode नहीं है', () => {
    assert.ok(!/तुम Honda motorcycle dealer/.test(SRC));
    assert.ok(has("function brandDesc"), "brandDesc helper होना चाहिए");
  });
});

// ═══════════════════════════════════════════════════════════
describe("2. जो routes frontend माँगता है वो सब मौजूद हैं", () => {
  const REQUIRED = [
    "/api/health", "/api/auth/login", "/api/brands",
    "/api/mega-offer/submit",      // 7 editors इसी पर भेजते हैं — पहले गायब था
    "/api/vehicle-photos",         // duplicate route की वजह से टूटा था
    "/api/generate", "/api/promo", "/api/promo-image",
    "/api/delivery", "/api/deliveries",
    "/api/command/understand", "/api/command/execute",
    "/api/auto-marketing/plan", "/api/auto-marketing/execute",
    "/api/quality/check", "/api/video/slideshow",
    "/api/voice/script", "/api/voice/generate", "/api/voice/transcribe",
    "/api/adapt", "/api/platforms",
    "/api/variants/caption", "/api/variants/poster",
    "/api/news", "/api/news/fetch", "/api/ai/providers",
  ];
  for (const r of REQUIRED) {
    test(`route मौजूद: ${r}`, () => {
      assert.ok(SRC.includes(`"${r}"`), `${r} नहीं मिला`);
    });
  }
});

// ═══════════════════════════════════════════════════════════
describe("3. पहले टूटी हुई चीज़ें दोबारा न टूटें", () => {
  test("GET /api/vehicles सिर्फ़ एक बार है (duplicate route नहीं)", () => {
    assert.strictEqual(count('app.get("/api/vehicles"'), 1);
  });

  test("logos और vehicles folders serve होते हैं", () => {
    assert.ok(has('app.use("/logos"'), "/logos serve नहीं हो रहा");
    assert.ok(has('app.use("/vehicles"'), "/vehicles serve नहीं हो रहा");
  });

  test("express.json की limit बढ़ी हुई है (base64 photos के लिए)", () => {
    assert.ok(/express\.json\(\{\s*limit:/.test(SRC), "limit set नहीं है — 413 error आएगा");
    assert.ok(!/app\.use\(express\.json\(\)\)/.test(SRC), "बिना limit वाला express.json() अब भी है");
  });

  test("cron में 'promo' type नहीं जाता (वो valid type नहीं है)", () => {
    assert.ok(!/genToPending\(brand,\s*"promo"/.test(SRC));
    assert.ok(has("const normType"), "normType safety helper चाहिए");
  });

  test("recurring command अगली तारीख़ पर shift होता है", () => {
    assert.ok(has("nxt.setDate(nxt.getDate() + step)"),
      "वरना वही command दिन भर हर 5 मिनट दोबारा चलेगा");
  });

  test("WhatsApp पर absolute image URL जाता है", () => {
    assert.ok(has("const waImg = rawImg.startsWith"), "relative path Meta fetch नहीं कर पाता");
  });

  test("WhatsApp bot में waToken define है", () => {
    assert.ok(/const waToken = brandCreds\(brandId\)/.test(SRC));
  });

  test("/api/ig-account-id PUBLIC list में नहीं है (requireRole के साथ crash होता था)", () => {
    const pub = SRC.slice(SRC.indexOf("const PUBLIC = ["), SRC.indexOf("];", SRC.indexOf("const PUBLIC = [")));
    assert.ok(!pub.includes("ig-account-id"));
  });
});

// ═══════════════════════════════════════════════════════════
describe("4. AI layer provider-agnostic है (PRD #36)", () => {
  test("AI object और उसके पाँचों हिस्से मौजूद हैं", () => {
    for (const m of ["text(", "json(", "image(", "tts(", "stt("]) {
      assert.ok(SRC.includes(m), `AI.${m} नहीं मिला`);
    }
  });

  test("एक से ज़्यादा text providers हैं", () => {
    for (const p of ["gemini", "openai", "anthropic", "groq", "ollama"]) {
      assert.ok(SRC.includes(`  async ${p}(`), `text provider ${p} नहीं मिला`);
    }
  });

  test("TTS के 3 providers हैं (एक बिना key वाला भी)", () => {
    assert.ok(has("elevenlabs:"), "elevenlabs provider चाहिए");
    assert.ok(has("TTS_PROVIDERS"), "TTS_PROVIDERS चाहिए");
    assert.ok(/async free\(/.test(SRC), "बिना key वाला fallback चाहिए");
  });

  test("अब कहीं भी सीधा Gemini call बचा नहीं (सिर्फ़ provider के अंदर)", () => {
    // सिर्फ़ AI layer + image helper के अंदर होने चाहिए
    assert.ok(count("generativelanguage.googleapis.com") <= 3,
      "provider layer के बाहर भी hardcoded Gemini call बचा है");
  });
});

// ═══════════════════════════════════════════════════════════
describe("5. AI कभी price/offer खुद न बनाए (सबसे ज़रूरी नियम)", () => {
  test("हर बड़े prompt में 'मत बनाओ' वाला नियम है", () => {
    const prompts = ["generatePosterSpec", "makeCaptionVariants", "adaptToPlatforms", "makeVoiceScript"];
    for (const fn of prompts) {
      const i = SRC.indexOf(`function ${fn}`);
      assert.ok(i > -1, `${fn} नहीं मिला`);
      const blk = SRC.slice(i, i + 4000);
      assert.ok(/मत बनाओ/.test(blk), `${fn} में price-invent रोकने वाला नियम नहीं है`);
    }
  });

  test("vehicleContext सिर्फ़ database से जानकारी देता है", () => {
    assert.ok(has("async function vehicleContext"));
    assert.ok(has("जानकारी database में नहीं है"));
  });
});

// ═══════════════════════════════════════════════════════════
describe("6. News module fake news नहीं बना सकता (PRD #25)", () => {
  test("sourceUrl schema में required है", () => {
    const i = SRC.indexOf('model("NewsItem"');
    const blk = SRC.slice(i, i + 900);
    assert.ok(/sourceUrl:\s*\{[^}]*required:\s*true/.test(blk),
      "बिना source URL के खबर save नहीं होनी चाहिए");
  });

  test("सिर्फ़ भरोसेमंद sources की सूची से खबर आती है", () => {
    assert.ok(has("const TRUSTED_NEWS"));
    assert.ok(has("function fetchTrustedNews"));
  });

  test("unverified खबर से post नहीं बन सकती", () => {
    assert.ok(has("यह खबर verified नहीं है"),
      "unverified खबर पर रोक होनी चाहिए");
  });

  test("post बनने पर source link caption में जुड़ता है", () => {
    assert.ok(/📰 स्रोत:/.test(SRC));
  });
});

// ═══════════════════════════════════════════════════════════
describe("7. Scheduler और approval के नियम", () => {
  test("तीनों cron jobs मौजूद हैं", () => {
    assert.ok(has('cron.schedule("0 10 * * *"'), "10AM सुविचार");
    assert.ok(has('cron.schedule("0 11 * * *"'), "11AM विज्ञापन");
    assert.ok(has('cron.schedule("0 20 * * *"'), "8PM delivery");
  });

  test("scheduler timezone-aware है", () => {
    assert.strictEqual(count('timezone: "Asia/Kolkata"') >= 4, true);
  });

  test("safe mode में auto-publish नहीं होता", () => {
    assert.ok(has('autoS.mode === "full"'));
    assert.ok(has('autoS.mode === "semi"'));
  });

  test("daily limits (cost control) लगे हैं", () => {
    assert.ok(has("checkAndCountUsage"));
    assert.ok(has("dailyVideoLimit"));
  });
});

// ═══════════════════════════════════════════════════════════
describe("8. Security", () => {
  test("कोई API key code में hardcode नहीं है", () => {
    // असली keys के आम pattern
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(SRC), "OpenAI key जैसा कुछ code में है");
    assert.ok(!/AIza[A-Za-z0-9_\-]{30,}/.test(SRC), "Google key जैसा कुछ code में है");
  });

  test("JWT secret env से आता है", () => {
    assert.ok(has("process.env.JWT_SECRET"));
  });

  test("भेजने वाले routes पर role-check है", () => {
    for (const r of ["/api/content/:id/approve", "/api/delivery/:id/approve", "/api/voice/generate"]) {
      const i = SRC.indexOf(`"${r}"`);
      assert.ok(i > -1, `${r} नहीं मिला`);
      assert.ok(SRC.slice(i, i + 160).includes("requireRole"), `${r} पर requireRole नहीं है`);
    }
  });

  test(".env repo में commit नहीं है", () => {
    const envPath = path.join(__dirname, "..", ".env");
    assert.ok(!fs.existsSync(envPath),
      "⚠️ .env अब भी repo में है — MongoDB password leak हो सकता है! इसे हटाएँ और credentials बदलें।");
  });

  test(".gitignore में .env है", () => {
    const gi = path.join(__dirname, "..", ".gitignore");
    assert.ok(fs.existsSync(gi), ".gitignore बनाएँ");
    assert.ok(fs.readFileSync(gi, "utf-8").includes(".env"), ".gitignore में .env डालें");
  });
});

// ═══════════════════════════════════════════════════════════
describe("9. Server बिना crash हुए load होता है", () => {
  test("syntax सही है", () => {
    // require करने पर DB connect होगा — इसलिए सिर्फ़ parse जाँचते हैं
    const { execFileSync } = require("child_process");
    execFileSync(process.execPath, ["--check", SERVER]);
  });

  test("public folders मौजूद हैं", () => {
    const base = path.join(__dirname, "..", "public");
    assert.ok(fs.existsSync(path.join(base, "logos")), "public/logos चाहिए");
  });

  test("तीनों brand logos और owner logo फ़ाइल मौजूद हैं", () => {
    const d = path.join(__dirname, "..", "public", "logos");
    for (const f of ["vp_honda.png", "yakuza.png", "minimetro.png", "owner_logo.png"]) {
      assert.ok(fs.existsSync(path.join(d, f)), `${f} नहीं मिली — poster पर logo नहीं आएगा`);
    }
  });
});
