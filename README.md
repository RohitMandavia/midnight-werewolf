# Midnight Werewolf (Multiplayer Web)

Phone-friendly lobby game inspired by One Night Werewolf:
- players join from phones via lobby code
- first player is admin
- admin chooses active roles and starts game
- all players receive synchronized instructions on screen

## Run locally

From this folder:

```bash
cd "/Users/rohit/Documents/Claude _Cursor/midnight werewold"
python3 -m pip install -r requirements.txt
python3 -m uvicorn app:app --host 0.0.0.0 --port 8001 --reload
```

Open on host machine:
- `http://localhost:8001`

Open from phones on same Wi-Fi:
- `http://<your-computer-local-ip>:8001`

Example local IP check on Mac:

```bash
ipconfig getifaddr en0
```

## Notes

- Minimum 3 players.
- Role actions are instruction-driven (tabletop style); players perform actions physically.
- Admin can move to next step manually or let timers auto-advance.
