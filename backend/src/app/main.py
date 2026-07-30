from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def heath():
    return {"msg": "hi"}
