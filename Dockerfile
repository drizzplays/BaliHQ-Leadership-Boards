FROM node:20-alpine
RUN apk add --no-cache fontconfig ttf-dejavu
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["npm", "start"]
