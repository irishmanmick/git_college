# Ways to run this

Four options, cheapest first. All produce the same file.

| Option | Needs | Who it suits |
| ------ | ----- | ------------ |
| A. Single HTML file | nothing | trying it out today; one or two users |
| B. Azure Static Web Apps | an Azure subscription | a team, no server to run |
| C. Azure App Service | an Azure subscription | a team, server-side version |
| D. Local Node | Node 18+ on your machine | development |

**A and B host the same single file, which does all its work in the browser.**
The CSV is never uploaded anywhere and the Excel file is written locally, so no
bank data leaves the user's machine. That is worth saying out loud to whoever
approves this.

---

## A. The single HTML file (no install, no server)

`bank-statement-tool.html` is the whole app in one file.

1. Download it from the repository (on GitHub: open the file, then the download
   icon — use **Raw**, not "Save page as").
2. Double-click it. It opens in Edge or Chrome and works offline.

To share it, put it on a network share or OneDrive and have people open their
own copy. Nothing is installed and no admin rights are needed.

Note: it is a generated file, built from `src/` and `public/` by
`npm run build:standalone`. Edit the sources, not the HTML.

---

## B. Azure Static Web Apps (hosting option A for the team)

No server, no compute cost, free tier is enough. Because the tool is one static
file, this is the least you can deploy.

```bash
# Once, from a machine with the Azure CLI and access to the subscription:
az login
az group create --name rg-bank-statement-tool --location northeurope

mkdir -p publish && cp bank-statement-tool.html publish/index.html

az staticwebapp create \
  --name kepak-bank-statement-tool \
  --resource-group rg-bank-statement-tool \
  --location westeurope \
  --sku Free

# Deploy the folder (needs the SWA CLI: npm install -g @azure/static-web-apps-cli)
swa deploy ./publish \
  --app-name kepak-bank-statement-tool \
  --resource-group rg-bank-statement-tool \
  --env production
```

**Lock it to Kepak staff.** Add `publish/staticwebapp.config.json` before
deploying, so anonymous visitors are sent to Entra ID sign-in:

```json
{
  "routes": [{ "route": "/*", "allowedRoles": ["authenticated"] }],
  "responseOverrides": { "401": { "redirect": "/.auth/login/aad", "statusCode": 302 } }
}
```

The Free tier's built-in Entra ID provider covers any account in your tenant.
To restrict further — to the finance team only — use the Standard tier with an
app registration and a group claim, or use option C.

---

## C. Azure App Service (the Express server)

Use this if you want the server-side version — for example to add a shared
audit log of generated statements later, which the browser-only version cannot
do.

```bash
az login
az group create --name rg-bank-statement-app --location northeurope

# From the bank-statement-app directory. Builds and deploys in one step.
az webapp up \
  --name kepak-bank-statement-app \
  --resource-group rg-bank-statement-app \
  --runtime "NODE:22-lts" \
  --sku B1 \
  --location northeurope
```

App Service runs `npm start` and injects `PORT`, which `server.js` already
reads, so no config change is needed.

Then harden it — **do this before anyone uses it**, because an open instance
would let anyone on the internet see your account list:

```bash
# Require Entra ID sign-in for every request.
az webapp auth microsoft update \
  --name kepak-bank-statement-app \
  --resource-group rg-bank-statement-app \
  --tenant-id <your-tenant-id>

az webapp auth update \
  --name kepak-bank-statement-app \
  --resource-group rg-bank-statement-app \
  --enabled true \
  --action RedirectToLoginPage \
  --redirect-provider AzureActiveDirectory

# HTTPS only, and keep the app warm.
az webapp update --name kepak-bank-statement-app \
  --resource-group rg-bank-statement-app --https-only true
az webapp config set --name kepak-bank-statement-app \
  --resource-group rg-bank-statement-app --always-on true
```

Restrict to the corporate network as well, if that suits:

```bash
az webapp config access-restriction add \
  --name kepak-bank-statement-app --resource-group rg-bank-statement-app \
  --rule-name office-network --action Allow --ip-address <office-cidr> --priority 100
```

Deploying on every push is possible too — App Service can generate a GitHub
Actions workflow from the Deployment Center, which is easier than hand-writing
one because it wires up the publish credentials for you.

### What the server holds

Nothing persistent. Uploads are kept in memory, capped at 10 MB, and discarded
once the response is sent; no database, no file storage, no statement history.
A B1 plan is ample, and the app can be stopped when not in use.

---

## D. Locally with Node

```bash
cd bank-statement-app
npm install
npm start          # http://localhost:3000
```

---

## Before you deploy anywhere

- The account list in `data/bank-accounts.json` includes IBANs and account
  numbers. That is internal data, so whichever option you choose should be
  behind sign-in — options A (a file you hold) and B/C with Entra ID all are.
  A public Azure site would not be.
- Your Azure landing zone may require deployment through a specific
  subscription, naming convention or pipeline. The commands above are the
  generic form; IT will know the local rules.
