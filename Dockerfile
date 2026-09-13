# AutoSuVichar backend — Render पर Docker के रूप में deploy करें
# इससे ffmpeg (video) और Devanagari font (हिंदी image) दोनों मिल जाते हैं।
FROM node:20-bookworm-slim

# ffmpeg + हिंदी/Indic fonts + इमोजी font install
#  ⚠️ पहले सिर्फ़ fonts-noto-core + fonts-indic थे — कोई भी रंगीन इमोजी
#     (🌹🌸🌺 वग़ैरह) font सिस्टम में था ही नहीं। poster की तस्वीर (SVG से
#     बनती है) में जब कोई इमोजी दिखानी होती और उसका glyph किसी font में
#     मिलता ही नहीं, तो renderer (librsvg) उसकी जगह उसका Unicode कोड टेक्स्ट
#     के तौर पर दिखा देता था — "01F339" जैसा, इमोजी की जगह। यही screenshot
#     में "गणेश चतुर्थी" वाले poster पर दिखा था।
#  fonts-noto-color-emoji जोड़ने से हर इमोजी सही रंगीन ग्लिफ़ के साथ दिखेगी।
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-noto-core \
      fonts-noto-color-emoji \
      fonts-indic \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# पहले deps (caching के लिए)
COPY package*.json ./
RUN npm install --omit=dev

# बाक़ी code
COPY . .

# Render PORT env खुद देता है; server.js उसे पढ़ लेता है
EXPOSE 5000
CMD ["node", "server.js"]
