"""Tidy-up for provider environment variables before any client is built.

The dev sandbox passes provider variables through ``docker-compose.yaml``, and
Compose substitutes an empty string for anything the host has not set
(``${OPENAI_BASE_URL:-}``). For most variables that is harmless because the
application also defaults them to empty. It is not harmless for the one below.

``OPENAI_BASE_URL`` is read by the OpenAI SDK itself, and it distinguishes
*absent* from *empty*:

.. code-block:: python

    base_url = os.environ.get("OPENAI_BASE_URL")
    if base_url is None:
        base_url = "https://api.openai.com/v1"

An empty string is not ``None``, so it survives that check and becomes the
client's base URL. Every request then fails with a bare ``APIConnectionError``
("Connection error.") against no host at all — verified against the installed
SDK, openai 3.8.0.

So the sandbox's perfectly reasonable-looking empty default has to be undone
before a client exists. Dropping the variable restores the SDK default, which
is what "not configured" is supposed to mean.
"""

import os

# Variables whose absence is the meaningful state, so a blank value must be
# treated as absence rather than passed through to a library that will use it.
#
# Deliberately an explicit list rather than a blanket "strip every blank var":
# for most of these variables a blank value is exactly the app's own default
# and is already handled where it is read.
_ABSENT_WHEN_BLANK = ("OPENAI_BASE_URL",)


def drop_blank_provider_vars() -> None:
    """Remove provider variables that are set but blank.

    Idempotent — a variable that is already absent is a no-op — so it is safe to
    call from every module that builds a client, and safe to call twice in one
    process.

    Values that are merely padded (``"  "``) are dropped too: whitespace is not
    a URL. Non-blank values are left exactly as they are, including their
    surrounding characters, because rewriting a configured value is not this
    function's business.
    """
    for name in _ABSENT_WHEN_BLANK:
        if os.environ.get(name, "").strip() == "":
            os.environ.pop(name, None)
