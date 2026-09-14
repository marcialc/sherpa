# Keep this tag exactly aligned with the @cloudflare/sandbox package.
FROM docker.io/cloudflare/sandbox:0.12.9 AS bubblewrap-build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential meson ninja-build pkg-config libcap-dev curl ca-certificates xz-utils \
    && curl -fsSL https://github.com/containers/bubblewrap/releases/download/v0.12.0/bubblewrap-0.12.0.tar.xz -o /tmp/bubblewrap.tar.xz \
    && echo '9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314  /tmp/bubblewrap.tar.xz' | sha256sum -c - \
    && tar -xJf /tmp/bubblewrap.tar.xz -C /tmp \
    && meson setup /tmp/bubblewrap-build /tmp/bubblewrap-0.12.0 --buildtype=release \
       -Dtests=false -Dman=disabled -Dselinux=disabled -Dbash_completion=disabled -Dzsh_completion=disabled \
    && meson compile -C /tmp/bubblewrap-build
FROM docker.io/cloudflare/sandbox:0.12.9
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libcap2 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts pnpm@9.12.1 yarn@1.22.22 \
    && python3 -m venv /opt/sherpa/semgrep \
    && /opt/sherpa/semgrep/bin/pip install --no-cache-dir semgrep==1.177.0 \
    && mkdir -p /workspace/sherpa/evidence /tmp/sherpa-home \
    && chmod 755 /workspace/sherpa
COPY semgrep-rules.yml /opt/sherpa/semgrep-rules.yml
COPY --from=bubblewrap-build /tmp/bubblewrap-build/bwrap /usr/local/bin/bwrap
# The SDK supplies ENTRYPOINT. Never bake application secrets into this image.
