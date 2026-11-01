# Copy router (note #804): one file, no dependencies. Build context is this directory.
FROM node:22-alpine
# chmod as a step, not COPY --chmod: CI's release build (note #811) uses the
# classic builder, which has no --chmod. A file of mode 600 here would be
# unreadable by the node user.
COPY router.mjs /opt/copy-router/router.mjs
RUN chmod 0644 /opt/copy-router/router.mjs && node --check /opt/copy-router/router.mjs
USER node
EXPOSE 8080
CMD ["node", "/opt/copy-router/router.mjs"]
