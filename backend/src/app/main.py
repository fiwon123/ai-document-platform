from fastapi import FastAPI

from .routes import document

app = FastAPI()

v1 = FastAPI()

v1.include_router(document.router)


@app.get("/")
def heath():
    return {"msg": "backend live on!"}


app.mount("/v1", v1)
