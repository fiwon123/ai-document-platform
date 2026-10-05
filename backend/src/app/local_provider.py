"""Configuration for the keyless local, OpenAI-compatible model server.

Read here rather than in ``app.services.qa`` because two providers need it —
the chat provider and the embedding provider — and ``embedding`` cannot import
``qa``: ``qa`` imports ``app.services.search``, which imports
``app.services.embedding``, so the cycle would close on import.

One module owns "is a local server configured, and where" precisely so there is
one answer. Two independent ``os.getenv`` reads would be free to disagree, and
the failure would be silent rather than loud: chat would answer from one server
while embeddings were written to another, so the two halves of the same
document set would live in different embedding spaces without anything
reporting it.
"""

import os

# The OpenAI SDK refuses to build a client without a key, even when the
# endpoint ignores it. Local servers do ignore it, so a placeholder is passed
# through and never leaves the machine.
LOCAL_PLACEHOLDER_KEY = "local-no-key"

# Opt-in rather than probed: discovering a local server would mean a network
# call, and a probe that fails (or that succeeds and is then cached stale)
# would either add latency to every request or route work to a dead endpoint.
# Requiring LOCAL_LLM_ENABLED means "I am running a local model server" is
# something the operator states.
LOCAL_LLM_ENABLED = os.getenv("LOCAL_LLM_ENABLED", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# Ollama's default port, since Ollama is the server this exists for.
#
# Blank-safe in the same way every other read here is: a value that is set but
# empty is absence, not a URL. Compose's `${VAR:-default}` already substitutes
# the default for an unset variable, but a Kubernetes ConfigMap or a shell
# export can and does set one to "" — and the OpenAI SDK distinguishes absent
# from empty, so "" would become the client's base_url and every call would
# fail with a bare "Connection error." against no host at all. The default is
# therefore applied at the point of the read, rather than relying on some other
# module's import-time cleanup having run first: this module is imported *before*
# `app.services.embedding` calls `drop_blank_provider_vars()`, so a cleanup
# there would arrive too late to matter.
LOCAL_LLM_BASE_URL = (
    (os.getenv("LOCAL_LLM_BASE_URL", "") or "").strip()
    or "http://localhost:11434/v1"
)
