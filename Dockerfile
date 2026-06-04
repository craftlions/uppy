FROM debian:13-slim
COPY --from=docker.io/cloudflare/sandbox:0.10.3 /container-server/sandbox /sandbox

RUN apt-get update  \
    && apt-get -y --no-install-recommends install  \
        # install any other dependencies you might need
        sudo curl git ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV MISE_VERSION="2026.5.16"

RUN curl https://mise.run | sh
RUN mise install --system aube@1.16.1

RUN mkdir -p /workspace

EXPOSE 3000
ENTRYPOINT ["/sandbox"]