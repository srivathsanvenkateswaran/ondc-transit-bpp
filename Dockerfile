FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

# ── Server ────────────────────────────────────────────────────────────────────
ENV NODE_ENV=production \
    PROVIDER_HOST=0.0.0.0 \
    PROVIDER_PORT=7001 \
    PROVIDER_PUBLIC_BASE_URL=http://localhost:7001 \
    JOURNEY_SOURCE=fixture \
    CALLBACK_TIMEOUT_MS=3000 \
    CONTEXT_TTL=PT30S

# ── BMTC operator ─────────────────────────────────────────────────────────────
ENV BMTC_BPP_ID=bmtc.bpp.transit.localhost \
    BMTC_BPP_URI=http://localhost:6002 \
    BMTC_CALLBACK_URL=http://localhost:6001/on_search \
    BMTC_CALLBACK_DELAY_MS=0

# ── BMRCL operator ────────────────────────────────────────────────────────────
ENV BMRCL_BPP_ID=bmrcl.bpp.transit.localhost \
    BMRCL_BPP_URI=http://localhost:6102 \
    BMRCL_CALLBACK_URL=http://localhost:6101/on_search \
    BMRCL_CALLBACK_DELAY_MS=0

# ── KSRTC operator, reserved intercity ────────────────────────────────────────
# A second domain, TRANSIT.LOCALHOST:INTERCITY at 0.1.0. Off by default: it
# needs a second registry subscription and a second network domain in the
# registry, and an image that switched it on by default would start a seller
# nobody had registered.
ENV RESERVED_ENABLED=false \
    KSRTC_BPP_ID=ksrtc.bpp.transit.localhost \
    KSRTC_BPP_URI=http://localhost:6202 \
    KSRTC_CALLBACK_URL=http://localhost:6201/on_search \
    KSRTC_CALLBACK_DELAY_MS=0

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY fixtures ./fixtures
COPY schemas ./schemas
RUN chown -R node:node /app
USER node

EXPOSE 7001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PROVIDER_PORT||process.env.PORT||7001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
