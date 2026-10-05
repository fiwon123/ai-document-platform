"""cascade user deletion to documents and search history

Revision ID: 009
Revises: 008
Create Date: 2026-09-28 00:00:00.000000

`DELETE /v1/users/{id}` deleted the user row and nothing else. It returned 204
and left the account's documents, their chunks, and its search history in the
database — the erasure endpoint not erasing, which is a compliance defect
rather than a cosmetic one (#495).

The cause is that the schema had no foreign key from either table to `users`.
`webhook_subscriptions` had one with ON DELETE CASCADE and was therefore the
only user-owned table that was actually cleaned up, which is why the gap was so
easy to miss: the accounts that had never set up a webhook looked correct.

The fix puts the guarantee in the database rather than in the delete path. A
service-level delete is a promise every future writer has to remember; a
constraint is a promise the database keeps. `document_chunks` then goes with its
document through the cascade that migration 002 already established.

The orphaned `search_history` rows are removed rather than preserved. A row whose
user no longer exists is unreachable through the API, so nothing can read it, and
it is the most personal thing the platform stores — the literal text of what
someone searched for. Keeping it would mean this migration had to choose a
`ON DELETE` behaviour for rows whose owner is already gone, and every option is
worse than deleting a row nothing can reach.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Both constraints refuse to be created while a dangling row exists, so the
    # orphans go first. `documents` has none (every document still has an owner),
    # but this is stated as a query rather than assumed, because the migration
    # has to be safe on a database that has seen a different history than this
    # one. Deleting the documents' orphans too would discard stored objects and
    # vectors, so they are only reported if any are found.
    op.execute(
        """
        DO $$
        DECLARE dangling_documents bigint;
        BEGIN
            SELECT count(*) INTO dangling_documents
            FROM documents d
            WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.owner_id);

            IF dangling_documents > 0 THEN
                RAISE EXCEPTION
                    'cannot add the cascade: % document(s) have no owner row. '
                    'Resolve them before upgrading.', dangling_documents;
            END IF;
        END $$;
        """
    )

    # Unreachable rows: the account is already gone, so this is the erasure the
    # cascade could not perform retroactively.
    op.execute(
        """
        DELETE FROM search_history sh
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = sh.user_id)
        """
    )

    op.create_foreign_key(
        "documents_owner_id_fkey",
        "documents",
        "users",
        ["owner_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "search_history_user_id_fkey",
        "search_history",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint(
        "search_history_user_id_fkey",
        "search_history",
        type_="foreignkey",
    )
    op.drop_constraint(
        "documents_owner_id_fkey",
        "documents",
        type_="foreignkey",
    )
    # The rows deleted above are not restored: they belonged to accounts that no
    # longer exist, and reconstructing search queries nobody can attribute is not
    # a downgrade worth performing.
