#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

action=${1:-status}
model_dir="$HOME/.local/share/st-addon-models/embeddinggemma-2"
runtime_dir="$HOME/.local/share/st-addon-runtime/llama-b11982"
state_dir="$HOME/.local/state/st-addon-embeddinggemma2"
model="$model_dir/embeddinggemma-2-Q8_0.gguf"
binary="$runtime_dir/build/bin/llama-server"
state="$state_dir/server.pid"
model_sha=2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135
commit=8a199ad31a7eb27d5a46a6b08026176d82bc9894
endpoint=http://127.0.0.1:8081
threads=${ST_EMBED_THREADS:-4}
case "$threads" in ''|*[!0-9]*|0) echo 'ST_EMBED_THREADS must be a positive integer' >&2; exit 1;; esac

health() { command -v curl >/dev/null && curl -fsS --max-time 2 "$endpoint/health" 2>/dev/null | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; }
owned() {
    [[ -f "$state" ]] || return 1
    read -r owned_pid owned_start < "$state"
    [[ "$owned_pid" =~ ^[0-9]+$ && "$owned_start" =~ ^[0-9]+$ && -r "/proc/$owned_pid/stat" ]] || return 1
    [[ "$(readlink "/proc/$owned_pid/exe" 2>/dev/null)" == "$binary" ]] || return 1
    [[ "$(awk '{print $22}' "/proc/$owned_pid/stat")" == "$owned_start" ]] || return 1
    kill -0 "$owned_pid" 2>/dev/null
}
status() {
    local managed=no healthy=no
    if owned; then managed=yes; fi
    if health; then healthy=yes; fi
    printf 'endpoint=%s managed=%s healthy=%s state=%s\n' "$endpoint" "$managed" "$healthy" "$state"
}
install() {
    command -v pkg >/dev/null || { echo 'Run this installer inside native Termux.' >&2; exit 1; }
    pkg install -y clang cmake ninja git curl coreutils procps
    mkdir -p "$model_dir" "$state_dir"
    if [[ ! -f "$model" ]]; then
        curl --fail --location --retry 3 --continue-at - --output "$model.part" "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/58faf90940886df2d62be555c8765d00dac362c5/embeddinggemma-2-Q8_0.gguf"
        printf '%s  %s\n' "$model_sha" "$model.part" | sha256sum --check --status
        mv "$model.part" "$model"
    fi
    printf '%s  %s\n' "$model_sha" "$model" | sha256sum --check --status
    if [[ ! -d "$runtime_dir/.git" ]]; then
        git clone --depth 1 --branch b11982 https://github.com/ggml-org/llama.cpp.git "$runtime_dir"
    fi
    [[ "$(git -C "$runtime_dir" rev-parse HEAD)" == "$commit" ]] || { echo 'Expected pinned b11982 source commit.' >&2; exit 1; }
    if [[ ! -x "$binary" ]]; then
        cmake -S "$runtime_dir" -B "$runtime_dir/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
            -DGGML_CUDA=OFF -DGGML_VULKAN=OFF -DGGML_METAL=OFF -DGGML_OPENCL=OFF \
            -DGGML_OPENMP=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF
        cmake --build "$runtime_dir/build" --target llama-server --parallel "$threads"
    fi
    "$binary" --version
    status
}
start() {
    if owned; then status; return; fi
    [[ -x "$binary" && -f "$model" ]] || { echo 'Run install first.' >&2; exit 1; }
    # Any HTTP responder on this port belongs to its existing launcher. Do not adopt it.
    local code
    code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "$endpoint/health" || true)
    if [[ "$code" != 000 ]]; then status; return; fi
    mkdir -p "$state_dir"
    nohup "$binary" -m "$model" --no-mmproj --embeddings --pooling mean --embd-normalize 2 \
        --host 127.0.0.1 --port 8081 -ngl 0 -c 2048 -b 2048 -ub 2048 -np 1 \
        -t "$threads" -tb "$threads" > "$state_dir/server.log" 2>&1 < /dev/null &
    local child=$! stamp
    stamp=$(awk '{print $22}' "/proc/$child/stat")
    printf '%s %s\n' "$child" "$stamp" > "$state.tmp"
    mv "$state.tmp" "$state"
    for ((i=0; i<60; i++)); do
        owned || { echo "Owned server exited; see $state_dir/server.log" >&2; exit 1; }
        if health; then status; return; fi
        sleep 1
    done
    echo "Owned server is not healthy yet; see $state_dir/server.log; use status or stop." >&2
    exit 1
}
stop() {
    if owned; then
        kill -TERM "$owned_pid"
        for ((i=0; i<10; i++)); do if ! owned; then break; fi; sleep 1; done
        if owned; then echo 'Owned server did not exit; no forced kill performed.' >&2; exit 1; fi
    fi
    rm -f "$state"
    status
}
case "$action" in
    install) install;; start) start;; stop) stop;; status) status;;
    *) echo 'Usage: bash local-embeddings-termux.sh {install|start|stop|status}' >&2; exit 1;;
esac
