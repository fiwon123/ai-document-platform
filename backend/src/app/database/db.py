import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

db_name = os.getenv("POSTGRES_DB", "mydb")
db_user = os.getenv("POSTGRES_USER", "postgres")
db_passsword = os.getenv("POSTGRES_PASSWORD", "mysecretpassword")
db_port = os.getenv("POSTGRES_PORT", "5432")
db_host = os.getenv("POSTGRES_HOST", "localhost")

SQLALCHEMY_DATABASE_URL = (
    f"postgresql://{db_user}:{db_passsword}@{db_host}:{db_port}/{db_name}"
)

engine = create_engine(SQLALCHEMY_DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
