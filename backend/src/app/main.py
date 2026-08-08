from fastapi import FastAPI

from .routes import files

app = FastAPI()

v1 = FastAPI()

v1.add_route(files.router)


@app.get("/")
def heath():
    return {"msg": "backend live on!"}


app.mount("/v1", v1)
