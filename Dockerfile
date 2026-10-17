FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY backend/package.json ./backend/
RUN npm --prefix backend install --omit=dev
COPY backend/ ./backend/
COPY frontend/package.json ./frontend/
RUN npm --prefix frontend install && npm --prefix frontend run build
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node", "backend/server.js"]
