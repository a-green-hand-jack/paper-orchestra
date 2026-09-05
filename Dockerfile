# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY tsconfig.json ./
COPY scripts/copy-runtime-assets.mjs scripts/copy-runtime-assets.mjs
COPY src/ src/
RUN npm run build && npm shrinkwrap && npm pack --loglevel=error --pack-destination /tmp

FROM ${NODE_IMAGE} AS runtime
ARG DEBIAN_SNAPSHOT=20260901T000000Z
ARG OPENCODE_VERSION=1.18.29
ARG CODEX_VERSION=0.153.4
ARG BOHR_VERSION=2.6.86
ARG HF_VERSION=1.30.0
# A dated, signed Debian snapshot pins the complete apt dependency closure.
RUN printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
    && rm /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git procps unzip \
       texlive-latex-extra texlive-fonts-recommended texlive-science texlive-publishers \
       texlive-bibtex-extra biber latexmk poppler-utils python3 python3-numpy python3-matplotlib python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g --registry=https://registry.npmjs.org \
      "opencode-ai@${OPENCODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "@dptech-corp/bohr-cli@${BOHR_VERSION}" \
    && npm cache clean --force
COPY docker/hf-constraints.txt /opt/hf-constraints.txt
RUN python3 -m venv /opt/hf \
    && /opt/hf/bin/pip install --no-cache-dir --index-url https://pypi.org/simple -c /opt/hf-constraints.txt "huggingface_hub==${HF_VERSION}" \
    && ln -s /opt/hf/bin/hf /usr/local/bin/hf
COPY --from=build /tmp/paper-orchestra-*.tgz /opt/package/
RUN npm install --prefix /opt --save-exact --registry=https://registry.npmjs.org @ai-sdk/openai@3.0.84 \
    && npm ls --prefix /opt --all --json > /opt/package/provider-packages.json \
    && npm cache clean --force
RUN npm install -g --registry=https://registry.npmjs.org /opt/package/paper-orchestra-*.tgz \
    && test -f /usr/local/lib/node_modules/paper-orchestra/npm-shrinkwrap.json \
    && npm cache clean --force \
    && mkdir -p /opt/acceptance /output /materials /run/secrets /home/runner \
    && chown 1000:1000 /output /home/runner \
    && dpkg-query -W > /opt/package/debian-packages.txt \
    && npm ls -g --all --json > /opt/package/npm-packages.json \
    && /opt/hf/bin/pip freeze > /opt/package/hf-packages.txt
COPY docker/entrypoint.mjs docker/acceptance.mjs docker/recompile.mjs docker/user-command.mjs /opt/acceptance/
COPY docker/oauth-provider.mjs /opt/po-provider/provider.mjs
ENV HOME=/home/runner XDG_CONFIG_HOME=/home/runner/.config XDG_DATA_HOME=/home/runner/.local/share XDG_CACHE_HOME=/home/runner/.cache CODEX_HOME=/home/runner/.codex MPLBACKEND=Agg CI=1
ENV BOHR_CONFIG_DIR=/home/runner/.bohr HF_HOME=/home/runner/.cache/huggingface HF_TOKEN_PATH=/home/runner/.cache/huggingface/token HF_ENDPOINT=https://huggingface.co HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_UPDATE_CHECK=1
USER 1000:1000
WORKDIR /output
ENTRYPOINT ["node", "/opt/acceptance/entrypoint.mjs"]
CMD ["paper-orchestra", "--help"]
