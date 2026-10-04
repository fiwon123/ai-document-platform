"""Tests for the object-storage client (#634).

There is no bucket here and nothing is uploaded. What is under test is the
*shape* of the client — specifically that it cannot spend a minute discovering
an endpoint is not there.
"""

from botocore.config import Config


def _config():
    """The live botocore config, built without contacting anything.

    Constructing the client opens no connection, so this needs no object store.
    The arguments are the module's own constants rather than literals, so the
    client under test is configured exactly as the singleton is — a fixture
    built from different values would be asserting about the wrong client.
    """
    from app.storage.storage import (
        MINIO_ACCESS_KEY,
        MINIO_BUCKET,
        MINIO_ENDPOINT,
        MINIO_SECRET_KEY,
        MinioStorage,
    )

    return MinioStorage(
        endpoint=MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        bucket=MINIO_BUCKET,
    ).client.meta.config


def test_an_unreachable_object_store_fails_in_seconds_not_a_minute():
    """The ceiling, as a policy.

    botocore's default connect timeout is 60 seconds and its default legacy
    retry budget is 5 attempts, so one call against a dead endpoint costs about
    ten seconds. That call is `ensure_bucket`, which runs in the app lifespan
    and again before every upload — so it is paid on startup and on every write.

    The numbers here are deliberately loose. They are not "what the config
    happens to say today", they are the point past which the suite goes slow
    again and startup starts hanging.
    """
    config = _config()

    assert config.connect_timeout is not None, (
        "no connect timeout: botocore's own default is 60s, so an unreachable "
        "endpoint is discovered a minute at a time (#634)"
    )
    assert config.connect_timeout <= 5, (
        f"connect_timeout is {config.connect_timeout}s; the ceiling is 5s (#634)"
    )

    assert config.read_timeout is not None, (
        "no read timeout: a server that accepts the connection and then stalls "
        "holds the caller indefinitely (#634)"
    )
    assert config.read_timeout <= 30, (
        f"read_timeout is {config.read_timeout}s; the ceiling is 30s (#634)"
    )


def test_the_retry_budget_is_bounded_and_still_survivable():
    """Bounded, but not removed.

    Zero retries would make a transient blip on a real upload a user-visible
    failure, which is the opposite trade: the point is a *ceiling*, not the
    absence of resilience.
    """
    retries = _config().retries

    assert retries, "no retry policy: botocore falls back to 5 legacy attempts (#634)"

    # botocore rewrites `max_attempts` into `total_max_attempts` on the way in,
    # so the ceiling is asserted on the name that survives normalization.
    total = retries.get("total_max_attempts", retries.get("max_attempts"))

    assert total is not None, f"retry budget is unbounded: {retries} (#634)"
    assert total <= 3, f"{total} attempts per call; the ceiling is 3 (#634)"
    assert total >= 2, (
        f"{total} attempt(s) per call: one retry is what absorbs a transient "
        "blip, so zero would be a regression dressed as a fix (#634)"
    )


def test_the_signature_version_the_app_relies_on_is_unchanged():
    """The reason this config exists at all.

    The bounds above were added to an existing `Config(signature_version=...)`
    call. Rebuilding that object from scratch is the obvious way to lose the
    signature version, and the failure mode is a 403 from the object store on
    every request rather than an error at import — so it is pinned here.
    """
    assert _config().signature_version == "s3v4"


def test_the_config_is_a_real_botocore_config_not_a_dict():
    """Guards the test above from passing on a stand-in.

    `_config()` reads attributes off whatever `_create_client` handed to
    boto3. If that ever became a plain mapping, every assertion here would be
    asserting against a fixture of the test's own making rather than the
    client's actual configuration.
    """
    assert isinstance(_config(), Config)