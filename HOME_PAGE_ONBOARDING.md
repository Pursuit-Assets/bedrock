# Bedrock — Owner Home Pages: Setup

You're going to build your own home page inside Bedrock. Each of you has a branch and a single file to edit; nothing else needs to be touched.

This guide assumes you're working in the **Claude Desktop app**. You'll mostly tell Claude what to do in plain English; the exact commands are included so you can paste them if you prefer.

---

## 0) Install prerequisites (one-time)

1. **Claude Desktop app** — https://claude.ai/download
2. **Cursor or VS Code** — optional, but handy if you want to peek at files outside of Claude. Either is fine.
3. **Git** — already installed on most Macs. If not: `xcode-select --install` in Terminal.
4. **Node.js 20+** — https://nodejs.org → "LTS" download.
5. **Python 3.13** — https://www.python.org/downloads/

You only need to do this once.

---

## 1) Get the code

Pick a folder where you keep code (e.g. `~/dev`) and clone Bedrock there.

**Ask Claude:**
> Clone https://github.com/Pursuit-Assets/bedrock into ~/dev/bedrock, then open that folder.

Or, in Terminal:
```bash
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/Pursuit-Assets/bedrock.git
cd bedrock
```

---

## 2) Switch to your branch

Each of you has a branch named `home/<your-name>`:
- Allie → `home/allie`
- Andrew → `home/andrew`
- Angie → `home/angie`
- Devika → `home/devika`
- Erica → `home/erica`
- Guilherme → `home/guilherme`
- JP → `home/jp`
- Nick → `home/nick`
- Trent → `home/trent`

**Ask Claude** (replace `<your-name>`):
> Check out the `home/<your-name>` branch.

Or in Terminal:
```bash
git checkout home/<your-name>
```

---

## 3) Set up environment variables

Bedrock needs two `.env` files. Jacqueline will send you the values — paste them where you see `«ASK JAC FOR THE VALUE»`.

### 3a) Backend `.env`

Create `financial_forecasting/.env` with this content:

```
DATABASE_URL=«ASK JAC FOR THE VALUE»
JWT_SECRET_KEY=«ASK JAC FOR THE VALUE»

GOOGLE_CLIENT_ID=«ASK JAC FOR THE VALUE»
GOOGLE_CLIENT_SECRET=«ASK JAC FOR THE VALUE»
GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback

SF_INSTANCE_URL=«ASK JAC FOR THE VALUE»
SALESFORCE_USERNAME=«ASK JAC FOR THE VALUE»
SALESFORCE_PASSWORD=«ASK JAC FOR THE VALUE»
SALESFORCE_CLIENT_ID=«ASK JAC FOR THE VALUE»
SALESFORCE_CLIENT_SECRET=«ASK JAC FOR THE VALUE»
SALESFORCE_DOMAIN=«ASK JAC FOR THE VALUE»

AIRTABLE_PAT=«ASK JAC FOR THE VALUE»

OPENAI_API_KEY=«ASK JAC FOR THE VALUE»
ANTHROPIC_API_KEY=«ASK JAC FOR THE VALUE»

FRONTEND_URL=http://localhost:4200
```

### 3b) Frontend `.env.local`

Create `financial_forecasting/frontend-v2/.env.local` with:

```
VITE_API_URL=http://localhost:8000
```

**Ask Claude:**
> Create the two `.env` files at the paths above with the values I just pasted into this chat.

Then paste the values Jacqueline gave you into the chat, and Claude will put them in the right places. **Never commit these files** — they're already in `.gitignore`.

---

## 4) Install dependencies (one-time)

**Ask Claude:**
> Set up the Python venv at ~/.venvs/bedrock and install the backend deps from financial_forecasting/requirements.txt. Then install the frontend deps with npm in financial_forecasting/frontend-v2.

Or in Terminal:
```bash
# Python (backend)
python3 -m venv ~/.venvs/bedrock
source ~/.venvs/bedrock/bin/activate
pip install -r ~/dev/bedrock/financial_forecasting/requirements.txt

# Node (frontend)
cd ~/dev/bedrock/financial_forecasting/frontend-v2
npm install
```

---

## 5) Start the servers

You need both the backend (port 8000) and frontend (port 4200) running.

**Ask Claude:**
> Start the Bedrock backend and frontend in the background. Tell me when both are up.

Or in two Terminal windows:
```bash
# Window 1 — backend
cd ~/dev/bedrock/financial_forecasting
source ~/.venvs/bedrock/bin/activate
python main.py

# Window 2 — frontend
cd ~/dev/bedrock/financial_forecasting/frontend-v2
npm run dev
```

Then open http://localhost:4200/ in your browser. Sign in with your Pursuit Google account.

---

## 6) Find your page

There's exactly one file you'll be editing:

```
financial_forecasting/frontend-v2/src/pages/home/Home<Your-Name>.tsx
```

For example, Erica edits `HomeErica.tsx`. It currently just shows a "stub" placeholder — that's your starting point.

**Preview your page** at: `http://localhost:4200/home/<your-slug>` (e.g. `localhost:4200/home/erica`).

The page hot-reloads — every save shows up instantly.

---

## 7) Build your page

This part is up to you. Some ideas:
- The tasks / opportunities / awards you own this week
- Shortcuts to the views you visit most
- A personal scratchpad
- Anything from the existing pages, recomposed your way

**Ask Claude:**
> Look at the existing pages in src/pages and src/components — what's available that I could compose into my home page?

Claude can build whole sections for you. Be specific: "Add a 'My open opportunities' table that pulls from the same data as /pipeline but filters to ones I own."

---

## 8) Save and share your work

Every time you make a meaningful chunk of progress:

**Ask Claude:**
> Commit my changes with a descriptive message and push to my branch.

Or in Terminal:
```bash
git add financial_forecasting/frontend-v2/src/pages/home/Home<Your-Name>.tsx
git commit -m "feat(home/<your-name>): <what you did>"
git push
```

**Only edit your own `Home<Your-Name>.tsx` file.** If you find yourself wanting to change anything else (shared components, routes, the slugs file), ping Jacqueline first — we want zero merge conflicts when we bring everyone together.

---

## Troubleshooting

- **`localhost:4200` won't load** → backend probably isn't running. Ask Claude to check, or run `lsof -i :8000` in Terminal.
- **Login redirects to a deployed URL** → make sure `VITE_API_URL=http://localhost:8000` is in `frontend-v2/.env.local`.
- **`401` or `403` errors after login** → your `DATABASE_URL` is wrong. Re-check the value from Jacqueline.
- **Hot reload stops working** → restart the frontend (Ctrl+C in the npm run dev window, then `npm run dev` again).
- **Anything else** → ask Claude. Paste the error message.

---

## When you're done

Tell Jacqueline you're ready. She'll review your branch and bring everyone together into the shared `dev` branch with routing wired up so each of you lands on your own home automatically.
