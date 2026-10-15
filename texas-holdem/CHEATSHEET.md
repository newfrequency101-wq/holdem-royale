# Hold-em Royale cheat sheet

## Where things live

| What | Where |
| --- | --- |
| Your website (Pixel Pit) | https://newfrequency.pythonanywhere.com: Hold-em is a game on it, and players' progress is saved to their Pixel Pit account |
| The multiplayer server | https://holdem-royale.onrender.com (Render → **holdem-royale**, https://dashboard.render.com) |
| The code | https://github.com/newfrequency101-wq/holdem-royale |

## Every time the game changes

1. Ask Claude to **commit and push**.
2. On Pixel Pit, open the Hold-em Royale game page → **▲ New version** → upload `TexasHoldem.html` from this folder. Players keep their progress.
3. If the change touched the multiplayer server too, Render redeploys by itself. If Render says it didn't, click **Manual Deploy → Deploy latest commit**.

## Saves

- Signed-in players' progress is stored in their Pixel Pit account, so it survives closing the browser, restarting, clearing history and switching devices.
- **Reset save** on the game page erases it.

## Leaderboard

- The **🏆 LEADERBOARD** button in the game's lobby, and the Leaderboard panel on the Pixel Pit game page, rank players by the most chips they've ever had. The game's board also shows each player's current avatar and level.
- Only signed-in Pixel Pit players are ranked. It only works on Pixel Pit, not when the game is opened from your PC or the Render address.
- To wipe it (as the owner): Pixel Pit game page → **Clear leaderboard**. Players get back on the next time they open the game.

## If something looks old

- PC: press **Ctrl + F5**.
- Phone: close the tab and open the page again.
- Still old? Check that you uploaded the new version on the game page.
