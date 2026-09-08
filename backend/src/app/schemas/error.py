"""Standardized error response schemas.

Every error returned by the API has the same shape::

    {
      "error": {
        "code": "not_found",
        "message": "Document not found",
        "details": null | {...}
      }
    }

The frontend falls back to ``detail`` for legacy responses, so old
clients keep working during the transition.
"""

from pydantic import BaseModel


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail