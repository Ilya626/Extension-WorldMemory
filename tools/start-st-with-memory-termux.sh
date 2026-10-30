#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
st_dir=${1:-"$HOME/SillyTavern"}
if [[ $# -gt 0 ]]; then shift; fi

[[ -f "$st_dir/server.js" ]] || {
    printf 'SillyTavern not found: %s\nUsage: bash %s /path/to/SillyTavern [server options]\n' "$st_dir" "$0" >&2
    exit 1
}
command -v node >/dev/null || { echo 'Node.js is required by SillyTavern.' >&2; exit 1; }
bash "$script_dir/local-embeddings-termux.sh" start
cd -- "$st_dir"
exec node server.js "$@"
