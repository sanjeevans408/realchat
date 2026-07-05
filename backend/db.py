"""MongoDB Atlas connection helper — one shared client for the app."""

import os

from pymongo import ASCENDING, MongoClient
from pymongo.errors import ConnectionFailure

_client = None
_db = None


def get_db():
    """Lazily create and return the MongoDB database handle."""
    global _client, _db
    if _db is not None:
        return _db

    uri = os.environ.get("MONGODB_URI", "mongodb://sanjeevans408_db_user:xWeCZw8FOiGHfL1j@ac-stk3jsk-shard-00-00.o9cblwc.mongodb.net:27017,ac-stk3jsk-shard-00-01.o9cblwc.mongodb.net:27017,ac-stk3jsk-shard-00-02.o9cblwc.mongodb.net:27017/?ssl=true&replicaSet=atlas-ee538c-shard-0&authSource=admin&appName=realchat1").strip()
    if not uri:
        raise RuntimeError(
            "MONGODB_URI is not set. Add your MongoDB Atlas connection "
            "string to backend/.env"
        )

    _client = MongoClient(uri, serverSelectionTimeoutMS=8000)
    _db = _client.get_database(os.environ.get("MONGODB_DB", "realtime_chat"))
    _ensure_indexes(_db)
    return _db


def _ensure_indexes(db):
    db.users.create_index([("username", ASCENDING)], unique=True)
    db.messages.create_index([("room", ASCENDING), ("created_at", ASCENDING)])


def ping():
    """Used by /api/health to confirm Atlas is reachable."""
    try:
        get_db().command("ping")
        return True
    except (ConnectionFailure, RuntimeError):
        return False
