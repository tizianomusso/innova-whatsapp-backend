# Imagen base preparada para Puppeteer / Chrome
FROM ghcr.io/puppeteer/puppeteer:latest

# Carpeta de trabajo dentro del contenedor
WORKDIR /app

# Copiamos solo package.json / package-lock para cachear dependencias
COPY package*.json ./

# Instalamos dependencias en modo producción
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . .

# Variables estándar
ENV NODE_ENV=production
ENV PORT=8080

# Opcional: evitamos que puppeteer descargue otro Chrome
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Puerto expuesto
EXPOSE 8080

# Comando de inicio
CMD ["npm", "start"]
