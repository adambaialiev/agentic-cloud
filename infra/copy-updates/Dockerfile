# Our update service for private copies (note #811). Built from a staged
# context (infra/copy-updates/stage.sh) so the signing module it shares with
# the issuing command ships byte for byte.
FROM node:22-alpine
WORKDIR /app
COPY copy-release/signed.mjs copy-release/signing-key.pub copy-release/notes.mjs copy-release/
# Notes for releases cut before notes rode in the release image (note #1006).
COPY copy-release/notes copy-release/notes
COPY copy-updates/server.mjs copy-updates/
# Readable by the node user whatever modes the files were staged with: a
# file of mode 600 copied in stays 600 and the service cannot open it.
RUN chmod -R a+rX /app && node --check copy-updates/server.mjs
USER node
ENV PORT=8080
CMD ["node", "copy-updates/server.mjs"]
