# Copy mail receiver (note #804, certificate since note #807). Build context is this directory.
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /opt/copy-mx
# chmod as a step, not COPY --chmod: CI's release build (note #811) uses the
# classic builder, which has no --chmod.
COPY package.json package-lock.json ./
RUN chmod 0644 package.json package-lock.json && npm ci --omit=dev --no-audit --no-fund
COPY mx.mjs ./
RUN chmod 0644 mx.mjs && node --check mx.mjs
EXPOSE 2525 8080
# The certificate's volume is mounted root-owned; hand it to the node user,
# then run as that user.
CMD ["sh", "-c", "if [ -n \"$CERT_DIR\" ]; then mkdir -p \"$CERT_DIR\" && chown -R node:node \"$CERT_DIR\"; fi; exec su-exec node node /opt/copy-mx/mx.mjs"]
