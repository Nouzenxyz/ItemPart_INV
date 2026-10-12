# ItemPart_INV

Offline inventory system for a local office network. One computer runs the server and the database; other computers open it in a browser. No internet is needed once installed.

Built with TypeScript, Express, SQLite (single database file), and plain HTML/CSS in the browser.

## What to install

1. **Node.js LTS** (version 22 or 24) from https://nodejs.org. This is the only thing to install. It includes `npm`.
2. **Nothing else for the database.** SQLite is built into the project and stores everything in `data/inventory.db`.

Optional: **DB Browser for SQLite** if you ever want to look inside the database file.

## First run (on a computer with internet)

On Windows, double-click **Start Inventory.vbs**. The first launch installs dependencies and builds the app if needed, so it requires an internet connection and may take a few minutes. The app starts in the background and opens in your browser. When finished, double-click **Stop Inventory.vbs**. Keep the computer on and awake while people are using the app.

You can also start it manually from a terminal in the project folder:

```
npm install
npm run dev
```

Open http://localhost:3000 and log in with:

- Username: `admin`
- Password: `admin123`

**Change this password right away** (Users tab, Reset password).

## Running it for the office

```
npm run build
npm start
```

The server prints the addresses other computers can use, for example `http://192.168.1.10:3000`. When started with the background shortcut, see `.runtime/server.out.log` for those addresses.

1. Give the server computer a fixed IP address (in the router or in Windows network settings), so the link never changes.
2. Allow port 3000 through Windows Firewall on the server computer.
3. Leave the server window open while people work.

## Putting it on the offline computer

On a computer with internet, run `npm install` and `npm run build`. Then copy the whole `ItemPart_INV` folder (including `node_modules`) to the offline computer, which must have the same Node.js version and the same Windows type installed. Run `npm start` there.

## Backups

The server copies the database to `data/backups` when it starts and every 6 hours (one file per day, newest 30 kept). To save to a USB drive or second disk instead, set `BACKUP_DIR` before starting:

```
set BACKUP_DIR=E:\inventory-backups
npm start
```

To restore, stop the server and copy a backup file over `data/inventory.db`. Try a restore once before you rely on it.

## How stock is protected

- Every change is a row in `movements` (who, when, how many, balance after). Rows are never edited or deleted.
- The quantity is changed by one database statement (`quantity = quantity + n`), so two people can never overwrite each other.
- A database rule makes negative stock impossible.
- Excel imports are checked first, and saved all-or-nothing. A file with any error saves nothing.

## Roles

- **Admin:** everything, including users and locations.
- **Staff:** items, stock changes, imports.
- **Viewer:** look and export only.

## Excel

**Export stock** gives one file with PartCode, Description, Model, Location, Quantity and MinStock. The **Inventory template** has the same columns, so an exported file can be edited and imported back.

- **Inventory list import:** one row per part per location. New part codes and new locations are created automatically, and the check shows the new locations so typos are easy to spot. Quantity is what is on the shelf now: the difference from the system number is saved in History as an adjustment. Leave Location and Quantity empty to only add or update part details.
- **Stock changes import:** one row per change (`IN`, `OUT`, `RETURN`, `COUNT`), for bulk deliveries or issues that should show as real movements.

Press Check file first, then Save import. A file with any error saves nothing.

## Large lists

Stock and History show 100 rows per page, with First, Previous, Next and Last buttons and a "Showing 1 to 100 of 10,432" count. The search box and location filter search the whole inventory, not only the current page. Exports and imports always cover everything.

## Removing items

Admins see a **Remove** button on each Stock row. An item can only be removed when its stock is zero in every location. If it has history, it is hidden but its history is kept. If it never had any movement, it is deleted. Adding or importing the same part code again brings a hidden item back.

## Project layout

```
src/server/   db.ts, stock.ts (stock rules), auth.ts, excel.ts, queries.ts, backup.ts, index.ts (routes)
src/client/   app.ts (browser code, compiled to public/app.js)
public/       index.html, style.css
data/         inventory.db and backups (created on first run)
```

`npm run typecheck` checks both server and browser code for errors.
