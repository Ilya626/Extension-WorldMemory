# Local embeddings (optional)

[WorldMemory](../README.md) · [Русский](LOCAL_EMBEDDINGS_RU.md)

API embeddings are the default. This guide is only for running the optional local embedding service; L0 generation still uses the summarizer connection.

### Optional local EmbeddingGemma 2 Q8

From the installed extension directory on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\local-embeddings.ps1 install
powershell -ExecutionPolicy Bypass -File .\tools\local-embeddings.ps1 start
powershell -ExecutionPolicy Bypass -File .\tools\local-embeddings.ps1 status
```

Select **Search and embeddings → Embedding connection → Local embeddings**. The default **Local embedding URL** is `http://127.0.0.1:8081`; it must be reachable from the browser running ST. The launcher also supports `stop`. The pinned text-only Q8 model is about 310 MB; measured Windows server peak was about 394 MiB RAM, excluding ST/browser and indexing.

Interrupted model/runtime downloads keep a `.part` file. Run `install` again to resume it; the completed download is checked before installation. The Windows installer uses the system `curl.exe`.

Experimental Termux tools are included (`tools/local-embeddings-termux.sh` with `install`, `start`, `status`, `stop`; `tools/start-st-with-memory-termux.sh`). Actual phone installation, autostart, updates and resource qualification remain open; these scripts are not a claim of a qualified Termux release.

For a phone preview, use an existing SillyTavern installation with Node.js and this extension checkout. The example uses ST's default per-user extension folder; a global install uses `$st_dir/public/scripts/extensions/third-party/Extension-WorldMemory` instead.

```bash
st_dir="$HOME/SillyTavern"
addon_dir="$st_dir/data/default-user/extensions/Extension-WorldMemory"
bash "$addon_dir/tools/local-embeddings-termux.sh" install
bash "$addon_dir/tools/start-st-with-memory-termux.sh" "$st_dir"
```

`install` downloads the pinned model and builds the CPU runtime. Thereafter, use the combined launcher to start ST and its local embedding service together. In WorldMemory, choose **Local embeddings** and keep `http://127.0.0.1:8081` when the browser, ST and embedding service run on this phone. With API embeddings, start ST normally; no local model or compiler is required. The local Termux launcher is a preview; qualification on a real phone is deferred.
