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
describe("10. Hardening — storage, retry, audit, rate limit", () => {
  test("storage cleanup मौजूद है (Render की disk भरने से बचाव)", () => {
    assert.ok(has("async function cleanupStorage"));
    assert.ok(has("function diskUsage"));
    assert.ok(has('cron.schedule("0 3 * * *"'), "रोज़ रात 3 बजे cleanup cron चाहिए");
  });

  test("cleanup इस्तेमाल हो रही file कभी नहीं हटाता", () => {
    const i = SRC.indexOf("async function cleanupStorage");
    const blk = SRC.slice(i, i + 2600);
    assert.ok(blk.includes("if (inUse.has(f))"), "in-use check होना चाहिए");
    assert.ok(blk.includes("st.mtimeMs > cutoff"), "नई files भी बचनी चाहिए");
  });

  test("rate limiting मौजूद है", () => {
    assert.ok(has("function rateLimit"));
  });

  test("public और login routes पर rate limit लगा है", () => {
    for (const r of ["/api/lead", "/api/auth/login"]) {
      const i = SRC.indexOf(`"${r}"`);
      assert.ok(SRC.slice(i, i + 220).includes("rateLimit"), `${r} पर rate limit नहीं है`);
    }
  });

  test("retry + idempotency मौजूद है", () => {
    assert.ok(has("async function safePublish"));
    assert.ok(has("function publishKey"), "duplicate रोकने की key चाहिए");
    assert.ok(has("async function runRetryQueue"));
    assert.ok(has("MAX_ATTEMPTS"));
  });

  test("publish अब सीधे नहीं, safePublish से होता है", () => {
    assert.strictEqual(count("const results = await publish(doc)"), 0,
      "कोई route अब भी सीधे publish() कर रहा है — retry/duplicate protection नहीं मिलेगा");
  });

  test("Content व Delivery में retry fields हैं", () => {
    for (const f of ["attempts:", "nextRetryAt", "publishLock", "publishedKey"]) {
      assert.ok(SRC.includes(f), `schema में ${f} चाहिए`);
    }
  });

  test("Audit log मौजूद है और अलग collection है", () => {
    assert.ok(has('model("AuditLog"'));
    assert.ok(has("async function audit("));
    // cleanup ActivityLog हटाता है पर AuditLog को नहीं छूता
    const i = SRC.indexOf("async function cleanupStorage");
    const blk = SRC.slice(i, i + 2600);
    assert.ok(blk.includes("ActivityLog.deleteMany"), "पुरानी activity logs हटनी चाहिए");
    assert.ok(!blk.includes("AuditLog.deleteMany"), "⚠️ AuditLog कभी delete नहीं होना चाहिए");
  });

  test("approve/reject/resend पर audit लिखा जाता है", () => {
    assert.ok(count("await audit(req,") >= 4, "अहम जगहों पर audit call चाहिए");
  });

  test("retry cron हर 5 मिनट चलता है", () => {
    assert.ok(has('cron.schedule("*/5 * * * *"'));
  });
});

// ═══════════════════════════════════════════════════════════
describe("11. Batch, Triggers, Insights, Creative Video, MCP", () => {
  test("Batch generation मौजूद है", () => {
    assert.ok(has('model("BatchJob"'));
    assert.ok(has("async function runBatch"));
    assert.ok(SRC.includes('"/api/batch"'));
  });

  test("Batch background में चलता है (request block नहीं करता)", () => {
    const i = SRC.indexOf('app.post("/api/batch"');
    assert.ok(SRC.slice(i, i + 1800).includes("setImmediate(() => runBatch"));
  });

  test("Batch पर limit है (खर्च न बढ़े)", () => {
    assert.ok(has("const BATCH_MAX"));
    const i = SRC.indexOf('app.post("/api/batch"');
    assert.ok(SRC.slice(i, i + 300).includes("rateLimit"));
  });

  test("Batch बीच में cost limit देखता है", () => {
    const i = SRC.indexOf("async function runBatch");
    assert.ok(SRC.slice(i, i + 3000).includes('checkAndCountUsage(job.brand, "aiCalls")'));
  });

  test("Triggers मौजूद हैं और सभी घटनाएँ जुड़ी हैं", () => {
    assert.ok(has("const TRIGGER_EVENTS"));
    assert.ok(has("async function fireTrigger"));
    for (const ev of ["new_delivery", "new_vehicle", "new_lead", "festival_soon", "low_content"]) {
      assert.ok(SRC.includes(`"${ev}"`), `trigger ${ev} नहीं मिला`);
    }
  });

  test("Trigger request को block नहीं करता", () => {
    assert.ok(has("function fireTriggerAsync"));
    assert.ok(count("fireTriggerAsync(") >= 4, "असली घटनाओं पर trigger जुड़ा होना चाहिए");
  });

  test("⚠️ Trigger default में अपने आप publish नहीं करता", () => {
    const i = SRC.indexOf('model("TriggerRule"');
    assert.ok(/autoApprove:\s*\{\s*type:\s*Boolean,\s*default:\s*false/.test(SRC.slice(i, i + 900)),
      "autoApprove का default false होना चाहिए");
    // और full mode में ही भेजे
    const j = SRC.indexOf("async function fireTrigger");
    assert.ok(SRC.slice(j, j + 3000).includes('autoS?.mode === "full"'));
  });

  test("Trigger में cooldown है (बार-बार न चले)", () => {
    const i = SRC.indexOf("async function fireTrigger");
    assert.ok(SRC.slice(i, i + 1200).includes("cooldownMins"));
  });

  test("FB/IG असली insights आते हैं", () => {
    assert.ok(has("async function fetchPostInsights"));
    assert.ok(has("post_impressions"), "FB metrics चाहिए");
    assert.ok(has("like_count,comments_count"), "IG metrics चाहिए");
    assert.ok(has('cron.schedule("0 1 * * *"'), "रोज़ insights refresh cron चाहिए");
  });

  test("insights API quota बचाता है (6 घंटे cache)", () => {
    const i = SRC.indexOf("async function refreshAllInsights");
    assert.ok(SRC.slice(i, i + 1200).includes("6 * 3600 * 1000"));
  });

  test("AI creative video provider-agnostic है", () => {
    assert.ok(has("const VIDEO_PROVIDERS"));
    assert.ok(has("async function makeCreativeVideo"));
    for (const p of ["replicate", "luma"]) {
      assert.ok(SRC.includes(`  async ${p}(`), `video provider ${p} नहीं मिला`);
    }
  });

  test("video provider न हो तो साफ़ message आए, crash नहीं", () => {
    const i = SRC.indexOf("async function makeCreativeVideo");
    const blk = SRC.slice(i, i + 3000);
    assert.ok(blk.includes("hint:"), "बिना key वाले हालात में मदद वाला message चाहिए");
  });

  test("MCP मौजूद है", () => {
    assert.ok(has("const MCP_TOOLS"));
    assert.ok(has("async function mcpCall"));
    assert.ok(SRC.includes('"/api/mcp"'));
    assert.ok(SRC.includes('"/api/mcp/tools"'));
  });

  test("⚠️ MCP पूरी तरह READ-ONLY है", () => {
    const i = SRC.indexOf("async function mcpCall");
    const blk = SRC.slice(i, SRC.indexOf("\n}", i + 2000));
    // कोई भी लिखने वाला operation नहीं होना चाहिए
    for (const op of [".create(", ".deleteOne", ".deleteMany", "findByIdAndUpdate", "findByIdAndDelete", "safePublish"]) {
      assert.ok(!blk.includes(op), `⚠️ MCP में लिखने वाला operation मिला: ${op}`);
    }
  });

  test("MCP JSON-RPC के तीनों methods हैं", () => {
    for (const m of ["initialize", "tools/list", "tools/call"]) {
      assert.ok(SRC.includes(`"${m}"`), `MCP method ${m} नहीं मिला`);
    }
  });
});

// ═══════════════════════════════════════════════════════════
describe("12. Poster layout — logo, text, stickers", () => {
  test("⚠️ डबल logo नहीं छपेगा", () => {
    const i = SRC.indexOf("async function resolveLogos");
    const blk = SRC.slice(i, i + 1200);
    assert.ok(blk.includes("if (company && company === owner) company = null"),
      "बाएँ-दाएँ एक ही file हो तो दायाँ छोड़ देना चाहिए");
  });

  test("file मौजूद न हो तो logo छोड़ दिया जाता है", () => {
    const i = SRC.indexOf("async function loadLogo");
    assert.ok(SRC.slice(i, i + 700).includes("if (!fs.existsSync(p)) return null"));
  });

  test("हर brand का companyLogo अलग से तय है", () => {
    for (const b of ["vp_honda", "yakuza", "minimetro"]) {
      const i = SRC.indexOf(`${b}: {`);
      assert.ok(/companyLogo:/.test(SRC.slice(i, i + 1500)), `${b} में companyLogo नहीं है`);
    }
  });

  test("⚠️ code खुद कोई logo नहीं बनाता — सिर्फ़ मौजूद files इस्तेमाल होती हैं", () => {
    assert.ok(has("function availableLogos"), "folder से files पढ़नी चाहिए");
    const i = SRC.indexOf("async function resolveLogos");
    const blk = SRC.slice(i, i + 1200);
    assert.ok(blk.includes("have.has(n)"), "सिर्फ़ मौजूद file ही चुननी चाहिए");
  });

  test("logo App से बदला जा सकता है", () => {
    assert.ok(has('model("LogoConfig"'));
    assert.ok(SRC.includes('"/api/logos"'));
    assert.ok(SRC.includes('"/api/logos/upload"'));
  });

  test("upload सिर्फ़ image files लेता है", () => {
    const i = SRC.indexOf("const logoUpload");
    assert.ok(SRC.slice(i, i + 500).includes("fileFilter"), "किसी भी file को logo मत बनने दो");
  });

  test("logo बदलते ही video header cache भी साफ़ होता है", () => {
    assert.ok(has("function clearLogoCache"));
    const i = SRC.indexOf("function clearLogoCache");
    assert.ok(SRC.slice(i, i + 200).includes("_headerCache"), "वरना पुराना logo वाली header चलती रहेगी");
  });

  test("text safe zone तय है (poster से बाहर न जाए)", () => {
    assert.ok(has("const SAFE_TOP"), "safe zone चाहिए");
    assert.ok(has("SAFE_BOT"), "नीचे address bar से टकराना नहीं चाहिए");
  });

  test("लंबा text आने पर font अपने आप छोटा होता है", () => {
    const i = SRC.indexOf("function buildSVG");
    const blk = SRC.slice(i, i + 2500);
    assert.ok(blk.includes("MIN_FONT"), "font shrink logic चाहिए");
    assert.ok(blk.includes("for (let f = fontSize; f >= MIN_FONT"), "loop से fit करना चाहिए");
  });

  test("बहुत लंबा text काटा जाता है, बाहर नहीं निकलता", () => {
    const i = SRC.indexOf("function buildSVG");
    assert.ok(SRC.slice(i, i + 2500).includes("maxLines"), "line cap चाहिए");
  });

  test("⚠️ stickers/decor सिर्फ़ किनारे की rails में हैं", () => {
    assert.ok(has("const RAIL_L"), "rail constants चाहिए");
    assert.ok(has("SAFE_RAILS"));
    assert.ok(has("SAFE_DECOR_SLOTS"));
    // पुरानी टकराने वाली जगहें वापस न आ जाएँ
    assert.ok(!SRC.includes("[[0.15, 0.205], [0.85, 0.205], [0.85, 0.775]]"),
      "पुरानी sticker जगहें text के ऊपर चढ़ती थीं");
  });

  test("rails text वाले हिस्से से बाहर हैं", () => {
    const m = /const RAIL_L = ([\d.]+), RAIL_R = ([\d.]+);/.exec(SRC);
    assert.ok(m, "RAIL constants नहीं मिले");
    assert.ok(parseFloat(m[1]) < 0.16, "बायाँ rail text से टकरा रहा है");
    assert.ok(parseFloat(m[2]) > 0.84, "दायाँ rail text से टकरा रहा है");
  });

  test("बीच में बड़े shapes वाले designs लंबे text पर नहीं चुने जाते", () => {
    assert.ok(has("CENTER_HEAVY_DESIGNS"));
    const i = SRC.indexOf("function pickDesign");
    assert.ok(SRC.slice(i, i + 900).includes("CENTER_HEAVY_DESIGNS.has(i)"),
      "auto चुनते समय इन्हें छोड़ना चाहिए");
  });

  test("text के पीछे scrim लगता है ताकि सजावट पर भी पढ़ा जाए", () => {
    assert.ok(has("textScrim"));
    assert.ok(has("const needScrim"));
  });
});

// ═══════════════════════════════════════════════════════════
describe("13. Header हर जगह + रोज़ का Auto Engine", () => {
  test("video पर भी header लगता है (सिर्फ़ photo पर नहीं)", () => {
    assert.ok(has("async function videoHeaderPNG"));
    assert.ok(has("async function stampVideoHeader"));
  });

  test("तीनों तरह की video पर header लगता है", () => {
    assert.ok(count("stampVideoHeader(") >= 4,
      "slideshow, delivery, auto-delivery और creative — चारों पर header चाहिए");
  });

  test("slideshow को brand मिलता है (वरना header नहीं लगेगा)", () => {
    const i = SRC.indexOf("makeSlideshowVideo(jobId, photoPaths, {");
    assert.ok(SRC.slice(i, i + 400).includes("brand,"), "brand pass होना चाहिए");
  });

  test("header में दोनों logo आते हैं", () => {
    const i = SRC.indexOf("async function videoHeaderPNG");
    const blk = SRC.slice(i, i + 2200);
    assert.ok(blk.includes("loadOwnerLogo"), "बाएँ मालिक का logo");
    assert.ok(blk.includes("loadLogo(brandId"), "दाएँ कंपनी का logo");
  });

  test("header हर बार दोबारा नहीं बनता (cache है)", () => {
    assert.ok(has("_headerCache"), "हर video पर दोबारा बनाना धीमा होगा");
  });

  test("Daily auto engine मौजूद है", () => {
    assert.ok(has("async function runDailyEngine"));
    assert.ok(has("async function autoPromoVideo"));
    assert.ok(has("async function autoDeliveryVideos"));
    assert.ok(has('cron.schedule("0 7 * * *"'), "रोज़ सुबह 7 बजे चलना चाहिए");
  });

  test("engine posters और video दोनों बनाता है", () => {
    const i = SRC.indexOf("async function runDailyEngine");
    const blk = SRC.slice(i, i + 4000);
    assert.ok(blk.includes("genToPending"), "posters बनने चाहिए");
    assert.ok(blk.includes("autoPromoVideo"), "promotional video बनना चाहिए");
    assert.ok(blk.includes("autoDeliveryVideos"), "delivery video भी");
  });

  test("⚠️ engine अपने आप publish नहीं करता — सब Review में जाता है", () => {
    const i = SRC.indexOf("async function runDailyEngine");
    const blk = SRC.slice(i, i + 4000);
    assert.ok(!blk.includes("safePublish"), "engine को कभी सीधे publish नहीं करना चाहिए");
    assert.ok(!blk.includes("await publish("), "engine को कभी सीधे publish नहीं करना चाहिए");
  });

  test("engine एक ही दिन दोबारा नहीं चलता", () => {
    const i = SRC.indexOf("async function runDailyEngine");
    assert.ok(SRC.slice(i, i + 2200).includes("already >= wantPosters"), "duplicate protection चाहिए");
  });

  test("engine cost limits मानता है", () => {
    const i = SRC.indexOf("async function runDailyEngine");
    assert.ok(SRC.slice(i, i + 4000).includes("checkAndCountUsage"));
    const j = SRC.indexOf("async function autoPromoVideo");
    assert.ok(SRC.slice(j, j + 1500).includes('checkAndCountUsage(brandId, "videos")'));
  });

  test("engine बंद किया जा सकता है", () => {
    assert.ok(has("dailyEngineOn"));
    assert.ok(SRC.includes('"/api/daily-engine/settings"'));
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
