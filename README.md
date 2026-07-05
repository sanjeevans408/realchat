# Pingback — real-time mobile chat app

A single-room, real-time chat app. Python (Flask + Flask-SocketIO) backend,
MongoDB Atlas for storage, and a plain HTML/CSS/JS frontend built mobile-only.

## Project structure

```
realtime-chat/
├── backend/
│   ├── app.py             Flask + Socket.IO server (auth + realtime events)
│   ├── db.py               MongoDB Atlas connection helper
│   ├── requirements.txt
│   └── .env.example        Copy to .env and fill in your values
└── frontend/
    ├── index.html          Auth screen + chat screen
    ├── style.css
    └── script.js
```

## Features

- **Accounts**: username + password, hashed with Werkzeug's `generate_password_hash`.
- **Real-time messaging**: Socket.IO — messages appear instantly for everyone in the room.
- **Message history**: stored in MongoDB Atlas, last 50 messages loaded on join.
- **Presence**: live "N online" counter and a bottom-sheet list of who's online, with deterministic colored avatar initials per user.
- **Typing indicator**: shows who's typing, debounced so it clears automatically.
- **Join/leave system messages**.
- **Mobile-only layout**: full-screen on phones; renders as a centered phone frame on desktop rather than stretching into a desktop layout.

## 1. Set up MongoDB Atlas

1. Create a free cluster at https://www.mongodb.com/cloud/atlas
2. **Database Access** → add a database user (username + password)
3. **Network Access** → add your IP (or `0.0.0.0/0` for quick testing)
4. **Database → Connect → Drivers** → copy the connection string

## 2. Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `.env`:

```
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>/?retryWrites=true&w=majority
MONGODB_DB=realtime_chat
SECRET_KEY=some-long-random-string
```

## 3. Install & run

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python3 app.py
```

Open **http://localhost:5000**. Create an account, then open the same URL
in a second browser tab (or on your phone via your computer's LAN IP) to
chat with yourself in real time and see presence/typing update live.

## How it works

- **Auth** is a normal REST API (`/api/register`, `/api/login`, `/api/logout`,
  `/api/me`) using a signed Flask session cookie.
- **Socket.IO shares that same session cookie**, so once you're logged in,
  the server already knows who you are on every real-time event — no
  separate socket auth step needed.
- On `connect`, the server checks the session and rejects the socket if
  there's no logged-in user.
- On `join`, the server adds the socket to the `general` room, sends back
  the last 50 messages from MongoDB, and broadcasts an updated presence list.
- `send_message` writes to MongoDB first, then broadcasts to the room —
  so a page refresh always reflects what's actually stored.
- Multi-tab/multi-device: the server tracks `username -> set(socket ids)`,
  so opening the app in two tabs doesn't cause duplicate "joined" messages
  and only shows "left" once every tab has disconnected.

## Deploying

Any host that supports long-lived WebSocket connections works (Render,
Railway, Fly.io, a VPS). For production, run with gunicorn's eventlet worker:

```bash
gunicorn -k eventlet -w 1 -b 0.0.0.0:5000 app:app
```

(Socket.IO with the eventlet/gevent workers needs to stay at `-w 1` unless
you add a message queue like Redis for cross-worker broadcasting.)

Set `MONGODB_URI` and `SECRET_KEY` as environment variables on the host —
don't commit your `.env` file.
