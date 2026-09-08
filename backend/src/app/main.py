from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .middleware import LoggingMiddleware, RateLimitMiddleware
from .routes import auth, document, health, qa, search


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Document processing now runs in a dedicated arq worker process
    # (see docker-compose.yaml `worker` service); no in-process thread
    # is started here anymore.
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


@app.get("/")
def root():
    return {"msg": "backend live on!"}
