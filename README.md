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

**Waiting on a reply** means two things, and the second one is easy to leave
out: the last message in the chat is the company's, *and* the AI has not already
drafted something for that message. A suggestion is not a message — using one
writes a reply into the chat, dismissing one does not — so without that second
condition the chat looks exactly as unanswered after a suggestion as before it,
and the agent drafts another one every polling round for as long as the operator
leaves it alone. Each round is two model calls, which on a cloud model is
somebody's quota. `ai_suggestions.message_id` records which message a suggestion
answers, and `get_pending` skips a chat whose newest message already has one.

The status of that suggestion deliberately does not matter. **Dismissing is "I
will handle this myself"**, not "try again": the agent stays away until the
company sends something new, which gives the chat a new last message and puts it
back in the queue by itself.

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
| `RANSOM_BTC` | `4` | Opening demand — match it to the ransom note participants receive |
| `FLOOR_BTC` | `2` | The negotiator never goes below this, and neither does its output validation |

Any of them also reads from `<NAME>_FILE`, which takes precedence over both —
so `API_KEY_FILE=/run/secrets/ai-api-key` keeps the key out of the process
environment and out of any file that gets committed.

**Every model in `LLM_MODELS` runs for every open negotiation** and sends a
suggestion of its own, so a second model doubles the wait before an operator
sees anything. On CPU-only hardware that is the difference between useful and
unusable — start with one small model and measure.

A model named `…-cloud` runs on Ollama's machines rather than yours, and needs
outbound internet to do it.

**The negotiator needs a model that can hold a role.** Measured against the same
transcript, `qwen2.5:1.5b` echoes the prompt back, misreads a plain question as
an attack and invents prices; `gpt-oss:120b-cloud` negotiates, concedes on
schedule and hands over the wallet the moment a deal is struck. Reasoning models
count their thinking against `num_predict`, which is why it is set generously in
`negotiator.py` — at 260 tokens `gpt-oss:120b` never got past thinking and
returned nothing at all.

### How the negotiator works

`negotiator.py` holds the conversation logic and `process_ai_feedback.py` the
polling loop, so the first is testable without a server. One turn runs five
layers, each assuming the one before it may have failed:

| Layer | What it does |
|-------|--------------|
| `scan_injection()` | Regex over the company's last message. No model, so it cannot be talked out of it |
| `observe()` | One JSON call at temperature 0: classifies the message and folds older messages into the summary. Plays no role and follows no instruction |
| `decide_phase()` | **Python** decides where the negotiation stands. The model never touches the price, the floor or whether a deal exists |
| `compose()` | The only call that plays a character, steered by one directive for the current phase |
| `validate_output()` | Discards prompt leaks, broken character, capitulation, prices below the ask, and near-repeats of an earlier message |

Discarding is deliberate: a missing suggestion is a visible gap the operator
notices, while a negotiator that quietly stepped out of character is not.

**The conversation travels as a summary plus the last four messages verbatim,
not as a full transcript.** That keeps the prompt the same size at message
eighty as at message eight, and it means an injection in message three stops
travelling along after a few turns instead of forever. The summary is memory,
never authority — the price, the floor and any agreement live in state that
Python owns, so a poisoned summary cannot change the negotiation.

That state is stored per chat in `negotiation_state` and **only becomes canonical
when its message is actually sent**. Every model in `LLM_MODELS` proposes its own
summary alongside its suggestion; the one belonging to a suggestion the operator
dismisses is dropped with it.

### Prompt injection

Participants will try to break the simulation rather than play it — "ignore all
previous instructions", a pasted `SYSTEM:` line, or a fake transcript line that
looks like a message from the hacker. None of it is acted on.

Nothing is blocked and nothing is scored. A detected attempt routes the
negotiator to a directive that has it stay fully in character and let the other
side know the trick did not work, and the operator's suggestion panel shows an
amber note so they read that one suggestion carefully before sending it.

The layers matter separately: in testing, the regex layer caught a code-fence
hijack and a "which model are you?" probe that the model itself had classified
as harmless. The reverse also happens, which is why both feed the same decision.

Two structural defences sit underneath. The API sends messages as a `messages`
array rather than only a flat transcript, so a company typing
`[21:10] DarkNet Operator: …` cannot pose as the other party — in a flat
transcript that line is indistinguishable from a real one. And each turn wraps
untrusted text in a random sentinel that the prompt names as data, so it cannot
be imitated from inside a message.

Residual risk worth naming: if the regex misses an attempt *and* the model
misses it, the message is composed against normally. `validate_output()` is the
last net, and `auto_reply` is the setting that removes the human one — with it
on, model output reaches participants with nobody in between.

### As a container

```sh
docker build -t darkwebchat-ai:latest -f bin/Dockerfile .
```

The build context is the project, not `bin/` — see the comment at the top of
`bin/Dockerfile`. The agent speaks this application's API, so the two are built
from the same commit on purpose.
