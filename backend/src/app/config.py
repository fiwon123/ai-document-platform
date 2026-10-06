"""Startup validation for security-critical configuration.

Lives in its own module because two call sites need it and neither can own it:
``app.main`` validates once in the lifespan (what an operator sees first), and
``app.routes.auth`` guards at import time so that importing the auth code
anywhere enforces the same rule. Importing the check from either would create a
cycle, so the logic is here once and both call it.
"""

import os

# Every JWT signing key this repository publishes. They are not secrets: they are
# in git, so anyone who can read the repo can mint an access token for any user
# id, and because a forged token is never tracked server-side it also bypasses
# refresh rotation, logout and revocation (#516). The staging overlay was found
# deploying the first of these (#524).
#
# The set is a tuple rather than one constant because "the value we ship" is not
# a single string: the compose file and the kustomize base carry one, and the
# Helm chart's default values carry a *different* one. Naming only the first
# would leave the chart's install path quietly forgeable, which is the same bug
# in a different file. A guard is only as good as its list of known-bad values,
# so both are here and the message says which one was found.
PUBLISHED_SECRET_KEYS: tuple[str, ...] = (
    # docker-compose.yaml, infra/k8s/base/secret.yaml, backend/.env.example
    "your-secret-key-change-in-production",  # noqa: S105
    # infra/helm/ai-platform/values.yaml (secrets.jwtSecretKey)
    "change-me-jwt-secret",  # noqa: S105
)

# Opt-in acknowledgement, deliberately explicit rather than inferred from an
# environment name: a guard that only fires in "production-like" environments is
# bypassed by one variable, which is the same mistake as trusting a header the
# client writes. Set it where a published key is genuinely intended (local
# development, the Kind smoke test) and nowhere else.
ALLOW_PLACEHOLDER_ENV_VAR = "ALLOW_PLACEHOLDER_SECRET_KEY"


def flag_enabled(name: str) -> bool:
    """Whether an opt-in acknowledgement variable is set to a truthy value."""
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def ensure_secret_key_acceptable(secret_key: str) -> None:
    """Raise ``RuntimeError`` unless ``secret_key`` is safe to sign with.

    An empty key is a misconfiguration and a published key is a vulnerability, so
    both stop startup. A published key is refused with a message that says how to
    proceed, because an operator meeting it has to make a decision rather than
    guess.

    Not a warning, unlike the default MinIO credentials check in
    ``app.main._validate_environment``: default object-storage credentials
    expose storage on a network the operator still controls, whereas a known
    signing key lets an unauthenticated caller authenticate as any user.
    """
    if not secret_key:
        raise RuntimeError("SECRET_KEY environment variable must be set")
    if secret_key in PUBLISHED_SECRET_KEYS and not flag_enabled(ALLOW_PLACEHOLDER_ENV_VAR):
        raise RuntimeError(
            f"SECRET_KEY is the value committed to this repository ({secret_key!r}), "
            "so anyone could mint valid access tokens for this deployment. Set a "
            f"real random key, or set {ALLOW_PLACEHOLDER_ENV_VAR}=1 to acknowledge "
            "the risk deliberately (local development only)."
        )
