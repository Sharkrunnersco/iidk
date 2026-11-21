# FERAL DEPTHS multiplayer server

Rooms with 4-letter join codes, up to 8 players. The server owns the round state (timer, who is "it" / infected),
checks tags (reach + immunity), rejects teleporting poses, handles disconnects and mid-round joins.
Desktop and VR players can both join. This is a prototype: it has not been tested with real clients yet.

## Run locally
    npm install
    npm start                # http://localhost:8080 and ws://localhost:8080
Put the game page at `public/index.html` so the same server serves the game and the websocket.

## Put it online (HTTPS is required for WebXR)
Any host that runs Node works. Example with Render.com (free tier):
1. Push this folder to a GitHub repo.
2. Render -> New -> Web Service -> pick the repo. Build command `npm install`, start command `npm start`.
3. Open the URL Render gives you (https://...onrender.com). It serves the game and `wss://` automatically.
(Railway and Fly.io work the same way.) A static-only host (GitHub Pages etc.) cannot run this server.

## Quick headset test without deploying
Run locally, then expose it: `npx cloudflared tunnel --url http://localhost:8080` and open the https URL on the headset.

## Protocol (JSON over WebSocket)
client -> server: create {name}, join {code,name}, pose {head,lh,rh,ry,vr}, start {mode:'tag'|'infect'} (host only), tag {target}
server -> client: joined {code,id,host}, state {players,mode,state,time,it,result} at 15 Hz, err {msg}
