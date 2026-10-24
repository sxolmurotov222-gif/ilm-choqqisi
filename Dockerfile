FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DATA_DIR=/var/data
COPY package.json ./
COPY server.js ./server.js
COPY public ./public
COPY private ./private
EXPOSE 3000
CMD ["npm", "start"]
