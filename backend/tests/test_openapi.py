"""OpenAPI schema metadata tests (contact, servers, tags, descriptions).

These assert the documentation polish delivered with #315: every operation
carries a description and the schema advertises project contact details, a
portable (relative) server URL, and tag blurbs.
"""

_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}

_EXPECTED_TAGS = {
    "auth",
    "documents",
    "users",
    "search",
    "qa",
    "statistics",
    "webhooks",
    "health",
}


def _schema(client) -> dict:
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    return resp.json()


def test_contact_metadata(client):
    schema = _schema(client)

    contact = schema["info"]["contact"]
    assert contact["name"] == "AI Document Intelligence Platform"
    assert (
        contact["url"] == "https://github.com/fiwon123/ai-document-platform"
    )


def test_servers_are_relative_to_origin(client):
    schema = _schema(client)

    servers = schema["servers"]
    assert servers == [{"url": "/", "description": "Served from the current origin"}]


def test_tags_carry_descriptions(client):
    schema = _schema(client)

    by_name = {tag["name"]: tag for tag in schema["tags"]}
    assert set(by_name) == _EXPECTED_TAGS
    for name in _EXPECTED_TAGS:
        assert by_name[name]["description"], f"tag {name!r} lacks a description"


def test_description_of_a_representative_endpoint(client):
    schema = _schema(client)

    upload = schema["paths"]["/v1/documents/"]["post"]
    assert upload["description"]
    assert "upload" in upload["description"].lower()


def test_every_operation_has_a_description(client):
    schema = _schema(client)

    undocumented = []
    for path, operations in schema["paths"].items():
        for method, operation in operations.items():
            if method in _METHODS and not operation.get("description"):
                undocumented.append(f"{method.upper()} {path}")

    assert undocumented == []