# Putting Hold-em Royale online

These steps put the multiplayer server on the internet so that people visiting your website can share cash tables. They use [Render](https://render.com), which can run a small Node.js server for free. Any host that runs Node.js 18 or newer works the same way.

The server also serves the game page itself, so when you're done, the game is playable at your Render address. You can link to that address from your website, embed it, or keep hosting the HTML on your own site.

## 1. Put the code on GitHub

Render deploys from a GitHub repository.

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Create a new repository, for example `holdem-royale`.
3. Push this project to it. (Claude can do this step for you once the repository exists.)

## 2. Create the server on Render

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click **New → Web Service** and pick your repository.
3. Fill in the settings:

   | Setting | Value |
   | --- | --- |
   | Root Directory | `texas-holdem/server` |
   | Runtime / Language | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | Free |

4. Click **Create Web Service** and wait for the deploy to finish (a few minutes).
5. Render shows your address at the top of the page, for example `https://holdem-royale.onrender.com`. Open it: the game should load, and the Cash Game panel should say **ONLINE**.

## 3. Connect your website

Pick one:

- **Link to it.** Add a link or button on your site that opens your Render address. This is the simplest option.
- **Embed it.** If your site builder lets you add custom HTML, paste this and replace the address with yours:

  ```html
  <iframe src="https://holdem-royale.onrender.com" style="width:100%;aspect-ratio:16/9;border:0" allow="autoplay"></iframe>
  ```

- **Host the page yourself.** Open `TexasHoldem.html`, find this line near the top of the `<script>` section:

  ```js
  const SERVER_URL = '';
  ```

  and put your Render address between the quotes:

  ```js
  const SERVER_URL = 'https://holdem-royale.onrender.com';
  ```

  Then upload `TexasHoldem.html` to your site as usual.

## Good to know

- **The free server sleeps.** On Render's free plan, the server goes to sleep after about 15 minutes with no visitors and takes up to a minute to wake up. The lobby wakes it as soon as someone opens the game, so it's usually ready by the time they click **Play Now**. If it doesn't answer within 20 seconds, that player gets an offline table against bots instead. A paid instance never sleeps.
- **Updating the game.** Push your changes to GitHub, and Render redeploys automatically. If you host `TexasHoldem.html` on your own site, upload the new copy there too.
- **Restarts.** When the server restarts or redeploys, the players at the tables get a "Connection Lost" message, and the chips they had on the table go back to their bankroll.
- **Checking on it.** `https://your-address/health` shows how many players are at the tables right now.
