"""Tests for what deleting an account actually deletes (#495).

`TestDeleteCurrentUser::test_delete_own_account` in `test_user.py` registered a
user, deleted the account, and asserted the JWT stopped working. It never
created a document, so the endpoint's entire job — removing the account's data —
was never exercised. It returned 204 and left the documents, their chunks and
the search history in the database, and the suite stayed green.

Every test here seeds one of those tables first. The point of the class name is
the seeding: a deletion test with nothing to delete proves only that deleting
nothing works.
"""

import uuid
from unittest.mock import MagicMock

import pytest
from sqlalchemy import func, select

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.search import SearchHistory
from app.models.webhook import WebhookSubscription
from app.services.thumbnail import thumbnail_object_key


def _register(client, username: str) -> str:
    """Register a user and return an Authorization header."""
    resp = client.post(
        "/v1/auth/register",
        json={
            "username": username,
            "password": "testpass123",
            "confirm_password": "testpass123",
        },
    )
    assert resp.status_code == 201, resp.text
    token = client.post(
        "/v1/auth/login",
        data={"username": username, "password": "testpass123"},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _user_id(client, headers) -> uuid.UUID:
    return uuid.UUID(client.get("/v1/auth/me", headers=headers).json()["id"])


def _seed_document(db_session, owner_id, *, name="doc.txt", chunks=2) -> DocumentDB:
    doc = DocumentDB(
        owner_id=owner_id,
        filename=name,
        object_key=f"users/{owner_id}/documents/{uuid.uuid4()}/{name}",
        mime_type="text/plain",
        status=DocumentStatus.READY,
    )
    db_session.add(doc)
    db_session.flush()
    for i in range(chunks):
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content=f"chunk {i} of {name}",
                chunk_index=i,
            )
        )
    db_session.commit()
    return doc


def _seed_search_history(db_session, owner_id, queries=("mitochondria", "atp")) -> None:
    for q in queries:
        db_session.add(
            SearchHistory(user_id=owner_id, query=q, results_count=1)
        )
    db_session.commit()


def _seed_webhook(db_session, owner_id) -> WebhookSubscription:
    hook = WebhookSubscription(
        user_id=owner_id,
        url="https://example.com/hook",
        events=["document.ready"],
        secret="s" * 32,
    )
    db_session.add(hook)
    db_session.commit()
    return hook


def _count(db_session, model) -> int:
    return db_session.execute(
        select(func.count()).select_from(model)
    ).scalar_one()


def _fake_storage(deleted: list[str], fail_on: set[str] | None = None):
    """A storage double that records the keys it was asked to remove.

    `fail_on` makes those keys raise, which is how the "storage is best-effort"
    guarantee is tested without an object store that can be made to fail on
    demand.
    """
    fail_on = fail_on or set()

    def delete(key: str) -> None:
        if key in fail_on:
            raise RuntimeError("object store unavailable")
        deleted.append(key)

    return MagicMock(delete=delete, spec=["delete"])


class TestAccountDeletionRemovesOwnedData:
    """The regression: an erasure endpoint that does not erase."""

    def test_documents_and_their_chunks_are_deleted(
        self, client, db_session, monkeypatch
    ):
        monkeypatch.setattr(
            "app.services.user.default_storage", _fake_storage([])
        )
        headers = _register(client, "del_docs")
        uid = _user_id(client, headers)
        doc = _seed_document(db_session, uid, chunks=3)
        chunk_ids = set(
            db_session.execute(
                select(DocumentChunk.id).where(DocumentChunk.document_id == doc.id)
            ).all()
        )
        assert len(chunk_ids) == 3

        assert client.delete("/v1/users/me", headers=headers).status_code == 204

        # Re-query with a fresh identity: the session that inserted the rows has
        # them in its identity map, and a stale ORM object would report a row
        # the database no longer has.
        db_session.expire_all()
        assert _count(db_session, DocumentDB) == 0
        assert _count(db_session, DocumentChunk) == 0

    def test_search_history_is_deleted(self, client, db_session, monkeypatch):
        # The literal text of what someone searched for is the most personal
        # thing the platform stores, so it has to go with the account.
        monkeypatch.setattr(
            "app.services.user.default_storage", _fake_storage([])
        )
        headers = _register(client, "del_history")
        uid = _user_id(client, headers)
        _seed_search_history(db_session, uid, queries=("q1", "q2", "q3"))
        assert _count(db_session, SearchHistory) == 3

        assert client.delete("/v1/users/me", headers=headers).status_code == 204

        db_session.expire_all()
        assert _count(db_session, SearchHistory) == 0

    def test_webhook_subscriptions_are_deleted(
        self, client, db_session, monkeypatch
    ):
        # This one already worked: the table is the only user-owned table that
        # always had an ON DELETE CASCADE. It is asserted anyway, because the
        # fix touches the same path and a regression here would be silent.
        monkeypatch.setattr(
            "app.services.user.default_storage", _fake_storage([])
        )
        headers = _register(client, "del_hooks")
        uid = _user_id(client, headers)
        _seed_webhook(db_session, uid)
        assert _count(db_session, WebhookSubscription) == 1

        assert client.delete("/v1/users/me", headers=headers).status_code == 204

        db_session.expire_all()
        assert _count(db_session, WebhookSubscription) == 0

    def test_another_users_data_survives(
        self, client, db_session, monkeypatch
    ):
        # The other half of a cascade: it must not over-delete. A cascade
        # written as "delete everything" would pass every test above.
        monkeypatch.setattr("app.services.user.default_storage", _fake_storage([]))
        headers = _register(client, "del_one")
        uid = _user_id(client, headers)
        _seed_document(db_session, uid, name="mine.txt")

        other_headers = _register(client, "keep_two")
        other_id = _user_id(client, other_headers)
        _seed_document(db_session, other_id, name="theirs.txt")
        _seed_search_history(db_session, other_id, queries=("kept",))
        hook = _seed_webhook(db_session, other_id)

        assert client.delete("/v1/users/me", headers=headers).status_code == 204

        db_session.expire_all()
        assert _count(db_session, DocumentDB) == 1
        assert _count(db_session, SearchHistory) == 1
        assert _count(db_session, WebhookSubscription) == 1
        assert db_session.get(WebhookSubscription, hook.id) is not None


class TestAccountDeletionRemovesStoredObjects:
    """Object storage is outside the database, so it needs its own handling."""

    def test_objects_and_thumbnails_are_removed(
        self, client, db_session, monkeypatch
    ):
        deleted: list[str] = []
        monkeypatch.setattr("app.services.user.default_storage", _fake_storage(deleted))
        headers = _register(client, "obj_user")
        uid = _user_id(client, headers)
        doc = _seed_document(db_session, uid, name="stored.txt")
        # Captured as a plain string while the row still exists: the cascade
        # removes the document, and the ORM instance held here would raise
        # ObjectDeletedError on any further attribute access. Production makes
        # the same move for the same reason.
        object_key = doc.object_key

        assert client.delete("/v1/users/me", headers=headers).status_code == 204

        # Both the file and its thumbnail. Leaving the PNG behind would leak one
        # object per document for the lifetime of the bucket.
        assert object_key in deleted
        assert thumbnail_object_key(object_key) in deleted

    def test_every_owned_object_is_removed(self, client, db_session, monkeypatch):
        deleted: list[str] = []
        monkeypatch.setattr("app.services.user.default_storage", _fake_storage(deleted))
        headers = _register(client, "obj_many")
        uid = _user_id(client, headers)
        docs = [_seed_document(db_session, uid, name=f"d{i}.txt") for i in range(3)]
        object_keys = [d.object_key for d in docs]

        assert client.delete("/v1/users/me", headers=headers).status_code == 204

        for object_key in object_keys:
            assert object_key in deleted

    def test_keys_are_read_before_the_rows_are_deleted(
        self, client, db_session, monkeypatch
    ):
        # The ordering constraint, and the one that is easy to break silently.
        # Object storage is not cascaded, so the keys have to be collected while
        # the document rows still exist. Read them afterwards and the query
        # returns nothing — and every uploaded file stays in the bucket with no
        # error anywhere, which is exactly how the original bug behaved.
        from app.repositories.user import UserRepository

        documents_visible_at_read: list[int] = []
        real_list = UserRepository.list_object_keys

        def spy(self, id):
            documents_visible_at_read.append(
                db_session.execute(
                    select(func.count())
                    .select_from(DocumentDB)
                    .where(DocumentDB.owner_id == id)
                ).scalar_one()
            )
            return real_list(self, id)

        monkeypatch.setattr(UserRepository, "list_object_keys", spy)
        monkeypatch.setattr("app.services.user.default_storage", _fake_storage([]))

        headers = _register(client, "obj_order")
        uid = _user_id(client, headers)
        _seed_document(db_session, uid, name="order.txt")

        assert client.delete("/v1/users/me", headers=headers).status_code == 204

        assert documents_visible_at_read == [1], (
            "the object keys were read when the account had no documents left, "
            "so no object could be identified for removal"
        )
        db_session.expire_all()
        assert _count(db_session, DocumentDB) == 0

    def test_storage_failure_does_not_block_erasure(
        self, client, db_session, monkeypatch, caplog
    ):
        # An account must be deletable even when the object store is down.
        # The alternative — failing the request — would leave someone unable to
        # erase their own data precisely when the system is unhealthy, and the
        # rows would remain either way.
        headers = _register(client, "obj_fail")
        uid = _user_id(client, headers)
        doc = _seed_document(db_session, uid, name="fail.txt")
        object_key = doc.object_key

        monkeypatch.setattr(
            "app.services.user.default_storage",
            _fake_storage([], fail_on={object_key}),
        )

        with caplog.at_level("WARNING"):
            assert client.delete("/v1/users/me", headers=headers).status_code == 204

        db_session.expire_all()
        # The rows are gone despite the storage failure — that is the guarantee.
        assert _count(db_session, DocumentDB) == 0
        assert _count(db_session, DocumentChunk) == 0
        # And the leak is reported rather than swallowed, because the object is
        # now unreachable through the API but still sitting in the bucket.
        assert any(object_key in r.message % r.args for r in caplog.records)


class TestTheCascadeIsEnforcedByTheDatabase:
    """The guarantee must not depend on the delete path remembering."""

    def test_a_document_owned_by_a_missing_user_is_refused(self, db_session):
        # Before migration 009 this insert succeeded. A document belonging to
        # nobody is how the leak started: the endpoint deleted the user, the
        # document had no relationship to cascade through, and the row stayed.
        from sqlalchemy.exc import IntegrityError

        orphan = DocumentDB(
            owner_id=uuid.uuid4(),
            filename="orphan.txt",
            object_key=f"users/{uuid.uuid4()}/documents/orphan.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(orphan)
        with pytest.raises(IntegrityError):
            db_session.commit()
        db_session.rollback()

    def test_search_history_for_a_missing_user_is_refused(self, db_session):
        from sqlalchemy.exc import IntegrityError

        db_session.add(
            SearchHistory(user_id=uuid.uuid4(), query="orphan", results_count=0)
        )
        with pytest.raises(IntegrityError):
            db_session.commit()
        db_session.rollback()

    def test_the_cascade_fires_without_application_help(self, client, db_session):
        # Deleting the row directly — no service, no repository, no
        # application code in the path — must still take the data with it. This
        # is the difference between a constraint and a convention.
        headers = _register(client, "raw_delete")
        uid = _user_id(client, headers)
        _seed_document(db_session, uid, name="raw.txt", chunks=2)
        _seed_search_history(db_session, uid)
        _seed_webhook(db_session, uid)

        db_session.execute(
            DocumentDB.__table__.delete().where(DocumentDB.owner_id == uid)
        )
        db_session.commit()
        db_session.expire_all()
        assert _count(db_session, DocumentChunk) == 0

        db_session.execute(
            SearchHistory.__table__.delete().where(SearchHistory.user_id == uid)
        )
        db_session.commit()
        db_session.expire_all()
        assert _count(db_session, SearchHistory) == 0


class TestAdminDeletionMatchesSelfDeletion:
    def test_admin_deletion_removes_owned_data_too(
        self, client, db_session, monkeypatch
    ):
        # An admin removing an account must not leave a weaker trail than the
        # owner removing their own; both go through the same path.
        from app.models.user import Role, UserDB

        monkeypatch.setattr("app.services.user.default_storage", _fake_storage([]))

        admin = UserDB(
            username=f"admin_{uuid.uuid4().hex[:8]}",
            hashed_password="x",  # noqa: S106
            role=Role.admin,
        )
        db_session.add(admin)
        db_session.commit()
        admin_headers = {
            "Authorization": f"Bearer {_admin_token(admin)}"
        }

        target_headers = _register(client, "admin_target")
        target_id = _user_id(client, target_headers)
        _seed_document(db_session, target_id, name="target.txt")
        _seed_search_history(db_session, target_id)

        resp = client.delete(f"/v1/users/{target_id}", headers=admin_headers)
        assert resp.status_code in (200, 204), resp.text

        db_session.expire_all()
        assert _count(db_session, DocumentDB) == 0
        assert _count(db_session, SearchHistory) == 0


def _admin_token(user) -> str:
    """Mint a token for a user created directly in the database."""
    from app.routes.auth import create_access_token

    return create_access_token(str(user.id), user.username, "admin")
