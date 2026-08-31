# darkwebchat

Simulating a dark web chat as if it are real hackers for education purposes.

## Running it

```sh
npm ci
node index.js          # http://localhost:3000
```

The first visit to `/setup.html` creates the initial operator account; until one
exists the dashboard cannot be entered.

## Configuration

All of it optional — the defaults are the ones you want on a laptop.

| Variable | Default | What it does |
|----------|---------|--------------|
| `PORT` | `3000` | Port the HTTP server listens on |
| `DB_FILE` | `./game.db` | Where the SQLite database lives |
| `GAME_DURATION_HOURS` | `4` | Length of the exercise |
| `GAME_DEADLINE` | *(unset)* | Absolute UTC deadline, e.g. `2026-10-30T16:00:00Z` |

`DB_FILE` and `GAME_DEADLINE` both exist for the same reason: a container that
restarts should not lose the game or silently extend it.

Without `GAME_DEADLINE` the clock counts down from process start, so restarting
the server mid-exercise hands everyone another four hours. Set it once the date
is known and a restart changes nothing.

`DB_FILE` holds tokens, operators, sessions and the full conversation history.
Point it at a mounted volume in a container — left inside the image layer, every
update wipes the exercise.

## Docker

```sh
docker build -t darkwebchat:latest .
docker run --rm -p 3000:3000 -v darkwebchat-data:/data darkwebchat:latest
```

The image builds on `node:22` (LTS) rather than a current release: `better-sqlite3`
ships prebuilt binaries per Node ABI, and on a release without one the install
falls back to compiling from source — or fails. Dependencies are installed with
`npm ci`, so the build is reproducible from `package-lock.json`.

The application makes **no outbound network calls** and loads no assets from a
CDN: everything under `www/` is served locally, including the socket.io client.
It therefore runs unchanged on a network with no internet access at all, which is
how it is deployed as a Tor onion service.

## AI suggestions

`bin/process_ai_feedback.py` polls the REST API for negotiations waiting on a
reply, has an Ollama model draft one, and posts it back as a suggestion an
operator can use or ignore. It is optional — the chat works fully without it.

```sh
pip install -r bin/requirements.txt
cp bin/config.py.sample bin/config.py     # then fill in API_KEY
python bin/process_ai_feedback.py
```

The API key is created in the dashboard under the **API** tab.

### Configuration

Same settings, two sources: an **environment variable wins**, otherwise the
value comes from `bin/config.py`. That order is what lets the container be
configured entirely through the environment while a checkout with a
`bin/config.py` keeps working as it did.

| Variable | Default | What it does |
|----------|---------|--------------|
| `API_KEY` | *(required)* | Key from the dashboard's API tab |
| `BASE_URL` | `http://localhost:3000/api` | This application's REST endpoint |
| `OLLAMA_URL` | `http://localhost:11434/api/generate` | Ollama's generate endpoint |
| `LLM_MODELS` | `qwen2.5:1.5b` | Comma-separated in the environment, a list in `config.py` |
| `POLL_INTERVAL` | `30` | Seconds between polls |

Any of them also reads from `<NAME>_FILE`, which takes precedence over both —
so `API_KEY_FILE=/run/secrets/ai-api-key` keeps the key out of the process
environment and out of any file that gets committed.

**Every model in `LLM_MODELS` runs for every open negotiation** and sends a
suggestion of its own, so a second model doubles the wait before an operator
sees anything. On CPU-only hardware that is the difference between useful and
unusable — start with one small model and measure.

A model named `…-cloud` runs on Ollama's machines rather than yours, and needs
outbound internet to do it.

### As a container

```sh
docker build -t darkwebchat-ai:latest -f bin/Dockerfile .
```

The build context is the project, not `bin/` — see the comment at the top of
`bin/Dockerfile`. The agent speaks this application's API, so the two are built
from the same commit on purpose.
