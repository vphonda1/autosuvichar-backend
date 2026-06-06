# AutoSuVichar backend — Render पर Docker के रूप में deploy करें
# इससे ffmpeg (video) और Devanagari font (हिंदी image) दोनों मिल जाते हैं।
FROM node:20-bookworm-slim

# ffmpeg + हिंदी/Indic fonts install
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-noto-core \
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
