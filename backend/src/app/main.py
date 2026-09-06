from fastapi import FastAPI

from .routes import document, health

app = FastAPI()

v1 = FastAPI()

v1.include_router(document.router)
v1.include_router(health.router)


@app.get("/")
def health():
    return {"msg": "backend live on!"}


app.mount("/v1", v1)
