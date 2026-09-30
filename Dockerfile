FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER pwuser
CMD ["node", "server.js"]
