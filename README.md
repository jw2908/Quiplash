# 🥊 Punch Bowl

A free party game of quick, silly answers. One screen (a TV, Fire Stick, or laptop) shows the game. Everyone plays from their phone's web browser. No apps, no accounts.

**3 to 10 players · about 15 minutes a game**

## How a game goes

1. **Round 1:** every player gets two prompts on their phone, and each prompt is shared with one other player. Write the funniest answer you can.
2. The two answers to each prompt go up on the TV side by side. Everyone else votes for their favorite on their phone.
   - 100 points per vote, plus a 100 point bonus for winning the matchup.
   - Win **every** vote and it's a **KNOCKOUT** (+150 bonus).
   - Write the same answer as your rival and it's a **JINX**: nobody scores.
3. **Round 2:** same thing, double points.
4. **The Last Laugh:** everyone answers the *same* prompt. Each player hands out 3 votes (stack them if you love one). Triple points.
5. Highest score wins. Hit **Play again** to keep the same group going.

The first player to join gets a 👑 and can start the game, skip timers, and restart from their phone. That means once the TV is showing the room code, nobody has to touch the remote again.

## Play on a Fire TV Stick (or any smart TV)

The TV just needs a web browser and the game needs to be online. The easiest way is a free Render account:

### 1. Put the game online (one time, about 5 minutes, free)

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click **New → Blueprint**, pick this repository, and click **Apply**. (The `render.yaml` file in this repo tells Render everything it needs.)
   - Or click **New → Web Service**, pick this repo, set **Build command** to `npm install` and **Start command** to `npm start`, and choose the **Free** plan.
3. When it finishes you get an address like `https://punch-bowl-xxxx.onrender.com`. That's your game.

> Render's free plan goes to sleep when nobody is using it. The first visit after a while can take up to a minute to wake up. Open the page a minute before people arrive and you're fine.

### 2. Open it on the Fire Stick

1. On the Fire TV home screen, search for **Silk** and install the **Silk Browser** (free, made by Amazon).
2. Open Silk, select the address bar, and type your address with `/host` on the end, e.g. `punch-bowl-xxxx.onrender.com/host`.
3. Tip: press the **Menu** button (☰) on the remote and **bookmark** it so next time it's one click.
4. The TV shows a big room code and the web address for phones.

To stop the Fire Stick screensaver from covering the game: **Settings → Display & Sounds → Screensaver → Start Time → Never** (switch it back afterwards if you like).

### 3. Everyone joins on their phone

Each player opens the same address on their phone (without `/host`), types the 4-letter room code and their name, and they're in. When everyone is in, the 👑 player taps **Everybody's in!** (or press **Start game** on the TV with the remote).

The TV is controlled with the remote's arrow keys and center button. The only buttons on the TV are **Start game**, **Skip**, **Play again** and **New room**, and they're big.

## Play on your home Wi-Fi without putting it online

If you have a laptop, you can run the game yourself instead of using Render:

1. Install [Node.js](https://nodejs.org) (version 18 or newer).
2. Download this repo, then in a terminal in its folder run:

   ```bash
   npm install
   npm start
   ```

3. The terminal prints two addresses, for example:

   ```
   TV / host screen:  http://localhost:3000/host
   On your Wi-Fi:     http://192.168.1.23:3000
   ```

4. Open `http://192.168.1.23:3000/host` on the TV (or the laptop, plugged into the TV). Phones on the **same Wi-Fi** go to `http://192.168.1.23:3000`.

Note: some routers and guest networks block devices from talking to each other. If phones can't connect, use the Render option above.

## Make it yours

- **Prompts** live in [`prompts.js`](prompts.js): 120 head-to-head prompts and 25 Last Laugh prompts, all written for this game. Add your own inside jokes; just keep each one on a single line in quotes.
- **Timers and points** are at the top of [`game.js`](game.js).
- **Look and feel:** [`public/style.css`](public/style.css), [`public/host.html`](public/host.html) (TV) and [`public/index.html`](public/index.html) (phones).

## For developers

- `server.js`: Express static server plus Socket.IO. Rooms are kept in memory, so restarting the server ends any games in progress.
- `game.js`: the room and phase machine (lobby → intro → answering → voting/reveal per matchup → scores → … → final round → game over). The server sends the TV and each phone their own view of the state.
- `test/simulate.js`: `npm test` starts the server and plays complete games with 3, 5 and 8 bot players, plus a game where a player disconnects and rejoins.
- Players who lose connection (phone locks, etc.) rejoin automatically when they reopen the page; their spot is remembered in the browser.
- Environment variables: `PORT` (default 3000), `PUBLIC_URL` (the address shown on the TV, if auto-detect gets it wrong), `TIME_SCALE` (speeds up all timers, e.g. `0.1`, useful for testing).

## License

MIT. Punch Bowl is an original game; it isn't affiliated with any other party game.
