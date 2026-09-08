import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .middleware import LoggingMiddleware, RateLimitMiddleware
from .routes import auth, document, health, qa, search, statistics, users
from .storage.storage import storage

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the MinIO bucket exists before serving any requests.
    try:
        storage.ensure_bucket()
        logger.info("MinIO bucket '%s' is ready", storage.bucket)
    except Exception as e:
        logger.warning("Could not ensure MinIO bucket on startup: %s", e)
    yield


app = FastAPI(
    title="AI Document Intelligence Platform",
    description="Upload, process, search, and ask questions about your documents",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(LoggingMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/v1")
app.include_router(document.router, prefix="/v1")
app.include_router(health.router, prefix="/v1")
app.include_router(search.router, prefix="/v1")
app.include_router(qa.router, prefix="/v1")
app.include_router(statistics.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")


@app.get("/")
def root():
    return {"msg": "backend live on!"}
