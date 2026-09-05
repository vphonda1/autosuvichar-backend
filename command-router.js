// ============================================================================
//  command-router.js — बोलिए, सही पन्ना ख़ुद खुले, सब भरा हुआ   (v1.0)
//  ---------------------------------------------------------------------------
//  server.js के नीचे, app.listen से पहले:
//
//      try {
//        require("./command-router.js")(app, {
//          log, BRANDS, Vehicle, requireRole, mongoose,
//          parseCommandIntent, generateText, cleanAIText,
//        });
//      } catch (e) {
//        log("ERROR", "command-router चालू नहीं हुआ", { msg: e.message });
//      }
//
//  ---------------------------------------------------------------------------
//  ⚠️ असली दिक़्क़त क्या थी
//
//  आपके 9 editors (तुलना, Mega Offer, बुकिंग, Lucky Draw, कई गाड़ियाँ, भर्ती,
//  Delivery, अनाउंसमेंट, Video) तस्वीर **browser में** बनाते हैं।
//  बोलकर दिया आदेश **server पर** चलता है, और server के पास browser नहीं है।
//  इसलिए वह उन layouts को बना ही नहीं सकता था।
//
//  ऊपर से, आदेश समझने वाले को सिर्फ़ 5 तरह पता थीं — सुविचार, विज्ञापन,
//  त्यौहार, सूचना, गिफ़्ट। बाक़ी 9 का उसे कुछ पता ही नहीं था। इसीलिए
//  हर चीज़ के लिए हाथ से पन्ना खोलना पड़ता था।
//
//  ⚠️ अब क्या होता है
//
//  आदेश सुनकर यह तय करता है कि कौन-सा साँचा चाहिए, फिर गाड़ी की सारी
//  जानकारी database से और लिखाई AI से निकालकर **पूरा भरा हुआ draft** बना
//  देता है। App वही editor खोल देता है — सब भरा मिलता है, आपको बस देखकर
//  "भेज दो" दबाना है।
//
//  जो पाँच पुरानी तरह हैं (सुविचार, विज्ञापन, त्यौहार, सूचना, गिफ़्ट) वे
//  पहले की तरह सीधे poster बनाकर Review में चली जाएँगी — कुछ नहीं बदला।
// ============================================================================

"use strict";

module.exports = function mountCommandRouter(app, deps) {
  const {
    BRANDS = {}, Vehicle, requireRole, parseCommandIntent, generateText, cleanAIText,
  } = deps;
  const log = deps.log || ((l, m, x) => console.log(`[${l}] ${m}`, x || ""));
  const L = (m, x) => log("INFO", "[router] " + m, x);
  const bad = (res, e, c = 500) => res.status(c).json({ error: e.message || String(e) });

  // ══════════════════════════════════════════════════════════════════════════
  //  कौन-सा साँचा चाहिए — शब्दों से पहचान
  // ══════════════════════════════════════════════════════════════════════════
  //  AI से नहीं पूछते क्योंकि यह पहचान पक्की होनी चाहिए। शब्द साफ़ हैं,
  //  इसलिए सीधा मिलान ज़्यादा भरोसेमंद है और तेज़ भी।
  const TEMPLATES = [
    { id: "compare", label: "⚖️ तुलना वाला", needs: ["2 गाड़ियाँ"],
      rx: /तुलना|तुलनात्मक|मुक़ाबल|मुकाबल|compare|comparison|बनाम|vs\b|किसका सस्ता|कौन सस्ता|दूसरी कंपनी/ },
    { id: "mega", label: "🔥 Mega Offer", needs: ["1 गाड़ी"],
      rx: /मेगा|महाबचत|महा ऑफ़?र|धमाका|बड़ा ऑफ़?र|mega|blockbuster|बम्पर|बंपर/ },
    { id: "booking", label: "📋 बुकिंग के फ़ायदे", needs: ["1 गाड़ी"],
      rx: /बुकिंग|बुक कर|booking|एडवांस|advance|प्री.?बुक|pre.?book/ },
    { id: "luckydraw", label: "🎉 Lucky Draw", needs: [],
      rx: /लकी|लक्की|ड्रॉ|ड्रा\b|lucky|draw|इनाम|कूपन|कुपन|स्कीम/ },
    { id: "multibike", label: "🏁 कई गाड़ियाँ साथ", needs: ["3+ गाड़ियाँ"],
      rx: /कई गाड़ि|सभी गाड़ि|सारी गाड़ि|multi.?bike|पूरी रेंज|एक साथ.*गाड़ि|तीन गाड़ि|चार गाड़ि/ },
    { id: "hiring", label: "💼 भर्ती", needs: [],
      rx: /भर्ती|भरती|नौकरी|hiring|vacancy|स्टाफ़? चाहिए|काम करने वाल|job/ },
    { id: "delivery", label: "🎥 Delivery post", needs: ["ग्राहक की photo"],
      rx: /डिलीवरी|डिलिवरी|delivery|चाबी\s*(सौंप|दे)|गाड़ी\s*(दी|सौंपी)|नई गाड़ी मुबारक|ग्राहक.*(photo|फ़?ोटो|तस्वीर)|बधाई.*ग्राहक/ },
    { id: "announce", label: "🔊 अनाउंसमेंट", needs: [],
      rx: /अनाउंस|announce|माइक|भोंपू|आवाज़? बना|ऑडियो|audio|बोलकर सुना/ },
    { id: "video", label: "🎬 Video", needs: ["3-5 photo"],
      rx: /वीडियो|विडियो|video|रील|reel/ },
  ];

  const detectTemplate = (t) => {
    const s = String(t || "").toLowerCase();
    return TEMPLATES.find((x) => x.rx.test(s)) || null;
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  गाड़ी ढूँढो — नाम से, वरना जो स्टॉक में है
  // ══════════════════════════════════════════════════════════════════════════
  async function findVehicles(brand, hint, n = 1) {
    const base = { brand, active: true };
    let found = [];

    if (hint) {
      // "Shine 100" जैसा नाम — बीच का हिस्सा भी मिले
      const words = String(hint).split(/\s+/).filter((w) => w.length > 2);
      if (words.length) {
        found = await Vehicle.find({
          ...base,
          $or: words.map((w) => ({ name: { $regex: w, $options: "i" } })),
        }).select("-photoData").limit(n).lean();
      }
    }
    if (found.length < n) {
      // बचे हुए — जिनकी photo लगी है वो पहले, क्योंकि poster उन्हीं से अच्छा बनता है
      const more = await Vehicle.find({
        ...base, inStock: true, _id: { $nin: found.map((f) => f._id) },
      }).select("-photoData").sort({ photoData: -1, updatedAt: -1 }).limit(n - found.length).lean();
      found = found.concat(more);
    }
    return found;
  }

  const money = (x) => (x ? String(x).replace(/^₹?/, "₹") : "");
  const vName = (v) => [v.name, v.variant].filter(Boolean).join(" ");
  const vPhoto = (v, base) => (v.imageUrl ? (/^https?:/.test(v.imageUrl) ? v.imageUrl : base + v.imageUrl) : "");

  // ══════════════════════════════════════════════════════════════════════════
  //  हर साँचे के लिए भरा-भराया draft
  // ══════════════════════════════════════════════════════════════════════════
  async function buildDraft(tplId, brand, intent, publicUrl) {
    const b = BRANDS[brand] || {};
    const hint = intent.vehicle || "";
    const offer = intent.offer_details || "";
    // ⚠️ BRANDS में "sub" नहीं है — असली नाम "place" और "company" हैं।
    //    ग़लत नाम माँगने पर दुकान की लाइन ख़ाली रह जाती।
    const shop = {
      shopName: b.name || "",
      shopSub: b.sub || b.place || "",
      phone: b.phone || b.whatsapp || "",
    };

    if (tplId === "compare") {
      const vs = await findVehicles(brand, hint, 2);
      return {
        ...shop,
        h1: "स्मार्ट चुनाव,", h2: "कम खर्च।",
        body: `${b.name || "हमारे"} के साथ हर सफ़र\nबने |आसान और भरोसेमंद।`,
        badge: "कम सर्विस चार्ज, ज़्यादा भरोसा।",
        colA: "कंपनी", colB: "क़ीमत (₹)",
        rows: vs.length
          ? vs.map((v, i) => ({ a: vName(v), b: String(v.exShowroom || "").replace(/[₹,]/g, ""), hi: i === 0 }))
          : [{ a: "", b: "", hi: true }],
        footLine: `${b.name || ""} - |कम ख़र्च, ज़्यादा बचत, हर बार।`,
        v1: vs[0] ? { img: vPhoto(vs[0], publicUrl), name: vName(vs[0]), noPhoto: !vs[0].imageUrl } : null,
        v2: vs[1] ? { img: vPhoto(vs[1], publicUrl), name: vName(vs[1]), noPhoto: !vs[1].imageUrl } : null,
      };
    }

    if (tplId === "mega" || tplId === "booking") {
      const [v] = await findVehicles(brand, hint, 1);
      if (!v) return { ...shop, _warn: "इस brand की कोई गाड़ी सूची में नहीं मिली" };
      return {
        ...shop,
        headline: tplId === "mega" ? "महाबचत\nमहीना" : "बुकिंग\nमहोत्सव",
        mainTitle: vName(v),
        subTitle: [money(v.downPayment) && `डाउन पेमेंट ${money(v.downPayment)}`,
                   money(v.emi) && `EMI ${money(v.emi)}`].filter(Boolean).join(" · ") || offer,
        bikeImg: vPhoto(v, publicUrl),
        vehicleName: vName(v),
        price: money(v.exShowroom), onRoad: money(v.onRoad),
        downPayment: money(v.downPayment), emi: money(v.emi), roi: v.roi || "",
        cashback: money(v.cashback), exchangeBonus: money(v.exchangeBonus),
        offerNote: v.offerNote || offer,
        _warn: v.imageUrl ? "" : `"${vName(v)}" की photo सेव नहीं है — poster में गाड़ी नहीं आएगी`,
      };
    }

    if (tplId === "multibike") {
      const vs = await findVehicles(brand, hint, 4);
      return {
        ...shop,
        headline: "हमारी पूरी रेंज",
        bikes: vs.map((v) => ({
          img: vPhoto(v, publicUrl), name: vName(v),
          price: money(v.exShowroom), emi: money(v.emi),
        })),
        _warn: vs.filter((v) => !v.imageUrl).length
          ? `${vs.filter((v) => !v.imageUrl).length} गाड़ियों की photo सेव नहीं है`
          : "",
      };
    }

    if (tplId === "luckydraw") {
      const vs = await findVehicles(brand, hint, 2);
      return {
        ...shop,
        headline: "लकी ड्रॉ",
        subTitle: offer || "ख़रीदिए और इनाम जीतिए",
        bikes: vs.map((v) => ({ img: vPhoto(v, publicUrl), name: vName(v) })),
      };
    }

    if (tplId === "hiring") {
      return {
        ...shop,
        headline: "हमें चाहिए",
        roles: intent.custom_text || offer || "सेल्स एक्ज़ीक्यूटिव · मैकेनिक",
        address: b.place || "", phone: shop.phone,
      };
    }

    if (tplId === "delivery") {
      return {
        ...shop,
        customerName: intent.customer_name || "",
        bikeName: hint || "",
        text: intent.custom_text || "",
        _warn: "ग्राहक की photo आपको डालनी होगी — वो बोलकर नहीं दी जा सकती",
      };
    }

    if (tplId === "announce") {
      let txt = intent.custom_text || "";
      if (!txt && generateText) {
        try {
          const r = await generateText(
            `${b.name || "शोरूम"} के लिए माइक पर बजाने लायक़ 2-3 लाइन का अनाउंसमेंट लिखो। ` +
            `बात: ${intent.command || offer || "आज विशेष ऑफ़र"}. सिर्फ़ बोलने का text दो, कुछ और नहीं.`,
            { brand }
          );
          txt = cleanAIText ? cleanAIText(r) : r;
        } catch (_) {}
      }
      return { text: String(txt || "").slice(0, 600), preset: "market" };
    }

    if (tplId === "video") {
      return {
        ...shop,
        headline: intent.custom_text || "बधाई हो!",
        _warn: "3-5 photo आपको डालनी होंगी",
      };
    }
    return shop;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTE
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/command/route", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const text = String(req.body?.command || "").trim();
      if (!text) return bad(res, new Error("कुछ कहा ही नहीं"), 400);

      const tpl = detectTemplate(text);

      // ── पुरानी पाँच तरह — कुछ नहीं बदला, सीधे poster बनेगा ──
      if (!tpl) {
        return res.json({
          route: "auto",
          message: "यह सीधे poster बनकर Review में चला जाएगा",
        });
      }

      // ── नया रास्ता — सही editor, भरा हुआ ──
      let intent = {};
      try {
        intent = (await parseCommandIntent(text, req.body.brand)) || {};
      } catch (e) {
        log("WARN", "[router] command समझने में दिक़्क़त, फिर भी आगे बढ़े", { msg: e.message });
      }

      const brand = BRANDS[intent.brand] ? intent.brand
        : (BRANDS[req.body.brand] ? req.body.brand : Object.keys(BRANDS)[0]);

      const publicUrl = deps.PUBLIC_URL || "";
      const draft = await buildDraft(tpl.id, brand, { ...intent, command: text }, publicUrl);

      L("आदेश समझा", { tpl: tpl.id, brand, veh: intent.vehicle || "—" });

      res.json({
        route: "editor",
        template: tpl.id,
        label: tpl.label,
        brand,
        draft,
        warn: draft._warn || "",
        needs: tpl.needs,
        message: `${tpl.label} खुल रहा है — सब भरा हुआ मिलेगा`,
      });
    } catch (e) {
      log("ERROR", "[router] fail", { msg: e.message });
      bad(res, e);
    }
  });

  /** कौन-कौन से साँचे बोलकर खुल सकते हैं */
  app.get("/api/command/templates", (req, res) => {
    res.json({
      templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, needs: t.needs })),
      auto: ["suvichar", "vigyapan", "festival", "suchna", "gift"],
      note: "बाक़ी सब सीधे poster बनकर Review में जाता है",
    });
  });

  L("आदेश का रास्ता चालू — 9 साँचे अब बोलकर खुलेंगे");
  return { detectTemplate, buildDraft, TEMPLATES };
};
