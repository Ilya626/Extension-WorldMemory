# Source notices

The current standalone WorldMemory build is distributed under the GNU Affero
General Public License, version 3. See [LICENSE](LICENSE).

## Summaryception

The modules in `vendor/summaryception/` are adapted from
[Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception)
and the [Ilya626 maintained fork](https://github.com/Ilya626/Extension-Summaryception).
Their source license is retained in [vendor/summaryception/LICENSE](vendor/summaryception/LICENSE).

`history-injection.js` also adapts Summaryception's prompt-placement logic.
The source/context/transport/parser helpers have been integrated with a growing
archive and selective retrieval; the old layer-promotion runtime is not executed.

Earlier WorldMemory code carried the MIT notice retained in
[vendor/worldmemory-original-MIT.txt](vendor/worldmemory-original-MIT.txt).

## Optional services and models

Russian WI Forms is a separate extension. Embedding model weights and llama.cpp
are downloaded separately by the optional launchers and are not bundled in this
repository. Their respective source notices and model terms remain applicable.
