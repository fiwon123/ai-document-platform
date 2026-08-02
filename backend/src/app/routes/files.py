from fastapi import APIRouter, status

router = APIRouter(
    prefix="/files",
    tags="files"
)


@router.get("/files/{id}", status_code=status.HTTP_200_OK)
def get_file(id: int):
    pass


@router.post("/files", status_code=status.HTTP_200_OK)
def create_file():
    pass


@router.delete("/files/{id}", status_code=status.HTTP_200_OK)
def delete_file(id: int):
    pass


@router.put("/files/{id}", status_code=status.HTTP_200_OK)
def update_file(id: int):
    pass
