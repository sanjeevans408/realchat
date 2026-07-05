"""
Real-time mobile chat app backend.

- Flask serves the frontend and a small REST auth API (register/login/me/logout)
- Flask-SocketIO handles real-time messaging, typing indicators, and presence
- MongoDB Atlas stores users and message history (see db.py)
"""

import os
import re
from datetime import datetime, timezone

from bson import ObjectId
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory, session
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import check_password_hash, generate_password_hash

from db import get_db, ping

load_dotenv()

try:
    import eventlet  # noqa: F401
    import eventlet.green.threading  # noqa: F401
    SOCKETIO_ASYNC_MODE = "eventlet"
except Exception:
    SOCKETIO_ASYNC_MODE = "threading"

FRONTEND_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend"
)

ROOM = "general"
HISTORY_LIMIT = 50
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode=SOCKETIO_ASYNC_MODE,
    manage_session=True,
)

# sid -> username, and username -> set(sid) for multi-tab support
online_by_sid = {}
online_by_user = {}


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "db_connected": ping()})


# ---------------------------------------------------------------------------
# Auth (simple session-cookie based, shared with Socket.IO)
# ---------------------------------------------------------------------------
@app.route("/api/register", methods=["POST"])
def register():
    body = request.get_json(force=True, silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""

    if not USERNAME_RE.match(username):
        return jsonify({"error": "Username must be 3-20 characters: letters, numbers, underscore."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    try:
        db = get_db()
    except Exception:
        return jsonify({"error": "Database is not configured or unreachable. Check your MongoDB settings."}), 503

    if db.users.find_one({"username": username}):
        return jsonify({"error": "That username is already taken."}), 409

    db.users.insert_one(
        {
            "username": username,
            "password_hash": generate_password_hash(password),
            "created_at": datetime.now(timezone.utc),
        }
    )
    session["username"] = username
    return jsonify({"username": username})


@app.route("/api/login", methods=["POST"])
def login():
    body = request.get_json(force=True, silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""

    try:
        db = get_db()
    except Exception:
        return jsonify({"error": "Database is not configured or unreachable. Check your MongoDB settings."}), 503

    user = db.users.find_one({"username": username})
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Incorrect username or password."}), 401

    session["username"] = username
    return jsonify({"username": username})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("username", None)
    return jsonify({"ok": True})


@app.route("/api/me")
def me():
    username = session.get("username")
    if not username:
        return jsonify({"username": None}), 200
    return jsonify({"username": username})


# ---------------------------------------------------------------------------
# Socket.IO — realtime messaging & presence
# ---------------------------------------------------------------------------
def serialize_message(doc):
    return {
        "id": str(doc["_id"]),
        "sender": doc["sender"],
        "text": doc["text"],
        "created_at": doc["created_at"].isoformat(),
    }


def broadcast_presence():
    emit(
        "presence",
        {"online_users": sorted(online_by_user.keys()), "count": len(online_by_user)},
        room=ROOM,
    )


@socketio.on("connect")
def handle_connect():
    username = session.get("username")
    if not username:
        return False  # reject unauthenticated socket connections
    return True


@socketio.on("join")
def handle_join():
    username = session.get("username")
    if not username:
        emit("auth_error", {"error": "Not logged in."})
        return

    join_room(ROOM)
    online_by_sid[request.sid] = username
    online_by_user.setdefault(username, set()).add(request.sid)

    db = get_db()
    history_cursor = (
        db.messages.find({"room": ROOM}).sort("created_at", -1).limit(HISTORY_LIMIT)
    )
    history = [serialize_message(m) for m in reversed(list(history_cursor))]
    emit("history", {"messages": history})

    was_already_online = len(online_by_user[username]) > 1
    if not was_already_online:
        emit(
            "system_message",
            {"text": f"{username} joined the chat", "created_at": _now_iso()},
            room=ROOM,
        )
    broadcast_presence()


@socketio.on("disconnect")
def handle_disconnect():
    username = online_by_sid.pop(request.sid, None)
    if not username:
        return
    sids = online_by_user.get(username)
    if sids:
        sids.discard(request.sid)
        if not sids:
            online_by_user.pop(username, None)
            emit(
                "system_message",
                {"text": f"{username} left the chat", "created_at": _now_iso()},
                room=ROOM,
            )
    broadcast_presence()


@socketio.on("send_message")
def handle_send_message(data):
    username = session.get("username")
    if not username:
        emit("auth_error", {"error": "Not logged in."})
        return

    text = (data or {}).get("text", "").strip()
    if not text or len(text) > 2000:
        return

    db = get_db()
    doc = {
        "room": ROOM,
        "sender": username,
        "text": text,
        "created_at": datetime.now(timezone.utc),
    }
    result = db.messages.insert_one(doc)
    doc["_id"] = result.inserted_id

    emit("new_message", serialize_message(doc), room=ROOM)


@socketio.on("typing")
def handle_typing():
    username = session.get("username")
    if username:
        emit("typing", {"username": username}, room=ROOM, include_self=False)


@socketio.on("stop_typing")
def handle_stop_typing():
    username = session.get("username")
    if username:
        emit("stop_typing", {"username": username}, room=ROOM, include_self=False)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    # Render runs this in a production environment; Werkzeug raises an error
    # unless explicitly allowed. Pass `allow_unsafe_werkzeug=True` to bypass
    # the runtime check when using the built-in server in this environment.
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
